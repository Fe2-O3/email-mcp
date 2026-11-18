/**
 * IMAP service — pure business logic for email read operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import path from 'node:path';

import type { ImapFlow, ListResponse } from 'imapflow';
import { DEFAULT_SEND_LIMIT_MB, resolveSendLimitMb } from '../config/send-limit.js';
import { CALENDAR_ATTACHMENTS_DIR } from '../config/xdg.js';
import type { IConnectionManager } from '../connections/types.js';
import { assertSafeWritePath } from '../safety/local-paths.js';
import {
  sanitizeMailboxName,
  sanitizeSearchQuery,
  validateLabelName,
} from '../safety/validation.js';
import type {
  AttachmentMeta,
  BulkResult,
  Contact,
  DailyVolume,
  DryRunPlan,
  Email,
  EmailAddress,
  EmailMeta,
  EmailStats,
  LabelInfo,
  Mailbox,
  MailboxSnapshot,
  PaginatedResult,
  QuotaInfo,
  SenderStat,
} from '../types/index.js';
import {
  type AuthSignals,
  extractAuthenticationResults,
  parseAuthSignals,
  selectTrustedAuthResults,
} from '../utils/auth-results.js';
import { BULK_HEADER_FIELDS, classifyBulk, parseHeaderBlock } from '../utils/bulk-headers.js';
import { imapCommand, isConnectivityError } from '../utils/imap-error.js';
import { sanitizeInline } from '../utils/sanitize-text.js';
import { assertUid, assertUidPresent, parseUid, presentUids } from '../utils/uid.js';
import type { ReconnectEvent } from './event-bus.js';
import eventBus from './event-bus.js';
import type { LabelStrategy } from './label-strategy.js';
import { detectLabelStrategy } from './label-strategy.js';
import lockMailboxBounded from './mailbox-lock.js';
import {
  type OutgoingAttachmentInput,
  resolveOutgoingAttachments,
} from './outgoing-attachments.js';
import assertMailboxRemovable from './protected-mailboxes.js';

/**
 * IMAP APPEND requires CRLF line endings (RFC 3501 §4.3). MailComposer emits
 * bare LF for LF-only bodies, and strict servers reject the literal
 * (upstream #116). latin1 round-trips every byte, so non-ASCII content and
 * already-CRLF lines are untouched.
 */
export function toCrlf(raw: string | Buffer | Uint8Array): Buffer {
  const bytes = typeof raw === 'string' ? Buffer.from(raw, 'utf-8') : Buffer.from(raw);
  return Buffer.from(bytes.toString('latin1').replace(/\r?\n/g, '\r\n'), 'latin1');
}

// ---------------------------------------------------------------------------
// Helpers (must be defined before ImapService)
// ---------------------------------------------------------------------------

function parseAddress(addr: { name?: string; address?: string } | undefined): EmailAddress {
  // Names and addresses come from the sender: one clean line each, no control or bidi characters.
  return {
    name: addr?.name ? sanitizeInline(addr.name) : (addr?.name ?? undefined),
    address: sanitizeInline(addr?.address ?? 'unknown', 320),
  };
}

function parseAddresses(addrs: { name?: string; address?: string }[] | undefined): EmailAddress[] {
  if (!addrs) return [];
  return addrs.map(parseAddress);
}

function hasAttachments(bodyStructure: unknown): boolean {
  if (!bodyStructure || typeof bodyStructure !== 'object') return false;
  const bs = bodyStructure as Record<string, unknown>;
  if (bs.disposition === 'attachment') return true;
  if (Array.isArray(bs.childNodes)) {
    return bs.childNodes.some((child: unknown) => hasAttachments(child));
  }
  return false;
}

/**
 * Calendar parts are surfaced through the calendar tools, not as attachments.
 *
 * Match the exact media type rather than a substring: an `application/*` type
 * that merely contains the word "calendar" is an ordinary attachment and must
 * not be hidden. The filename check catches calendar parts that arrive with a
 * generic type such as `application/octet-stream`.
 */
function isCalendarPart(mimeType: string, filename: string): boolean {
  const media = mimeType.toLowerCase().split(';')[0].trim();
  return media === 'text/calendar' || filename.toLowerCase().endsWith('.ics');
}

function extractAttachments(bodyStructure: unknown): AttachmentMeta[] {
  const attachments: AttachmentMeta[] = [];
  if (!bodyStructure || typeof bodyStructure !== 'object') return attachments;

  const bs = bodyStructure as Record<string, unknown>;
  if (bs.disposition === 'attachment') {
    const params = (bs.dispositionParameters ?? bs.parameters ?? {}) as Record<string, string>;
    attachments.push({
      filename: params.filename ?? params.name ?? 'unnamed',
      // `bs.type` is already a complete Content-Type; there is no subtype
      // field to append.
      mimeType: typeof bs.type === 'string' ? bs.type.toLowerCase() : 'application/octet-stream',
      size: (bs.size as number) ?? 0,
    });
  }

  if (Array.isArray(bs.childNodes)) {
    (bs.childNodes as unknown[]).forEach((child) => {
      attachments.push(...extractAttachments(child));
    });
  }

  return attachments;
}

/** Find the MIME part number for an attachment by filename. */
function findMimePartByFilename(
  bodyStructure: unknown,
  targetFilename: string,
  partPath = '',
): string | undefined {
  if (!bodyStructure || typeof bodyStructure !== 'object') return undefined;

  const bs = bodyStructure as Record<string, unknown>;
  const currentPart = bs.part as string | undefined;
  const effectivePath = currentPart ?? partPath;

  if (bs.disposition === 'attachment') {
    const params = (bs.dispositionParameters ?? bs.parameters ?? {}) as Record<string, string>;
    const filename = params.filename ?? params.name ?? 'unnamed';
    if (filename === targetFilename) return effectivePath;
  }

  if (Array.isArray(bs.childNodes)) {
    // eslint-disable-next-line no-plusplus
    for (let i = 0; i < bs.childNodes.length; i++) {
      const childPart = effectivePath ? `${effectivePath}.${i + 1}` : String(i + 1);
      const found = findMimePartByFilename(bs.childNodes[i], targetFilename, childPart);
      if (found) return found;
    }
  }

  return undefined;
}

interface AttachmentPart {
  filename: string;
  mimeType: string;
  size: number;
  partPath?: string;
}

/** Collect every attachment part together with its MIME part path, in one walk. */
function extractAttachmentParts(bodyStructure: unknown, partPath = ''): AttachmentPart[] {
  const parts: AttachmentPart[] = [];
  if (!bodyStructure || typeof bodyStructure !== 'object') return parts;

  const bs = bodyStructure as Record<string, unknown>;
  const currentPart = bs.part as string | undefined;
  const effectivePath = currentPart ?? partPath;

  if (bs.disposition === 'attachment') {
    const params = (bs.dispositionParameters ?? bs.parameters ?? {}) as Record<string, string>;
    parts.push({
      filename: params.filename ?? params.name ?? 'unnamed',
      mimeType: typeof bs.type === 'string' ? bs.type.toLowerCase() : 'application/octet-stream',
      size: (bs.size as number) ?? 0,
      partPath: effectivePath,
    });
  }

  if (Array.isArray(bs.childNodes)) {
    // eslint-disable-next-line no-plusplus
    for (let i = 0; i < bs.childNodes.length; i++) {
      const childPart = effectivePath ? `${effectivePath}.${i + 1}` : String(i + 1);
      parts.push(...extractAttachmentParts(bs.childNodes[i], childPart));
    }
  }

  return parts;
}

/** What a message's date reads as when its Date header is not a real date. */
export const DATE_UNKNOWN = 'date unknown';

/**
 * A message date as a Date, or undefined when it is not a real date. ImapFlow
 * keeps an unreadable Date header ("sometime soon") as the raw string, and
 * `new Date(text).toISOString()` then throws, which used to fail a whole page
 * of results and stall the new-mail watcher on one spam message.
 */
export function safeDate(value: unknown): Date | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  const date = value instanceof Date ? value : new Date(value as string);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

/** `safeDate` as ISO text. */
export function safeIsoDate(value: unknown): string | undefined {
  return safeDate(value)?.toISOString();
}

/**
 * Map a raw ImapFlow fetch result to `EmailMeta`.
 *
 * Exported so the IDLE watcher shares one definition — a second, slightly
 * different implementation there previously produced inconsistent records for
 * the same message.
 */
export function messageToEmailMeta(msg: Record<string, unknown>): EmailMeta {
  const envelope = (msg.envelope ?? {}) as Record<string, unknown>;
  const flags = new Set((msg.flags ?? []) as string[]);

  // Extract non-system flags as labels (IMAP keywords)
  const labels = [...flags].filter((f) => !f.startsWith('\\'));

  // BODY.PEEK[HEADER.FIELDS (...)] comes back as a raw buffer.
  const bulk =
    msg.headers && Buffer.isBuffer(msg.headers)
      ? classifyBulk(parseHeaderBlock(msg.headers.toString('utf-8')))
      : undefined;

  // Every fetch in this service passes `{ uid: true }`, so a missing UID means
  // the server broke protocol. Falling back to `msg.seq` would mint an id that
  // looks like a UID but addresses a different message on every subsequent
  // write — fail loudly instead.
  if (typeof msg.uid !== 'number') {
    throw new Error(
      `IMAP server returned a message without a UID (seq ${String(msg.seq ?? 'unknown')})`,
    );
  }

  const sanitizeUntrusted = (s: string): string => sanitizeInline(s);
  return {
    id: String(msg.uid),
    messageId: (envelope.messageId as string) ?? '',
    subject: sanitizeUntrusted((envelope.subject as string) ?? '(no subject)'),
    from: (() => {
      const addr = parseAddress((envelope.from as Record<string, string>[])?.[0]);
      return { ...addr, name: addr.name ? sanitizeUntrusted(addr.name) : addr.name };
    })(),
    to: parseAddresses(envelope.to as Record<string, string>[]),
    // A header that is not a real date falls back to the server's arrival
    // time when it was fetched, else reads "date unknown"; never a throw.
    date:
      safeIsoDate(envelope.date) ??
      safeIsoDate(msg.internalDate) ??
      (envelope.date ? DATE_UNKNOWN : new Date().toISOString()),
    seen: flags.has('\\Seen'),
    flagged: flags.has('\\Flagged'),
    answered: flags.has('\\Answered'),
    hasAttachments: hasAttachments(msg.bodyStructure),
    labels,
    bulk,
  };
}

/**
 * `messageToEmailMeta` for a page of results: one message that cannot be
 * mapped becomes a placeholder row with its UID, never a failed page. A
 * message with no UID still fails, since no row could address it.
 */
export function metaOrPlaceholder(msg: Record<string, unknown>): EmailMeta {
  try {
    return messageToEmailMeta(msg);
  } catch (err) {
    if (typeof msg.uid !== 'number') throw err;
    return {
      id: String(msg.uid),
      messageId: '',
      subject: '(this message could not be read)',
      from: { address: 'unknown' },
      to: [],
      date: DATE_UNKNOWN,
      seen: false,
      flagged: false,
      answered: false,
      hasAttachments: false,
      labels: [],
    };
  }
}

/** A displayable (non-attachment) text part discovered in the MIME tree. */
interface TextPart {
  /** IMAP part path, e.g. "1.1" */
  path: string;
  /** Content subtype: "plain" | "html" | … (derived from the full MIME type) */
  subtype: string;
  size: number;
}

/**
 * Split an ImapFlow structure node's Content-Type.
 *
 * ImapFlow reports `type` as the complete Content-Type ("text/html") and has
 * no `subtype` field at all — see MessageStructureObject in imap-flow.d.ts.
 */
function splitMimeType(type: unknown): { type: string; subtype: string } {
  const full = typeof type === 'string' ? type.toLowerCase() : '';
  const slash = full.indexOf('/');
  if (slash < 0) return { type: full, subtype: '' };
  return { type: full.slice(0, slash), subtype: full.slice(slash + 1) };
}

/**
 * Collect every non-attachment text/* part in the MIME tree, in document order.
 *
 * Mirrors the traversal in `findMimePartByFilename` — part paths come from
 * `bs.part` when the server supplies one, otherwise from the 1-based child
 * index chain.
 */
function collectTextParts(bodyStructure: unknown, partPath = ''): TextPart[] {
  if (!bodyStructure || typeof bodyStructure !== 'object') return [];

  const bs = bodyStructure as Record<string, unknown>;
  const effectivePath = (bs.part as string | undefined) ?? partPath;
  const found: TextPart[] = [];

  if (Array.isArray(bs.childNodes)) {
    bs.childNodes.forEach((child, i) => {
      const childPath = effectivePath ? `${effectivePath}.${i + 1}` : String(i + 1);
      found.push(...collectTextParts(child, childPath));
    });
    return found;
  }

  // Leaf node. Attachments are never body content, even when text/*.
  const { type, subtype } = splitMimeType(bs.type);
  if (type === 'text' && bs.disposition !== 'attachment') {
    found.push({
      // A single-part message has no `part` field at all — the body is
      // addressable as part "1", which is what the vast majority of real mail
      // looks like. Without this the caller falls back to raw `source`, which
      // is still transfer-encoded.
      path: effectivePath || '1',
      subtype,
      size: typeof bs.size === 'number' ? bs.size : 0,
    });
  }

  return found;
}

/**
 * Choose which text part to download for an email's body, or `undefined` to
 * skip the extra round trip and use the body already parsed from `source`.
 *
 * `parts` is in document order and excludes attachments.
 *
 * Prefers `text/plain`: it is far cheaper in agent context-window terms, which
 * `docs/performance-roadmap.md` identifies as the real constraint.
 *
 * The exception is the stub plain part — a few dozen bytes of "This message
 * requires an HTML-capable reader" shipped next to the real content in HTML.
 * Taking it literally makes the model report the placeholder as the email, so
 * an implausibly small plain part loses to a much larger HTML sibling.
 */
const STUB_PLAIN_MAX_BYTES = 200;
const STUB_PLAIN_RATIO = 5;

function selectBodyPart(parts: TextPart[]): TextPart | undefined {
  const plain = parts.find((p) => p.subtype === 'plain');
  const html = parts.find((p) => p.subtype === 'html');

  if (!plain) return html ?? parts[0];
  if (html && plain.size < STUB_PLAIN_MAX_BYTES && html.size > plain.size * STUB_PLAIN_RATIO) {
    return html;
  }
  return plain;
}

/** Bump when body extraction or decoding changes, so cached bodies from the old logic miss. */
export const BODY_EXTRACTOR_VERSION = 1;

/** Bodies larger than this are never cached: truncating would diverge from the live answer. */
export const MAX_CACHED_BODY_BYTES = 256 * 1024;

/**
 * Everything `getEmail`'s output derives from except flags. Immutable per
 * (UIDVALIDITY, UID), which is what makes it safe to cache without a
 * freshness model.
 */
export interface BodyBundle {
  /** As ImapFlow returned it. */
  envelope: unknown;
  bodyStructure: unknown;
  /** `msg.headers.toString('utf-8')`, exactly as the live path decodes it. */
  headersRaw: string;
  bodyText?: string;
  bodyHtml?: string;
  /** False when a part selected for download did not arrive. Never cache an incomplete bundle. */
  complete: boolean;
}

/**
 * The I/O half of building an `Email`: choose the text parts and download them.
 * Everything else is derived by the pure `assembleEmail`.
 */
export async function fetchBodyBundle(
  msg: Record<string, unknown>,
  client: ImapFlow,
  uid: number,
): Promise<BodyBundle> {
  let bodyText: string | undefined;
  let bodyHtml: string | undefined;
  let complete = true;

  // Always download body parts; never read them out of `source`. Raw source
  // is transfer-encoded (quoted-printable, base64) with soft line breaks, so
  // using it directly yields "=3D" for '=' and words split mid-token.
  // download() applies the decoding declared by Content-Transfer-Encoding.
  //
  // Both halves of a multipart/alternative are fetched when present. Keeping
  // only one loses information the other carries: the plain part may be a
  // stub, the html part may be unreadable markup, and downstream consumers
  // cannot choose between them if they never see both.
  const textParts = collectTextParts(msg.bodyStructure);
  const plainPart = textParts.find((p) => p.subtype === 'plain');
  const htmlPart = textParts.find((p) => p.subtype === 'html');
  const chosen = selectBodyPart(textParts);

  const downloadPart = async (target: TextPart): Promise<string | undefined> => {
    try {
      const part = await client.download(String(uid), target.path, { uid: true });
      if (!part?.content) return undefined;
      const chunks: Buffer[] = [];
      // eslint-disable-next-line no-restricted-syntax
      for await (const chunk of part.content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      return Buffer.concat(chunks).toString('utf-8');
    } catch {
      // Part may not exist on this server — better an empty body than a throw.
      return undefined;
    }
  };

  // The selected part is fetched first so single-part messages keep exactly
  // one round trip; its subtype decides which slot receives the bytes. When an
  // alternative sibling exists, fetch it too.
  if (chosen) {
    const decoded = await downloadPart(chosen);
    if (decoded !== undefined) {
      if (chosen.subtype === 'html') bodyHtml = decoded;
      else bodyText = decoded;
    } else {
      complete = false;
    }
  }
  const sibling = chosen === htmlPart ? plainPart : htmlPart;
  if (sibling && sibling !== chosen) {
    const decoded = await downloadPart(sibling);
    if (decoded !== undefined) {
      if (sibling.subtype === 'html') bodyHtml = decoded;
      else bodyText = decoded;
    } else {
      complete = false;
    }
  }

  return {
    envelope: msg.envelope,
    bodyStructure: msg.bodyStructure,
    // Headers come from a HEADER fetch. `source` would work too, but it pulls
    // the entire message — base64 attachments and all — to read a few hundred
    // bytes of header.
    headersRaw: Buffer.isBuffer(msg.headers) ? msg.headers.toString('utf-8') : '',
    bodyText,
    bodyHtml,
    complete,
  };
}

/**
 * The pure half: build an `Email` from a bundle plus current flags. Both the
 * live path and the cache-hit path call this, so they agree by construction.
 */
export function assembleEmail(bundle: BodyBundle, flags: Iterable<string>, uid: number): Email {
  const msg: Record<string, unknown> = {
    uid,
    envelope: bundle.envelope,
    flags: new Set(flags),
    headers: Buffer.from(bundle.headersRaw, 'utf-8'),
    bodyStructure: bundle.bodyStructure,
  };
  const meta = messageToEmailMeta(msg);
  const envelope = (bundle.envelope ?? {}) as Record<string, unknown>;

  // parseHeaderBlock unfolds RFC 5322 continuation lines; naive line
  // splitting truncates folded fields such as List-Unsubscribe.
  const headers = parseHeaderBlock(bundle.headersRaw);

  const replyToParsed = parseAddresses(
    (envelope.replyTo as Record<string, string>[] | undefined) ??
      (envelope['reply-to'] as Record<string, string>[] | undefined),
  )[0];

  return {
    ...meta,
    cc: parseAddresses(envelope.cc as Record<string, string>[]),
    bcc: parseAddresses(envelope.bcc as Record<string, string>[]),
    replyTo: replyToParsed,
    bodyText: bundle.bodyText,
    bodyHtml: bundle.bodyHtml,
    messageId: (envelope.messageId as string) ?? '',
    inReplyTo: (envelope.inReplyTo as string) ?? undefined,
    references: headers.references?.split(/\s+/).filter(Boolean),
    attachments: extractAttachments(bundle.bodyStructure),
    headers,
    // Recomputed from the full header set rather than reusing meta.bulk, which
    // a full fetch leaves unset — the targeted HEADER.FIELDS fetch only happens
    // on listings.
    bulk: classifyBulk(headers),
  };
}

async function messageToEmail(
  msg: Record<string, unknown>,
  client: ImapFlow,
  uid: number,
): Promise<Email> {
  const bundle = await fetchBodyBundle(msg, client, uid);
  return assembleEmail(bundle, (msg.flags ?? []) as Iterable<string>, uid);
}

/**
 * Narrow port to the local body cache, so ImapService does not depend on
 * SQLite and an absent cache leaves today's code path untouched. Every
 * implementation must swallow its own errors: the cache never turns a working
 * read into a failure.
 */
export interface BodyCachePort {
  /** Current-extractor, status ok only. Touches accessed_at. */
  get(account: string, mailbox: string, uid: number, uidValidity: string): BodyBundle | undefined;
  /** Decides ok vs skipped (oversize or incomplete). */
  put(account: string, mailbox: string, uid: number, uidValidity: string, bundle: BodyBundle): void;
  forget(account: string, mailbox: string, uids: number[]): void;
  /** Offline lookup when the server cannot be reached; picks the generation itself. */
  getOffline(
    account: string,
    mailbox: string,
    uid: number,
  ): { bundle: BodyBundle; flags: string[]; cachedAt: number } | undefined;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export default class ImapService {
  private labelStrategies = new Map<string, { strategy: LabelStrategy; ts: number }>();

  private labelStrategyPending = new Map<string, Promise<LabelStrategy>>();

  /** Label strategies are evicted after 5 minutes to prevent stale cache growth. */
  private static readonly LABEL_STRATEGY_TTL_MS = 5 * 60 * 1000;

  private readonly onReconnect: (event: ReconnectEvent) => void;

  /** Absent unless `cache.read_through` is on; absent means today's behavior exactly. */
  private bodyCache?: BodyCachePort;

  private offlineReads = false;

  constructor(private connections: IConnectionManager) {
    // The label strategy is probed from server capabilities and folder layout,
    // so it is only valid for the connection that produced it. A reconnect may
    // reach a different server for the same account — drop the memo and
    // re-detect on next use.
    this.onReconnect = ({ account }) => {
      this.labelStrategies.delete(account);
      this.labelStrategyPending.delete(account);
    };
    eventBus.on('imap:reconnect', this.onReconnect);
  }

  /** Route `getEmail` through the local body cache. */
  attachBodyCache(port: BodyCachePort, options: { offlineReads: boolean }): void {
    this.bodyCache = port;
    this.offlineReads = options.offlineReads;
  }

  /**
   * Answer from the cache when, and only when, the server was unreachable.
   *
   * Anything else (bad credentials, a missing message, a permission error) is
   * an answer from a reachable server and is rethrown by the caller.
   */
  private readOffline(
    err: unknown,
    account: string,
    mailbox: string,
    uid: number,
  ): Email | undefined {
    if (!this.bodyCache || !this.offlineReads || !isConnectivityError(err)) return undefined;
    try {
      const hit = this.bodyCache.getOffline(account, sanitizeMailboxName(mailbox), uid);
      if (!hit) return undefined;
      return {
        ...assembleEmail(hit.bundle, hit.flags, uid),
        offline: { cachedAt: new Date(hit.cachedAt).toISOString() },
      };
    } catch {
      return undefined;
    }
  }

  /** Free cached bodies of messages that just left a mailbox. Hygiene only: correctness never depends on it. */
  private forgetBodies(account: string, mailbox: string, uids: number[]): void {
    if (!this.bodyCache) return;
    try {
      this.bodyCache.forget(account, sanitizeMailboxName(mailbox), uids);
    } catch {
      // Cache hygiene must not fail a move or delete that already succeeded.
    }
  }

  /**
   * Detach from the event bus.
   *
   * The server holds a single long-lived instance, so this matters mainly for
   * tests and for any future code that builds a service graph per request —
   * without it each instance leaks a listener on the shared bus.
   */
  dispose(): void {
    eventBus.off('imap:reconnect', this.onReconnect);
  }

  /**
   * Fetch a whole-match UID set in bounded chunks, streamed as one sequence.
   *
   * Hostinger rejects a UID FETCH whose argument token is too long: joining
   * every UID of a 25k-message mailbox makes a ~142 KB command, the server
   * answers `BAD: Too long argument`, and the caller sees the useless
   * "Command failed" instead of results. Chunking keeps each command far
   * below any plausible line limit while callers consume a flat stream, so
   * single-fetch call semantics (for-await over messages) stay unchanged.
   */
  private static async *fetchUidChunks(
    client: ImapFlow,
    uids: number[],
    query: Parameters<ImapFlow['fetch']>[1],
    options: Parameters<ImapFlow['fetch']>[2],
  ): AsyncGenerator<unknown> {
    // ~400 five-digit UIDs plus commas ≈ 2.4 KB per command — orders of
    // magnitude under the observed 142 KB failure, and large enough that a
    // 65k-message date sort stays ~160 round trips.
    const CHUNK = 400;
    for (let i = 0; i < uids.length; i += CHUNK) {
      const range = uids.slice(i, i + CHUNK).join(',');
      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(range, query, options)) {
        yield msg;
      }
    }
  }

  /**
   * Lock a caller-supplied mailbox path.
   *
   * Trims and rejects the IMAP wildcards `*` and `%` first. Prefer this over
   * `getMailboxLock()` for any path that originated outside this
   * process — it keeps validation from drifting method by method, and
   * normalizes the path so " INBOX " and "INBOX" address one mailbox.
   *
   * Paths returned by `client.list()` are server-supplied and already valid;
   * those may be locked directly.
   */
  private static lockMailbox(client: ImapFlow, mailbox: string) {
    const path = sanitizeMailboxName(mailbox);
    // Every read and write opens a mailbox first, so this is the most common
    // place a server refusal surfaces — and the least useful one to report as
    // a bare "Command failed".
    return imapCommand(`Opening mailbox "${path}"`, () => lockMailboxBounded(client, path));
  }

  private async getLabelStrategy(accountName: string): Promise<LabelStrategy> {
    const cached = this.labelStrategies.get(accountName);
    if (cached && Date.now() - cached.ts < ImapService.LABEL_STRATEGY_TTL_MS) {
      return cached.strategy;
    }
    if (cached) this.labelStrategies.delete(accountName);

    // Deduplicate concurrent detection for the same account. A failed attempt
    // must not stay cached: the entry is cleared when detection settles with a
    // rejection, so the next caller retries instead of awaiting a promise that
    // can never succeed.
    const pending = this.labelStrategyPending.get(accountName);
    if (pending) return pending;

    const promise = (async () => {
      try {
        const client = await this.connections.getImapClient(accountName);
        const strategy = await detectLabelStrategy(client);
        this.labelStrategies.set(accountName, { strategy, ts: Date.now() });
        return strategy;
      } finally {
        // Clear on settle, success or failure: a rejected detection must not
        // stay cached, or every later caller awaits a promise that can never
        // succeed and the account's labels are wedged until a reconnect.
        this.labelStrategyPending.delete(accountName);
      }
    })();

    this.labelStrategyPending.set(accountName, promise);
    return promise;
  }

  // -------------------------------------------------------------------------
  // Mailboxes
  // -------------------------------------------------------------------------

  async listMailboxes(accountName: string): Promise<Mailbox[]> {
    const client = await this.connections.getImapClient(accountName);
    const mailboxes = await client.list();

    const statusResults = await Promise.allSettled(
      mailboxes.map(async (mb) => {
        const status = await client.status(mb.path, {
          messages: true,
          unseen: true,
        });
        return {
          name: mb.name,
          path: mb.path,
          specialUse: mb.specialUse ?? undefined,
          // imapflow 2 returns false when the folder can't answer STATUS —
          // report undefined counts, not a crash (Mailbox documents this).
          totalMessages: status === false ? undefined : status.messages,
          unseenMessages: status === false ? undefined : status.unseen,
        };
      }),
    );

    return statusResults.map((result, idx) => {
      if (result.status === 'fulfilled') {
        return result.value;
      }
      // STATUS failed — either the folder doesn't support it (e.g. \Noselect) or
      // the connection is degraded. Leave the counts undefined rather than
      // reporting 0: a caller (or the cache) must not mistake this for an empty
      // mailbox.
      const mb = mailboxes[idx];
      return {
        name: mb.name,
        path: mb.path,
        specialUse: mb.specialUse ?? undefined,
        totalMessages: undefined,
        unseenMessages: undefined,
      };
    });
  }

  // -------------------------------------------------------------------------
  // List emails
  // -------------------------------------------------------------------------

  async listEmails(
    accountName: string,
    options: {
      mailbox?: string;
      page?: number;
      pageSize?: number;
      since?: string;
      before?: string;
      from?: string;
      subject?: string;
      seen?: boolean;
      flagged?: boolean;
      hasAttachment?: boolean;
      answered?: boolean;
      /** 'date' (default) orders the whole match set before paging; 'uid' keeps raw UID order. */
      sort?: 'date' | 'uid';
    } = {},
  ): Promise<PaginatedResult<EmailMeta>> {
    const client = await this.connections.getImapClient(accountName);
    const mailbox = sanitizeMailboxName(options.mailbox ?? 'INBOX');
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;

    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      // Build search criteria
      const search: Record<string, unknown> = {};
      if (options.since) search.since = new Date(options.since);
      if (options.before) search.before = new Date(options.before);
      if (options.from) search.from = options.from;
      if (options.subject) search.subject = options.subject;
      if (options.seen !== undefined) search.seen = options.seen;
      if (options.flagged !== undefined) search.flagged = options.flagged;
      if (options.answered !== undefined) search.answered = options.answered;

      // Search for matching UIDs
      const searchResult = await client.search(search, { uid: true });
      // A server whose SEARCH is broken may answer with something other than
      // a UID array. Treating that as 'no matches' hides real mail behind a
      // confident-looking empty result; failing loudly names the problem.
      if (!Array.isArray(searchResult)) {
        throw new Error(
          `Mailbox search returned an unusable response from the server; its SEARCH implementation appears broken.`,
        );
      }
      let uids: number[] = searchResult;

      // Post-filter for hasAttachment (IMAP has no native attachment search)
      if (options.hasAttachment !== undefined && uids.length > 0) {
        const filteredUids: number[] = [];
        // eslint-disable-next-line no-restricted-syntax
        for await (const msg of ImapService.fetchUidChunks(
          client,
          uids,
          { uid: true, bodyStructure: true },
          { uid: true },
        )) {
          const raw = msg as unknown as Record<string, unknown>;
          if (options.hasAttachment === hasAttachments(raw.bodyStructure)) {
            filteredUids.push(raw.uid as number);
          }
        }
        uids = filteredUids;
      }

      if (uids.length === 0) {
        return {
          items: [],
          total: 0,
          page,
          pageSize,
          hasMore: false,
        };
      }

      // Order the WHOLE match set before slicing a page. Slicing by UID first
      // and date-sorting afterwards yields a per-page sort that looks right
      // and is not: a migrated message with a low UID and a recent date lands
      // on the wrong page and never surfaces. Date order therefore needs every
      // message's date before the page is cut, so fetch the cheap pair for the
      // full range; UID order keeps its original cheap path.
      const sort = options.sort ?? 'date';
      if (sort === 'date') {
        const uidDates = new Map<number, number>();
        // eslint-disable-next-line no-restricted-syntax
        for await (const msg of ImapService.fetchUidChunks(
          client,
          uids,
          { uid: true, internalDate: true },
          { uid: true },
        )) {
          const raw = msg as unknown as { uid?: number; internalDate?: Date };
          if (typeof raw.uid === 'number') {
            uidDates.set(raw.uid, raw.internalDate ? raw.internalDate.getTime() : 0);
          }
        }
        // Newest first; ties broken by UID so the order is stable.
        uids.sort((a, b) => {
          const da = uidDates.get(a) ?? 0;
          const db = uidDates.get(b) ?? 0;
          if (da !== db) return db - da;
          return b - a;
        });
      } else {
        // Raw UID order, server-native ascending.
        uids.sort((a, b) => a - b);
      }

      const total = uids.length;
      const start = (page - 1) * pageSize;
      const pageUids = uids.slice(start, start + pageSize);

      if (pageUids.length === 0) {
        return {
          items: [],
          total,
          page,
          pageSize,
          hasMore: false,
        };
      }

      const items: EmailMeta[] = [];
      const range = pageUids.join(',');

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          headers: BULK_HEADER_FIELDS,
        },
        { uid: true },
      )) {
        items.push(metaOrPlaceholder(msg as unknown as Record<string, unknown>));
      }

      // Servers answer a UID range in ascending order regardless of the
      // ordering this page was cut with, so re-apply the page's own order to
      // the hydrated rows. This is safe precisely because the page cut already
      // happened on the full, globally ordered set: sorting two rows is not
      // the per-page-sort bug that motivated the change above.
      if (sort === 'date') {
        items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      }
      return {
        items,
        total,
        page,
        pageSize,
        hasMore: start + pageSize < total,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Get single email
  // -------------------------------------------------------------------------

  async getEmail(accountName: string, emailId: string, mailbox = 'INBOX'): Promise<Email> {
    const uid = parseUid(emailId);
    // Sanitized before connecting so the offline fallback looks rows up under
    // the same key that write-back and backfill stored them with.
    const safeMailbox = sanitizeMailboxName(mailbox);

    let client: ImapFlow;
    try {
      client = await this.connections.getImapClient(accountName);
    } catch (err) {
      const offline = this.readOffline(err, accountName, safeMailbox, uid);
      if (offline) return offline;
      throw err;
    }

    let lock: Awaited<ReturnType<ImapFlow['getMailboxLock']>>;
    try {
      lock = await lockMailboxBounded(client, safeMailbox);
    } catch (err) {
      const offline = this.readOffline(err, accountName, safeMailbox, uid);
      if (offline) return offline;
      throw err;
    }
    try {
      // A message's body, headers and structure never change for a given
      // (UIDVALIDITY, UID), so a hit needs no freshness model: the FLAGS fetch
      // below is what proves the message still exists and supplies live flags.
      const selected = client.mailbox;
      const uidValidity = this.bodyCache && selected ? selected.uidValidity?.toString() : undefined;
      if (this.bodyCache && uidValidity) {
        const cached = this.bodyCache.get(accountName, safeMailbox, uid, uidValidity);
        if (cached) {
          const current = await client.fetchOne(
            String(uid),
            { uid: true, flags: true },
            { uid: true },
          );
          if (!current) {
            throw new Error(`Email ${emailId} not found in ${mailbox}`);
          }
          return assembleEmail(cached, (current.flags ?? []) as Iterable<string>, uid);
        }
      }

      const msg = await client.fetchOne(
        String(uid),
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          // Headers only. `source: true` would transfer the whole message,
          // attachments included, to read a few hundred bytes of header —
          // the body arrives separately as a decoded MIME part.
          headers: true,
        },
        { uid: true },
      );

      if (!msg) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }

      const raw = msg as unknown as Record<string, unknown>;
      const bundle = await fetchBodyBundle(raw, client, uid);
      const email = assembleEmail(bundle, (raw.flags ?? []) as Iterable<string>, uid);
      // Written only after the answer is built, so a failure can never leave a
      // cache row behind for a read that did not succeed.
      if (this.bodyCache && uidValidity) {
        this.bodyCache.put(accountName, safeMailbox, uid, uidValidity, bundle);
      }
      return email;
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Get email flags (lightweight — no body fetch, no \Seen change)
  // -------------------------------------------------------------------------

  async getEmailFlags(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
  ): Promise<{
    seen: boolean;
    flagged: boolean;
    answered: boolean;
    labels: string[];
    subject: string;
    from: string;
    date: string;
  }> {
    const uid = parseUid(emailId);
    const client = await this.connections.getImapClient(accountName);

    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, flags: true },
        { uid: true },
      );

      if (!msg) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }

      const raw = msg as unknown as Record<string, unknown>;
      const flags = new Set((raw.flags ?? []) as string[]);
      const labels = [...flags].filter((f) => !f.startsWith('\\'));
      const envelope = (raw.envelope ?? {}) as Record<string, unknown>;
      const fromEntry = (envelope.from as Record<string, string>[] | undefined)?.[0];
      let from = '';
      if (fromEntry) {
        from = fromEntry.name
          ? `${sanitizeInline(fromEntry.name)} <${sanitizeInline(fromEntry.address ?? '')}>`
          : sanitizeInline(fromEntry.address ?? '');
      }

      return {
        seen: flags.has('\\Seen'),
        flagged: flags.has('\\Flagged'),
        answered: flags.has('\\Answered'),
        labels,
        subject: sanitizeInline((envelope.subject as string) ?? '(no subject)'),
        from,
        date: safeIsoDate(envelope.date) ?? (envelope.date ? DATE_UNKNOWN : ''),
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Search emails
  // -------------------------------------------------------------------------

  async searchEmails(
    accountName: string,
    query: string,
    options: {
      mailbox?: string;
      page?: number;
      pageSize?: number;
      to?: string;
      hasAttachment?: boolean;
      largerThan?: number;
      smallerThan?: number;
      answered?: boolean;
      /** 'date' (default) orders the whole match set before paging; 'uid' keeps raw UID order. */
      sort?: 'date' | 'uid';
    } = {},
  ): Promise<PaginatedResult<EmailMeta>> {
    const client = await this.connections.getImapClient(accountName);
    const mailbox = sanitizeMailboxName(options.mailbox ?? 'INBOX');
    const page = options.page ?? 1;
    const pageSize = options.pageSize ?? 20;
    const sanitizedQuery = query ? sanitizeSearchQuery(query) : '';

    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      // Build search criteria — base query OR across subject/from/body
      const baseCriteria: Record<string, unknown> = sanitizedQuery
        ? { or: [{ subject: sanitizedQuery }, { from: sanitizedQuery }, { body: sanitizedQuery }] }
        : {};

      // Build additional filters as AND conditions
      const andConditions: Record<string, unknown>[] = [baseCriteria];

      if (options.to) {
        andConditions.push({ to: options.to });
      }
      if (options.largerThan !== undefined) {
        andConditions.push({ larger: options.largerThan * 1024 });
      }
      if (options.smallerThan !== undefined) {
        andConditions.push({ smaller: options.smallerThan * 1024 });
      }
      if (options.answered === true) {
        andConditions.push({ answered: true });
      } else if (options.answered === false) {
        andConditions.push({ answered: false });
      }

      // Use the combined criteria or just the base
      const searchCriteria =
        andConditions.length === 1 ? baseCriteria : Object.assign({}, ...andConditions);

      const searchResult = await client.search(searchCriteria, { uid: true });
      // Loud failure over silent zero - see list_emails above.
      if (!Array.isArray(searchResult)) {
        throw new Error(
          `Mailbox search returned an unusable response from the server; its SEARCH implementation appears broken.`,
        );
      }
      let uids: number[] = searchResult;

      // Post-filter for has_attachment if requested (IMAP doesn't have native support)
      if (options.hasAttachment !== undefined && uids.length > 0) {
        const filteredUids: number[] = [];

        // eslint-disable-next-line no-restricted-syntax
        for await (const msg of ImapService.fetchUidChunks(
          client,
          uids,
          { uid: true, bodyStructure: true },
          { uid: true },
        )) {
          const raw = msg as unknown as Record<string, unknown>;
          const msgHasAtt = hasAttachments(raw.bodyStructure);
          if (options.hasAttachment === msgHasAtt) {
            filteredUids.push(raw.uid as number);
          }
        }

        uids = filteredUids;
      }

      if (uids.length === 0) {
        return {
          items: [],
          total: 0,
          page,
          pageSize,
          hasMore: false,
        };
      }

      // Same ordering rule as list_emails: order the WHOLE match set before
      // slicing, or pages restart the sort and migrated mail never surfaces.
      if ((options.sort ?? 'date') === 'date') {
        const uidDates = new Map<number, number>();
        // eslint-disable-next-line no-restricted-syntax
        for await (const msg of ImapService.fetchUidChunks(
          client,
          uids,
          { uid: true, internalDate: true },
          { uid: true },
        )) {
          const raw = msg as unknown as { uid?: number; internalDate?: Date };
          if (typeof raw.uid === 'number') {
            uidDates.set(raw.uid, raw.internalDate ? raw.internalDate.getTime() : 0);
          }
        }
        uids.sort((a, b) => {
          const da = uidDates.get(a) ?? 0;
          const db = uidDates.get(b) ?? 0;
          if (da !== db) return db - da;
          return b - a;
        });
      } else {
        // Raw UID order, server-native ascending.
        uids.sort((a, b) => a - b);
      }
      const total = uids.length;
      const start = (page - 1) * pageSize;
      const pageUids = uids.slice(start, start + pageSize);

      if (pageUids.length === 0) {
        return {
          items: [],
          total,
          page,
          pageSize,
          hasMore: false,
        };
      }

      const items: EmailMeta[] = [];
      const range = pageUids.join(',');

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          headers: BULK_HEADER_FIELDS,
        },
        { uid: true },
      )) {
        items.push(metaOrPlaceholder(msg as unknown as Record<string, unknown>));
      }

      // Same in-page re-application as list_emails: the range comes back
      // ascending, so restore this page's own order after hydration.
      if ((options.sort ?? 'date') === 'date') {
        items.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
      }
      return {
        items,
        total,
        page,
        pageSize,
        hasMore: start + pageSize < total,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Labels
  // -------------------------------------------------------------------------

  async listLabels(accountName: string): Promise<LabelInfo[]> {
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    return strategy.listLabels(client);
  }

  async addLabel(
    accountName: string,
    emailId: string,
    mailbox: string,
    label: string,
  ): Promise<void> {
    const uid = parseUid(emailId);
    const cleanLabel = validateLabelName(label);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.addLabel(client, String(uid), safeMailbox, cleanLabel);
  }

  async removeLabel(
    accountName: string,
    emailId: string,
    mailbox: string,
    label: string,
  ): Promise<void> {
    const uid = parseUid(emailId);
    const cleanLabel = validateLabelName(label);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.removeLabel(client, String(uid), safeMailbox, cleanLabel);
  }

  async createLabel(accountName: string, name: string): Promise<void> {
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.createLabel(client, name);
  }

  async deleteLabel(accountName: string, name: string): Promise<void> {
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    await strategy.deleteLabel(client, name);
  }

  // -------------------------------------------------------------------------
  // Virtual-folder detection
  // -------------------------------------------------------------------------

  private static readonly VIRTUAL_SPECIAL_USE = new Set(['\\All', '\\Flagged', '\\Important']);

  /**
   * The listed mailbox a write names, resolved the way the server resolves it:
   * exactly, INBOX in any case, with the personal namespace prefix added, or
   * (when only one folder matches) in another case. An exact-only match let a
   * differently spelled virtual folder skip the check below.
   */
  private static resolveListed(
    mailboxes: ListResponse[],
    requested: string,
    prefix: string | undefined,
  ): ListResponse | undefined {
    const exact =
      mailboxes.find((m) => m.path === requested) ??
      (requested.toUpperCase() === 'INBOX'
        ? mailboxes.find((m) => m.path.toUpperCase() === 'INBOX')
        : undefined) ??
      (prefix ? mailboxes.find((m) => m.path === `${prefix}${requested}`) : undefined);
    if (exact) return exact;
    const lower = requested.toLowerCase();
    const prefixed = prefix ? `${prefix}${requested}`.toLowerCase() : undefined;
    const loose = mailboxes.filter(
      (m) => m.path.toLowerCase() === lower || m.path.toLowerCase() === prefixed,
    );
    return loose.length === 1 ? loose[0] : undefined;
  }

  private static async assertRealMailbox(client: ImapFlow, mailboxPath: string): Promise<void> {
    const mailboxes = await client.list();
    const mb = ImapService.resolveListed(mailboxes, mailboxPath, client.namespace?.prefix);
    if (!mb) return; // unknown — let the server reject if invalid
    const virtualFlag = [...ImapService.VIRTUAL_SPECIAL_USE].find(
      (f) => mb.specialUse === f || mb.flags?.has(f),
    );
    if (virtualFlag) {
      throw new Error(
        `"${mailboxPath}" is a virtual folder (${virtualFlag}). ` +
          'Use find_email_folder to locate the real folder first.',
      );
    }
  }

  // -------------------------------------------------------------------------
  // Find real folder for an email
  // -------------------------------------------------------------------------

  /** Folders a message is most likely to be in, in the order worth searching. */
  private static readonly LIKELY_SPECIAL_USE = ['\\Sent', '\\Drafts', '\\Archive'];

  /**
   * Order mailboxes so the first match is the one a caller would want to act
   * on, since the search stops there.
   */
  private static orderByLikelihood<T extends { path: string; specialUse?: string }>(
    mailboxes: T[],
  ): T[] {
    const rank = (mailbox: T): number => {
      if (mailbox.path === 'INBOX') return 0;
      const specialIndex = mailbox.specialUse
        ? ImapService.LIKELY_SPECIAL_USE.indexOf(mailbox.specialUse)
        : -1;
      return specialIndex === -1 ? ImapService.LIKELY_SPECIAL_USE.length + 1 : specialIndex + 1;
    };
    // Stable within a rank, so the server's own ordering is otherwise kept.
    return [...mailboxes].sort((a, b) => rank(a) - rank(b));
  }

  async findEmailFolder(
    accountName: string,
    emailId: string,
    sourceMailbox: string,
  ): Promise<{ folders: string[]; messageId?: string; uids?: number[] }> {
    const sourceUid = parseUid(emailId);
    const client = await this.connections.getImapClient(accountName);

    // 1. Fetch Message-ID from the source mailbox
    let messageId: string | undefined;
    const srcLock = await ImapService.lockMailbox(client, sourceMailbox);
    try {
      const msg = await client.fetchOne(String(sourceUid), { headers: true }, { uid: true });
      // biome-ignore lint/complexity/useOptionalChain: optional chain breaks TS type narrowing for union with false
      if (msg && msg.headers && Buffer.isBuffer(msg.headers)) {
        const headerText = msg.headers.toString('utf-8');
        const match = /^message-id:\s*(.+)$/im.exec(headerText);
        if (match) {
          messageId = match[1].trim();
        }
      }
    } finally {
      srcLock.release();
    }

    if (!messageId) {
      throw new Error('Could not retrieve Message-ID for this email.');
    }

    // 2. List all real mailboxes (exclude virtual and non-selectable)
    const allMailboxes = await client.list();
    const realMailboxes = allMailboxes.filter((mb) => {
      if (!mb.listed) return false;
      if (mb.flags?.has('\\Noselect')) return false;
      const isVirtual = [...ImapService.VIRTUAL_SPECIAL_USE].some(
        (f) => mb.specialUse === f || mb.flags?.has(f),
      );
      if (isVirtual) return false;
      return true;
    });

    // 3. Search for the Message-ID, stopping at the first hit.
    //
    // Each folder costs a SELECT and a header SEARCH, and header SEARCH is
    // typically an unindexed server-side scan. Continuing after a match spent
    // that on every remaining folder to produce a list the caller was told to
    // take the first entry of.
    //
    // Likely folders go first so the one hit is also the useful one: a message
    // is far more often in INBOX or Sent than in an archive label, and on a
    // label-based server it is in several folders at once.
    const searchOrder = ImapService.orderByLikelihood(realMailboxes);

    // UIDs are numbered per folder, so the id that names the message in the
    // source folder can name a different message (or none) in the folder found
    // here. The UIDs from this folder's own search are the ones to act with.
    const folders: string[] = [];
    let uids: number[] | undefined;
    const findInMailbox = async (mbPath: string): Promise<number[]> => {
      try {
        const lock = await lockMailboxBounded(client, mbPath);
        try {
          const results = await client.search(
            { header: { 'message-id': messageId } },
            { uid: true },
          );
          return Array.isArray(results) ? results : [];
        } finally {
          lock.release();
        }
      } catch {
        // Skip folders that can't be selected or searched (e.g. \Noselect, INBOX on some providers)
        return [];
      }
    };
    // eslint-disable-next-line no-restricted-syntax
    for (const mb of searchOrder) {
      // eslint-disable-next-line no-await-in-loop
      const found = await findInMailbox(mb.path);
      if (found.length > 0) {
        folders.push(mb.path);
        uids = [...found].sort((a, b) => a - b);
        break;
      }
    }

    return { folders, messageId, uids };
  }

  // -------------------------------------------------------------------------
  // Move / Delete
  // -------------------------------------------------------------------------

  /**
   * A server without UIDPLUS (for a delete) or without both MOVE and UIDPLUS
   * (for a move) ends the command with a plain EXPUNGE, which also removes
   * every other message any mail program has marked deleted in that folder.
   * Owner decision: allowed, but always said. Counts the other marked messages
   * first. Caller holds the mailbox lock.
   */
  private static async expungeWarnings(
    client: ImapFlow,
    mailbox: string,
    kind: 'delete' | 'move',
    uids: number[],
    tense: 'did' | 'would' = 'did',
  ): Promise<string[]> {
    const has = (capability: string): boolean => Boolean(client.capabilities?.has(capability));
    const plain = kind === 'delete' ? !has('UIDPLUS') : !has('MOVE') && !has('UIDPLUS');
    if (!plain) return [];
    let others: number | undefined;
    try {
      const marked = await client.search({ deleted: true }, { uid: true });
      if (Array.isArray(marked)) others = marked.filter((uid) => !uids.includes(uid)).length;
    } catch {
      others = undefined;
    }
    const why =
      kind === 'delete'
        ? 'This server lacks UIDPLUS, so the delete'
        : 'This server has neither MOVE nor UIDPLUS, so the move (a copy, then a delete)';
    const ends = tense === 'did' ? 'ended' : 'would end';
    let effect: string;
    if (others === undefined) {
      effect = 'which also removes any other message already marked deleted there';
    } else if (others === 0) {
      effect = 'which also removes any other message already marked deleted there (none were)';
    } else {
      effect = `which ${tense === 'did' ? 'also removed' : 'would also remove'} ${others} other message(s) another mail program had marked deleted there`;
    }
    return [`${why} ${ends} with a plain EXPUNGE in "${mailbox}", ${effect}.`];
  }

  /** On Gmail, EXPUNGE from a label folder follows the account's IMAP setting; by default it only removes the label. */
  private static async gmailPermanentNote(client: ImapFlow, mailbox: string): Promise<string[]> {
    if (!client.capabilities?.has('X-GM-EXT-1')) return [];
    const mailboxes = await client.list();
    const mb = ImapService.resolveListed(mailboxes, mailbox, client.namespace?.prefix);
    if (mb && (mb.specialUse === '\\Trash' || mb.specialUse === '\\Junk')) return [];
    return [
      `On Gmail, a permanent delete from "${mailbox}" does what the account's IMAP expunge setting says; ` +
        'by default it only removes this label and the message stays in All Mail. ' +
        'To get rid of it, delete it without permanent (it goes to Trash).',
    ];
  }

  async moveEmail(
    accountName: string,
    emailId: string,
    sourceMailbox: string,
    destinationMailbox: string,
  ): Promise<string[]> {
    const uid = parseUid(emailId);
    const safeSource = sanitizeMailboxName(sourceMailbox);
    const safeDest = sanitizeMailboxName(destinationMailbox);
    const client = await this.connections.getImapClient(accountName);
    await ImapService.assertRealMailbox(client, safeSource);
    const lock = await lockMailboxBounded(client, safeSource);
    try {
      await assertUidPresent(client, uid, safeSource);
      const warnings = await ImapService.expungeWarnings(client, safeSource, 'move', [uid]);
      const ok = await imapCommand(`Moving message to "${safeDest}"`, () =>
        client.messageMove(String(uid), safeDest, { uid: true }),
      );
      if (!ok) {
        throw new Error(`IMAP server rejected the move from "${safeSource}" to "${safeDest}".`);
      }
      this.forgetBodies(accountName, safeSource, [uid]);
      return warnings;
    } finally {
      lock.release();
    }
  }

  async deleteEmail(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
    permanent = false,
  ): Promise<string[]> {
    const uid = parseUid(emailId);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);
    // Both branches: a virtual folder such as All Mail is refused for a
    // permanent delete exactly as it is for a move to Trash.
    await ImapService.assertRealMailbox(client, safeMailbox);

    if (permanent) {
      const gmail = await ImapService.gmailPermanentNote(client, safeMailbox);
      const lock = await lockMailboxBounded(client, safeMailbox);
      try {
        await assertUidPresent(client, uid, safeMailbox);
        const warnings = await ImapService.expungeWarnings(client, safeMailbox, 'delete', [uid]);
        const ok = await client.messageDelete(String(uid), { uid: true });
        if (!ok) {
          throw new Error('IMAP server rejected the delete operation.');
        }
        this.forgetBodies(accountName, safeMailbox, [uid]);
        return [...gmail, ...warnings];
      } finally {
        lock.release();
      }
    } else {
      const mailboxes = await client.list();
      const trash = mailboxes.find((mb) => mb.specialUse === '\\Trash');
      const trashPath = trash?.path ?? 'Trash';

      const lock = await lockMailboxBounded(client, safeMailbox);
      try {
        await assertUidPresent(client, uid, safeMailbox);
        const warnings = await ImapService.expungeWarnings(client, safeMailbox, 'move', [uid]);
        const ok = await imapCommand(`Moving message to "${trashPath}"`, () =>
          client.messageMove(String(uid), trashPath, { uid: true }),
        );
        if (!ok) {
          throw new Error('IMAP server rejected the move to Trash.');
        }
        this.forgetBodies(accountName, safeMailbox, [uid]);
        return warnings;
      } finally {
        lock.release();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Flag management
  // -------------------------------------------------------------------------

  async setFlags(
    accountName: string,
    emailId: string,
    mailbox: string,
    action: 'read' | 'unread' | 'flag' | 'unflag',
  ): Promise<void> {
    const uid = parseUid(emailId);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);
    const lock = await lockMailboxBounded(client, safeMailbox);
    try {
      await assertUidPresent(client, uid, safeMailbox);
      const flagMap: Record<string, { flags: string[]; add: boolean }> = {
        read: { flags: ['\\Seen'], add: true },
        unread: { flags: ['\\Seen'], add: false },
        flag: { flags: ['\\Flagged'], add: true },
        unflag: { flags: ['\\Flagged'], add: false },
      };
      const { flags, add } = flagMap[action];
      let ok: boolean;
      if (add) {
        ok = await client.messageFlagsAdd(String(uid), flags, { uid: true });
      } else {
        ok = await client.messageFlagsRemove(String(uid), flags, { uid: true });
      }
      if (!ok) {
        throw new Error(`IMAP server rejected the ${action} flag operation.`);
      }
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Bulk operations
  // -------------------------------------------------------------------------

  /**
   * The ids that exist in the selected mailbox, in the caller's order. Missing
   * ids are counted as failed on `result` and named in its errors, so a bulk
   * call never reports a message it could not have touched. A UID command that
   * names no message gets a plain OK from the server, which is why this looks
   * first. Caller holds the mailbox lock.
   */
  private async splitPresent(
    client: ImapFlow,
    ids: number[],
    mailbox: string,
    result: BulkResult,
  ): Promise<number[]> {
    for (const id of ids) assertUid(id);
    const found = await presentUids(client, ids);
    const present = ids.filter((id) => found.has(id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length > 0) {
      result.failed += missing.length;
      result.errors?.push(
        `${missing.length} of ${ids.length} IDs not found in "${mailbox}": ${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', ...' : ''}`,
      );
    }
    return present;
  }

  async bulkSetFlags(
    accountName: string,
    ids: number[],
    mailbox: string,
    action: 'mark_read' | 'mark_unread' | 'flag' | 'unflag',
  ): Promise<BulkResult> {
    const client = await this.connections.getImapClient(accountName);
    const lock = await ImapService.lockMailbox(client, mailbox);
    const result: BulkResult = {
      total: ids.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };
    try {
      const flagMap: Record<string, { flags: string[]; add: boolean }> = {
        mark_read: { flags: ['\\Seen'], add: true },
        mark_unread: { flags: ['\\Seen'], add: false },
        flag: { flags: ['\\Flagged'], add: true },
        unflag: { flags: ['\\Flagged'], add: false },
      };
      const { flags, add } = flagMap[action];
      const present = await this.splitPresent(client, ids, mailbox, result);
      if (present.length > 0) {
        const range = present.join(',');
        let ok: boolean;
        if (add) {
          ok = await client.messageFlagsAdd(range, flags, { uid: true });
        } else {
          ok = await client.messageFlagsRemove(range, flags, { uid: true });
        }
        if (ok) {
          result.succeeded = present.length;
        } else {
          result.failed += present.length;
          result.errors?.push('IMAP server rejected the flag operation.');
        }
      }
    } catch (err) {
      result.failed = ids.length - result.succeeded;
      result.errors = [err instanceof Error ? err.message : String(err)];
    } finally {
      lock.release();
    }
    if (result.errors?.length === 0) delete result.errors;
    return result;
  }

  async bulkMove(
    accountName: string,
    ids: number[],
    mailbox: string,
    destination: string,
  ): Promise<BulkResult> {
    const client = await this.connections.getImapClient(accountName);
    // The destination is never locked, so it needs validating on its own —
    // it goes straight to MOVE as a mailbox path.
    const safeDestination = sanitizeMailboxName(destination);
    await ImapService.assertRealMailbox(client, mailbox);
    const lock = await ImapService.lockMailbox(client, mailbox);
    const result: BulkResult = {
      total: ids.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };
    try {
      const present = await this.splitPresent(client, ids, mailbox, result);
      if (present.length > 0) {
        result.warnings = await ImapService.expungeWarnings(client, mailbox, 'move', present);
        const range = present.join(',');
        const ok = await imapCommand(`Moving messages to "${safeDestination}"`, () =>
          client.messageMove(range, safeDestination, { uid: true }),
        );
        if (ok) {
          result.succeeded = present.length;
          this.forgetBodies(accountName, mailbox, present);
        } else {
          result.failed += present.length;
          result.errors?.push('IMAP server rejected the move operation.');
        }
      }
    } catch (err) {
      result.failed = ids.length - result.succeeded;
      result.errors = [err instanceof Error ? err.message : String(err)];
    } finally {
      lock.release();
    }
    if (result.errors?.length === 0) delete result.errors;
    return result;
  }

  async bulkDelete(
    accountName: string,
    ids: number[],
    mailbox: string,
    permanent = false,
  ): Promise<BulkResult> {
    const client = await this.connections.getImapClient(accountName);
    const result: BulkResult = {
      total: ids.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };
    await ImapService.assertRealMailbox(client, mailbox);

    if (permanent) {
      const lock = await ImapService.lockMailbox(client, mailbox);
      try {
        const present = await this.splitPresent(client, ids, mailbox, result);
        if (present.length > 0) {
          result.warnings = await ImapService.expungeWarnings(client, mailbox, 'delete', present);
          const ok = await client.messageDelete(present.join(','), { uid: true });
          if (ok) {
            result.succeeded = present.length;
            this.forgetBodies(accountName, mailbox, present);
          } else {
            result.failed += present.length;
            result.errors?.push('IMAP server rejected the delete operation.');
          }
        }
      } catch (err) {
        result.failed = ids.length - result.succeeded;
        result.errors = [err instanceof Error ? err.message : String(err)];
      } finally {
        lock.release();
      }
    } else {
      const mailboxes = await client.list();
      const trash = mailboxes.find((mb) => mb.specialUse === '\\Trash');
      const trashPath = trash?.path ?? 'Trash';

      const lock = await ImapService.lockMailbox(client, mailbox);
      try {
        const present = await this.splitPresent(client, ids, mailbox, result);
        if (present.length > 0) {
          result.warnings = await ImapService.expungeWarnings(client, mailbox, 'move', present);
          const ok = await imapCommand(`Moving messages to "${trashPath}"`, () =>
            client.messageMove(present.join(','), trashPath, { uid: true }),
          );
          if (ok) {
            result.succeeded = present.length;
            this.forgetBodies(accountName, mailbox, present);
          } else {
            result.failed += present.length;
            result.errors?.push('IMAP server rejected the move to Trash.');
          }
        }
      } catch (err) {
        result.failed = ids.length - result.succeeded;
        result.errors = [err instanceof Error ? err.message : String(err)];
      } finally {
        lock.release();
      }
    }

    if (result.errors?.length === 0) delete result.errors;
    return result;
  }

  // -------------------------------------------------------------------------
  // Draft management
  // -------------------------------------------------------------------------

  async saveDraft(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      inReplyTo?: string;
      /** Inline base64 `content` or a local file `path` (checked by the read guard). */
      attachments?: OutgoingAttachmentInput[];
    },
  ): Promise<{ id?: number; mailbox: string; uidValidity?: string }> {
    const account = this.connections.getAccount(accountName);
    // Read and check files before touching the server.
    const attachments = options.attachments?.length
      ? await resolveOutgoingAttachments(options.attachments, {
          maxEncodedBytes: resolveSendLimitMb(account, DEFAULT_SEND_LIMIT_MB) * 1024 * 1024,
        })
      : [];
    const client = await this.connections.getImapClient(accountName);

    // Find the Drafts folder
    const mailboxes = await client.list();
    const drafts = mailboxes.find((mb) => mb.specialUse === '\\Drafts');
    const draftsPath = drafts?.path ?? 'Drafts';

    // Build via MailComposer so headers are folded/encoded and body is transfer-encoded;
    // manual concat left \r\n.\r\n in body unstuffed and required ad-hoc sanitizeHeader.
    const { default: MailComposer } = await import('nodemailer/lib/mail-composer/index.js');
    const composer = new MailComposer({
      from: account.fullName ? { name: account.fullName, address: account.email } : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      subject: options.subject,
      date: new Date(),
      ...(options.inReplyTo ? { inReplyTo: options.inReplyTo } : {}),
      ...(options.html ? { html: options.body } : { text: options.body }),
      ...(attachments.length > 0
        ? {
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              encoding: 'base64' as const,
              contentType: a.contentType,
            })),
          }
        : {}),
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    const rawMessage: Buffer = await (
      composer as unknown as { compile: () => { build: () => Promise<Buffer> } }
    )
      .compile()
      .build();

    const appendResult = await imapCommand(`Saving draft to "${draftsPath}"`, () =>
      client.append(draftsPath, toCrlf(rawMessage), ['\\Draft', '\\Seen']),
    );

    // A server without APPENDUID does not say which UID the draft got. No id is
    // better than a made-up 0, which reads as a real UID to every later caller.
    const appended = appendResult as unknown as { uid?: number; uidValidity?: bigint | number };
    return {
      ...(typeof appended.uid === 'number' && appended.uid > 0 ? { id: appended.uid } : {}),
      mailbox: draftsPath,
      ...(appended.uidValidity !== undefined
        ? { uidValidity: appended.uidValidity.toString() }
        : {}),
    };
  }

  /** The account's Drafts folder: the \\Drafts special-use folder, else one named "Drafts". */
  private static findDraftsFolder(mailboxes: ListResponse[]): ListResponse | undefined {
    return (
      mailboxes.find((mb) => mb.specialUse === '\\Drafts' || mb.flags?.has('\\Drafts')) ??
      mailboxes.find(
        (mb) => (mb.path.split(mb.delimiter || '/').pop() ?? '').toLowerCase() === 'drafts',
      )
    );
  }

  /** Whether a fetched message carries the \\Draft flag. */
  private static isDraftMessage(msg: unknown): boolean {
    const flags = (msg as { flags?: Iterable<string> } | null | undefined)?.flags;
    return Boolean(flags && new Set(flags).has('\\Draft'));
  }

  /**
   * Fetch a draft message for sending.
   * Returns the parsed draft with recipients and content.
   */
  async fetchDraft(
    accountName: string,
    emailId: number,
    mailbox?: string,
  ): Promise<{
    email: Email;
    mailbox: string;
  }> {
    assertUid(emailId);
    const client = await this.connections.getImapClient(accountName);

    // Only a real draft is ever sent: a message in the account's Drafts folder
    // that carries \\Draft. Anything else (a received mail in INBOX, say) would
    // go out from the owner's address with someone else's words and recipients.
    const mailboxes = await client.list();
    const drafts = ImapService.findDraftsFolder(mailboxes);
    if (!drafts) {
      throw new Error('This account has no Drafts folder, so there is no draft to send.');
    }
    if (mailbox !== undefined && mailbox.trim() !== '') {
      const requested = ImapService.resolveListed(
        mailboxes,
        sanitizeMailboxName(mailbox),
        client.namespace?.prefix,
      );
      if (!requested || requested.path !== drafts.path) {
        throw new Error(
          `send_draft only sends from the Drafts folder ("${drafts.path}"), not "${mailbox}". ` +
            'It never sends a received email.',
        );
      }
    }
    const draftsPath = drafts.path;

    const lock = await ImapService.lockMailbox(client, draftsPath);
    try {
      const msg = await client.fetchOne(String(emailId), { uid: true, flags: true }, { uid: true });
      if (!msg) {
        throw new Error(`Draft ${emailId} not found in "${draftsPath}".`);
      }
      if (!ImapService.isDraftMessage(msg)) {
        throw new Error(
          `Message ${emailId} in "${draftsPath}" is not marked as a draft (\\Draft), so it was not sent.`,
        );
      }
    } finally {
      lock.release();
    }

    const email = await this.getEmail(accountName, String(emailId), draftsPath);
    return { email, mailbox: draftsPath };
  }

  /**
   * Append a sent message to the account's Sent folder.
   *
   * SMTP delivery and Sent-folder filing are separate concerns: this is best
   * effort by contract. Callers must treat an APPEND failure as a warning,
   * never as a failed send - the mail already went out.
   *
   * The folder is located per attempt from the server's own listing, so
   * provider differences (Gmail's "[Gmail]/Sent Mail", "Sent Items",
   * "INBOX.Sent", ...) resolve without configuration. Returns whether a
   * folder was found, so callers can log usefully when it was not.
   */
  async appendSent(
    accountName: string,
    raw: Buffer | string,
  ): Promise<{ appended: boolean; folder?: string }> {
    const client = await this.connections.getImapClient(accountName);

    const mailboxes = await client.list();
    const sentFolder =
      (mailboxes ?? []).find((m) => m.specialUse === '\\Sent') ??
      (mailboxes ?? []).find((m) => {
        const p = String(m.path).toLowerCase();
        return (
          p === 'sent' ||
          p === 'sent mail' ||
          p.endsWith('/sent') ||
          p.endsWith('/sent mail') ||
          p.endsWith('.sent')
        );
      });
    if (!sentFolder) return { appended: false };

    const lock = await ImapService.lockMailbox(client, String(sentFolder.path));
    try {
      await client.append(String(sentFolder.path), toCrlf(raw), ['\\Seen']);
      return { appended: true, folder: String(sentFolder.path) };
    } finally {
      lock.release();
    }
  }

  /**
   * The header fields of one message (lowercased names, unfolded values), from a
   * headers-only fetch. Used by local rules that match on a header.
   */
  async getHeaders(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
  ): Promise<Record<string, string>> {
    const uid = parseUid(emailId);
    const client = await this.connections.getImapClient(accountName);
    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, headers: true }, { uid: true });
      if (!msg) throw new Error(`Email ${emailId} not found in ${mailbox}`);
      return Buffer.isBuffer(msg.headers) ? parseHeaderBlock(msg.headers.toString('utf-8')) : {};
    } finally {
      lock.release();
    }
  }

  /**
   * Sender authentication signals for one message, from headers already on
   * the server - a single headers-only fetch, no body round trips.
   */
  async getEmailSecurity(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
  ): Promise<
    AuthSignals & {
      from?: string;
      replyTo?: string;
      returnPath?: string;
      /** Authentication-Results headers that were not trusted (the sender may have written them). */
      unverified: string[];
    }
  > {
    const uid = parseUid(emailId);
    const client = await this.connections.getImapClient(accountName);

    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, envelope: true, headers: true },
        { uid: true },
      );
      if (!msg) throw new Error(`Email ${emailId} not found in ${mailbox}`);

      const headerBlock = Buffer.isBuffer(msg.headers) ? msg.headers.toString('utf-8') : '';
      const account = this.connections.getAccount(accountName);
      // Believe the topmost header (the receiving server adds its own last, on top) and
      // headers from this account's own mail hosts. A sender can add headers of its own.
      const { trusted, unverified } = selectTrustedAuthResults(
        extractAuthenticationResults(headerBlock),
        [account.imap.host, account.smtp.host],
      );
      const signals = parseAuthSignals(trusted);

      const headerValue = (key: string): string | undefined => {
        const re = new RegExp(`^${key}:[ \\t]*(.*)$`, 'im');
        const m = re.exec(headerBlock);
        return m ? sanitizeInline(m[1].trim()) : undefined;
      };

      return {
        ...signals,
        replyTo: headerValue('reply-to'),
        returnPath: headerValue('return-path'),
        unverified: unverified.map((v) => sanitizeInline(v, 300)),
      };
    } finally {
      lock.release();
    }
  }

  /**
   * Move a sent (or cancelled) draft to Trash. Only a message that still
   * carries \\Draft is touched, and when `expectedUidValidity` is given (a
   * draft number kept for days by the scheduler) the folder must not have
   * been renumbered since. Returns warnings to pass on.
   */
  async trashDraft(
    accountName: string,
    emailId: number,
    mailbox: string,
    expectedUidValidity?: string,
  ): Promise<string[]> {
    assertUid(emailId);
    const safe = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);
    const mailboxes = await client.list();
    const trash =
      mailboxes.find((mb) => mb.specialUse === '\\Trash' || mb.flags?.has('\\Trash')) ??
      mailboxes.find(
        (mb) => (mb.path.split(mb.delimiter || '/').pop() ?? '').toLowerCase() === 'trash',
      );
    const lock = await lockMailboxBounded(client, safe);
    try {
      if (expectedUidValidity !== undefined) {
        const current = client.mailbox ? client.mailbox.uidValidity?.toString() : undefined;
        if (current !== expectedUidValidity) {
          throw new Error(
            `"${safe}" was renumbered since draft ${emailId} was saved, so it was left alone: ` +
              'that number may now be a different message.',
          );
        }
      }
      const msg = await client.fetchOne(String(emailId), { uid: true, flags: true }, { uid: true });
      if (!msg) throw new Error(`Draft ${emailId} not found in "${safe}".`);
      if (!ImapService.isDraftMessage(msg)) {
        throw new Error(`Message ${emailId} in "${safe}" is not a draft, so it was left alone.`);
      }
      if (trash) {
        const warnings = await ImapService.expungeWarnings(client, safe, 'move', [emailId]);
        const ok = await imapCommand(`Moving the draft to "${trash.path}"`, () =>
          client.messageMove(String(emailId), trash.path, { uid: true }),
        );
        if (!ok) throw new Error(`IMAP server rejected moving the draft to "${trash.path}".`);
        this.forgetBodies(accountName, safe, [emailId]);
        return warnings;
      }
      // No Trash folder at all: remove it as before, and say so.
      const warnings = await ImapService.expungeWarnings(client, safe, 'delete', [emailId]);
      const ok = await client.messageDelete(String(emailId), { uid: true });
      if (!ok) throw new Error('IMAP server rejected removing the draft.');
      this.forgetBodies(accountName, safe, [emailId]);
      return ['No Trash folder was found, so the draft was deleted for good.', ...warnings];
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Mailbox (folder) CRUD
  // -------------------------------------------------------------------------

  async createMailbox(accountName: string, folderPath: string): Promise<void> {
    const safe = sanitizeMailboxName(folderPath);
    const client = await this.connections.getImapClient(accountName);
    await imapCommand(`Creating mailbox "${safe}"`, () => client.mailboxCreate(safe));
  }

  async renameMailbox(accountName: string, folderPath: string, newPath: string): Promise<void> {
    const from = sanitizeMailboxName(folderPath);
    const to = sanitizeMailboxName(newPath);
    const client = await this.connections.getImapClient(accountName);
    const { listed } = await assertMailboxRemovable(client, from, 'rename');
    // Act on the folder the check examined, not on a padded spelling of it.
    const source = listed?.path ?? from;
    await imapCommand(`Renaming mailbox "${source}" to "${to}"`, () =>
      client.mailboxRename(source, to),
    );
  }

  /**
   * Deleting a folder erases its mail for good, with no Trash. So only an empty
   * folder with no subfolders is deleted; anything else is refused with what it
   * holds, and the mail has to be moved out first (a move or delete_email,
   * which goes to Trash).
   */
  private static async assertMailboxDeletable(
    client: ImapFlow,
    safe: string,
  ): Promise<ListResponse> {
    const { listed, children } = await assertMailboxRemovable(client, safe, 'delete');
    if (!listed) {
      throw new Error(`Mailbox "${safe}" does not exist. Use list_mailboxes to see options.`);
    }
    if (children.length > 0) {
      const names = children.slice(0, 10).map((c) => `"${c.path}"`);
      throw new Error(
        `"${safe}" has ${children.length} subfolder(s) (${names.join(', ')}${children.length > 10 ? ', ...' : ''}). ` +
          'Deleting it could take their mail with it. Delete or move the subfolders first.',
      );
    }
    if (listed.flags?.has('\\Noselect')) return listed;
    let messages: number | undefined;
    try {
      const status = await client.status(listed.path, { messages: true });
      messages = status && typeof status.messages === 'number' ? status.messages : undefined;
    } catch {
      messages = undefined;
    }
    if (messages === undefined) {
      throw new Error(
        `Could not read how many messages "${safe}" holds, so it was not deleted. Deleting a folder erases its mail for good.`,
      );
    }
    if (messages > 0) {
      throw new Error(
        `"${safe}" still holds ${messages} message(s). Deleting it would erase them for good. ` +
          'Move the mail out first (move_email or bulk_action move, or delete_email, which goes to Trash), then delete the empty folder.',
      );
    }
    return listed;
  }

  async deleteMailbox(accountName: string, folderPath: string): Promise<void> {
    const safe = sanitizeMailboxName(folderPath);
    const client = await this.connections.getImapClient(accountName);
    const listed = await ImapService.assertMailboxDeletable(client, safe);
    await imapCommand(`Deleting mailbox "${listed.path}"`, () => client.mailboxDelete(listed.path));
  }

  // -------------------------------------------------------------------------
  // Dry run: check what a write would do, change nothing
  // -------------------------------------------------------------------------

  /**
   * The listed mailbox that `requested` names, or an error. Matches the way the write paths name
   * mailboxes: exactly, INBOX in any case, or with the personal namespace prefix added.
   */
  private static async findListedMailbox(
    client: ImapFlow,
    requested: string,
  ): Promise<{ mailbox: ListResponse; all: ListResponse[] }> {
    const all = await client.list();
    const prefix = client.namespace?.prefix;
    const found =
      all.find((m) => m.path === requested) ??
      (requested.toUpperCase() === 'INBOX'
        ? all.find((m) => m.path.toUpperCase() === 'INBOX')
        : undefined) ??
      (prefix ? all.find((m) => m.path === `${prefix}${requested}`) : undefined);
    if (!found) {
      throw new Error(`Mailbox "${requested}" does not exist. Use list_mailboxes to see options.`);
    }
    return { mailbox: found, all };
  }

  /** Which of `uids` are in `mailbox`. Opens it read-only; flags and \\Recent are left alone. */
  private async existingUids(
    client: ImapFlow,
    mailbox: string,
    uids: number[],
  ): Promise<Set<number>> {
    const lock = await imapCommand(`Opening mailbox "${mailbox}"`, () =>
      lockMailboxBounded(client, mailbox, { readOnly: true }),
    );
    try {
      const found = await client.search({ uid: uids.join(',') }, { uid: true });
      return new Set(found || []);
    } finally {
      lock.release();
    }
  }

  /** expungeWarnings for a dry run: opens the folder read-only for the count. */
  private static async previewExpungeNotes(
    client: ImapFlow,
    mailbox: string,
    kind: 'delete' | 'move',
    uids: number[],
  ): Promise<string[]> {
    const has = (capability: string): boolean => Boolean(client.capabilities?.has(capability));
    if (kind === 'delete' ? has('UIDPLUS') : has('MOVE') || has('UIDPLUS')) return [];
    const lock = await imapCommand(`Opening mailbox "${mailbox}"`, () =>
      lockMailboxBounded(client, mailbox, { readOnly: true }),
    );
    try {
      return await ImapService.expungeWarnings(client, mailbox, kind, uids, 'would');
    } finally {
      lock.release();
    }
  }

  private static parseUid(emailId: string): number {
    return parseUid(emailId);
  }

  async previewMove(
    accountName: string,
    emailId: string,
    sourceMailbox: string,
    destinationMailbox: string,
  ): Promise<DryRunPlan> {
    const uid = ImapService.parseUid(emailId);
    const client = await this.connections.getImapClient(accountName);
    const source = sanitizeMailboxName(sourceMailbox);
    const dest = sanitizeMailboxName(destinationMailbox);
    const src = await ImapService.findListedMailbox(client, source);
    const dst = await ImapService.findListedMailbox(client, dest);
    await ImapService.assertRealMailbox(client, src.mailbox.path);
    const present = await this.existingUids(client, src.mailbox.path, [uid]);
    if (!present.has(uid)) throw new Error(`Email ${emailId} not found in "${source}".`);
    const notes: string[] = [];
    if (src.mailbox.path === dst.mailbox.path)
      notes.push('Source and destination are the same folder.');
    notes.push(...(await ImapService.previewExpungeNotes(client, src.mailbox.path, 'move', [uid])));
    return {
      summary: `Would move email ${emailId} from "${source}" to "${dest}".`,
      notes,
    };
  }

  async previewDelete(
    accountName: string,
    emailId: string,
    mailbox: string,
    permanent: boolean,
  ): Promise<DryRunPlan> {
    const uid = ImapService.parseUid(emailId);
    const client = await this.connections.getImapClient(accountName);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const { mailbox: listed, all } = await ImapService.findListedMailbox(client, safeMailbox);
    const present = await this.existingUids(client, listed.path, [uid]);
    if (!present.has(uid)) throw new Error(`Email ${emailId} not found in "${safeMailbox}".`);
    await ImapService.assertRealMailbox(client, listed.path);
    if (permanent) {
      return {
        summary: `Would permanently delete email ${emailId} from "${safeMailbox}". This cannot be undone.`,
        notes: [
          ...(await ImapService.gmailPermanentNote(client, listed.path)),
          ...(await ImapService.previewExpungeNotes(client, listed.path, 'delete', [uid])),
        ],
      };
    }
    const trash = all.find((mb) => mb.specialUse === '\\Trash');
    const notes = trash
      ? []
      : ['No folder is marked as Trash; the server would be asked for "Trash".'];
    notes.push(...(await ImapService.previewExpungeNotes(client, listed.path, 'move', [uid])));
    return {
      summary: `Would move email ${emailId} from "${safeMailbox}" to Trash ("${trash?.path ?? 'Trash'}").`,
      notes,
    };
  }

  async previewBulk(
    accountName: string,
    ids: number[],
    mailbox: string,
    action: 'mark_read' | 'mark_unread' | 'flag' | 'unflag' | 'move' | 'delete',
    destination?: string,
  ): Promise<DryRunPlan> {
    for (const id of ids) assertUid(id);
    const client = await this.connections.getImapClient(accountName);
    const safeMailbox = sanitizeMailboxName(mailbox);
    const { mailbox: listed, all } = await ImapService.findListedMailbox(client, safeMailbox);
    const notes: string[] = [];
    let what = '';
    if (action === 'move') {
      if (!destination) throw new Error('Destination mailbox is required for "move" action.');
      const dest = sanitizeMailboxName(destination);
      await ImapService.findListedMailbox(client, dest);
      await ImapService.assertRealMailbox(client, listed.path);
      what = `move to "${dest}"`;
    } else if (action === 'delete') {
      await ImapService.assertRealMailbox(client, listed.path);
      const trash = all.find((mb) => mb.specialUse === '\\Trash');
      if (!trash)
        notes.push('No folder is marked as Trash; the server would be asked for "Trash".');
      what = `move to Trash ("${trash?.path ?? 'Trash'}")`;
    } else {
      what = action.replace('_', ' as ').replace('mark as ', 'mark ');
    }
    const present = await this.existingUids(client, listed.path, ids);
    if (action === 'move' || action === 'delete') {
      notes.push(
        ...(await ImapService.previewExpungeNotes(client, listed.path, 'move', [...present])),
      );
    }
    const missing = ids.filter((id) => !present.has(id));
    if (missing.length > 0) {
      notes.push(
        `${missing.length} of ${ids.length} IDs are not in "${safeMailbox}" (${missing.slice(0, 20).join(', ')}${missing.length > 20 ? ', ...' : ''}).`,
      );
    }
    return {
      summary: `Would ${what}: ${present.size} of ${ids.length} messages in "${safeMailbox}".`,
      notes,
    };
  }

  async previewCreateMailbox(accountName: string, folderPath: string): Promise<DryRunPlan> {
    const client = await this.connections.getImapClient(accountName);
    const safe = sanitizeMailboxName(folderPath);
    const exists = await ImapService.findListedMailbox(client, safe).then(
      () => true,
      () => false,
    );
    if (exists) throw new Error(`Mailbox "${safe}" already exists.`);
    return { summary: `Would create mailbox "${safe}".`, notes: [] };
  }

  async previewRenameMailbox(
    accountName: string,
    folderPath: string,
    newPath: string,
  ): Promise<DryRunPlan> {
    const client = await this.connections.getImapClient(accountName);
    const from = sanitizeMailboxName(folderPath);
    const to = sanitizeMailboxName(newPath);
    await ImapService.findListedMailbox(client, from);
    await assertMailboxRemovable(client, from, 'rename');
    const taken = await ImapService.findListedMailbox(client, to).then(
      () => true,
      () => false,
    );
    if (taken) throw new Error(`Mailbox "${to}" already exists.`);
    return { summary: `Would rename mailbox "${from}" to "${to}".`, notes: [] };
  }

  async previewDeleteMailbox(accountName: string, folderPath: string): Promise<DryRunPlan> {
    const safe = sanitizeMailboxName(folderPath);
    const client = await this.connections.getImapClient(accountName);
    await ImapService.findListedMailbox(client, safe);
    // The same refusals as the real call: a dry run never promises a delete it would refuse.
    await ImapService.assertMailboxDeletable(client, safe);
    return { summary: `Would delete the empty mailbox "${safe}".`, notes: [] };
  }

  async previewDeleteLabel(accountName: string, name: string): Promise<DryRunPlan> {
    const strategy = await this.getLabelStrategy(accountName);
    const client = await this.connections.getImapClient(accountName);
    if (strategy.type === 'keyword') {
      throw new Error(
        'IMAP keywords cannot be deleted server-wide. ' +
          'Remove the keyword from individual emails using remove_label instead.',
      );
    }
    const labels = await strategy.listLabels(client);
    const label = labels.find((l) => l.name === name);
    if (!label) throw new Error(`Label "${name}" does not exist. Use list_labels to see options.`);
    return {
      summary: `Would delete label "${name}" (${strategy.type}); mail filed under it stays in the account.`,
      notes: [],
    };
  }

  // -------------------------------------------------------------------------
  // Attachment download
  // -------------------------------------------------------------------------

  async downloadAttachment(
    accountName: string,
    emailId: string,
    mailbox: string,
    filename: string,
    maxSizeBytes = 5 * 1024 * 1024,
  ): Promise<{
    filename: string;
    mimeType: string;
    size: number;
    contentBase64: string;
  }> {
    const uid = parseUid(emailId);
    const client = await this.connections.getImapClient(accountName);

    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      // Fetch bodyStructure to find the MIME part
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, bodyStructure: true },
        { uid: true },
      );

      if (!msg) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }

      const attachments = extractAttachments(msg.bodyStructure);
      const attachment = attachments.find((a) => a.filename === filename);
      if (!attachment) {
        const available = attachments
          .map((a) => `${a.filename} (${Math.round(a.size / 1024)}KB)`)
          .join(', ');
        throw new Error(
          `Attachment "${filename}" not found. ` +
            (available ? `Available attachments: ${available}` : 'This email has no attachments.'),
        );
      }

      if (attachment.size > maxSizeBytes) {
        const sizeMB = Math.round(attachment.size / 1024 / 1024);
        const limitMB = Math.round(maxSizeBytes / 1024 / 1024);
        throw new Error(
          `Attachment "${filename}" is ${sizeMB}MB, which exceeds the ${limitMB}MB limit. ` +
            `Use savePath to write it directly to disk instead of loading into context.`,
        );
      }

      // Find the MIME part number
      const partNumber = findMimePartByFilename(msg.bodyStructure, filename);
      if (!partNumber) {
        throw new Error(`Could not locate MIME part for "${filename}"`);
      }

      // Download the part
      const downloadResult = await client.download(String(uid), partNumber, {
        uid: true,
      });

      if (!downloadResult?.content) {
        throw new Error(`Failed to download attachment "${filename}"`);
      }

      const chunks: Buffer[] = [];
      // eslint-disable-next-line no-restricted-syntax
      for await (const chunk of downloadResult.content) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      const content = Buffer.concat(chunks);

      return {
        filename: attachment.filename,
        mimeType: attachment.mimeType,
        size: content.length,
        contentBase64: content.toString('base64'),
      };
    } finally {
      lock.release();
    }
  }

  /**
   * Fetch every attachment of a message as nodemailer-ready parts.
   *
   * Used by forward_email (reattaching the original's parts) and send_draft
   * (sending a draft's own attachments). The total byte budget is enforced
   * against the sizes reported by bodyStructure BEFORE any download, so an
   * oversized original fails at compose time with a clear message instead of
   * at the SMTP server mid-handshake.
   */
  async fetchMessageAttachments(
    accountName: string,
    emailId: string,
    mailbox = 'INBOX',
    maxTotalEncodedBytes = 25 * 1024 * 1024,
  ): Promise<
    Array<{ filename: string; content: string; contentType: string; encoding: 'base64' }>
  > {
    const uid = parseUid(emailId);
    const client = await this.connections.getImapClient(accountName);

    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, bodyStructure: true },
        { uid: true },
      );

      if (!msg) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }

      const parts = extractAttachmentParts(msg.bodyStructure);
      if (parts.length === 0) return [];

      const totalEncodedBytes = parts.reduce((sum, part) => sum + Math.ceil(part.size / 3) * 4, 0);
      if (totalEncodedBytes > maxTotalEncodedBytes) {
        const maxTotalMb = Math.floor(maxTotalEncodedBytes / (1024 * 1024));
        throw new Error(
          `Original carries about ${Math.ceil(totalEncodedBytes / 1024 / 1024)}MB of ` +
            `base64-encoded attachments, exceeding the ${maxTotalMb}MB outbound limit. ` +
            `Forward without attachments or send them another way.`,
        );
      }

      const out: Array<{
        filename: string;
        content: string;
        contentType: string;
        encoding: 'base64';
      }> = [];

      for (const part of parts) {
        if (!part.partPath) continue;
        // eslint-disable-next-line no-await-in-loop
        const downloadResult = await client.download(String(uid), part.partPath, { uid: true });
        if (!downloadResult?.content) {
          throw new Error(`Failed to download attachment "${part.filename}"`);
        }

        const chunks: Buffer[] = [];
        // eslint-disable-next-line no-restricted-syntax
        for await (const chunk of downloadResult.content) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        const content = Buffer.concat(chunks);

        out.push({
          filename: part.filename,
          content: content.toString('base64'),
          contentType: part.mimeType,
          encoding: 'base64',
        });
      }

      return out;
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Export a message's raw RFC 822 source
  // -------------------------------------------------------------------------

  /**
   * Fetch the raw RFC 822 source of one message for export as a .eml file.
   *
   * imapflow sends `source: true` as BODY.PEEK[], so \Seen is never set, and the
   * mailbox is opened with EXAMINE (read-only) so a server that ignores PEEK still
   * cannot change a flag. An oversized message is refused before its source is
   * transferred, and again by the octets that actually arrived.
   */
  async exportEmail(
    accountName: string,
    emailId: string,
    mailbox: string,
    maxSizeBytes: number,
  ): Promise<{ filename: string; mimeType: string; size: number; source: Buffer }> {
    const uidText = String(parseUid(emailId));
    const safeMailbox = sanitizeMailboxName(mailbox);
    const client = await this.connections.getImapClient(accountName);

    const lock = await imapCommand(`Opening mailbox "${safeMailbox}"`, () =>
      lockMailboxBounded(client, safeMailbox, { readOnly: true }),
    );
    try {
      const meta = await client.fetchOne(
        uidText,
        { uid: true, size: true, internalDate: true },
        { uid: true },
      );
      if (!meta) {
        throw new Error(`Email ${emailId} not found in ${mailbox}`);
      }
      if (typeof meta.size === 'number' && meta.size > maxSizeBytes) {
        throw new Error(
          `Email ${uidText} is ${meta.size} bytes, over the ${maxSizeBytes}-byte limit`,
        );
      }

      const msg = await client.fetchOne(uidText, { uid: true, source: true }, { uid: true });
      if (!msg || !Buffer.isBuffer(msg.source)) {
        throw new Error(`Could not fetch the source of email ${emailId} in ${mailbox}`);
      }
      if (msg.source.length > maxSizeBytes) {
        throw new Error(
          `Email ${uidText} is ${msg.source.length} bytes, over the ${maxSizeBytes}-byte limit`,
        );
      }

      const date =
        meta.internalDate instanceof Date ? meta.internalDate : new Date(meta.internalDate ?? NaN);
      const day = Number.isNaN(date.getTime()) ? 'undated' : date.toISOString().slice(0, 10);
      return {
        filename: `${day}_${uidText}.eml`,
        mimeType: 'message/rfc822',
        size: msg.source.length,
        source: msg.source,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Save all email attachments to a local directory
  // -------------------------------------------------------------------------

  /**
   * Download and save all non-ICS attachments from an email to a local directory.
   * Returns metadata including the saved file paths and file:// URLs.
   *
   * Attachments larger than maxSizeBytes (default 25 MB) are skipped.
   */
  async saveEmailAttachments(
    accountName: string,
    emailId: string,
    mailbox: string,
    destDir: string,
    maxSizeBytes = 25 * 1024 * 1024,
  ): Promise<
    {
      filename: string;
      localPath: string;
      fileUrl: string;
      mimeType: string;
      size: number;
    }[]
  > {
    const uid = parseUid(emailId);
    const client = await this.connections.getImapClient(accountName);

    const lock = await ImapService.lockMailbox(client, mailbox);
    let attachmentMetas: AttachmentMeta[] = [];
    try {
      const msg = await client.fetchOne(
        String(uid),
        { uid: true, bodyStructure: true },
        { uid: true },
      );
      if (!msg) return [];
      attachmentMetas = extractAttachments(msg.bodyStructure).filter(
        (a) => a.size <= maxSizeBytes && !isCalendarPart(a.mimeType, a.filename),
      );
    } finally {
      lock.release();
    }

    if (attachmentMetas.length === 0) return [];

    // destDir comes from this app (the calendar attachments folder), but it is judged like any
    // other write: nothing may land in a protected place or leave the folder through a symlink.
    const guard = { allowRoots: [CALENDAR_ATTACHMENTS_DIR] };
    await assertSafeWritePath(path.join(destDir, 'probe'), guard);
    const { mkdir, chmod } = await import('node:fs/promises');
    // Attachments are mail content: owner-only folder and files.
    await mkdir(destDir, { recursive: true, mode: 0o700 });
    await chmod(destDir, 0o700);

    // Use the attachment parts directly, not by filename, to avoid
    // cross-copying when two attachments share a basename.
    const attachmentParts = (() => {
      const parts: Array<{ filename: string; mimeType: string; size: number; partPath: string }> =
        [];
      const _walk = (node: unknown, partPath = ''): void => {
        if (!node || typeof node !== 'object') return;
        const bs = node as Record<string, unknown>;
        const cur = (bs.part as string | undefined) ?? partPath;
        if (bs.disposition === 'attachment') {
          const params = (bs.dispositionParameters ?? bs.parameters ?? {}) as Record<
            string,
            string
          >;
          const fn = params.filename ?? params.name ?? 'unnamed';
          const meta = attachmentMetas.find((m) => m.filename === fn);
          if (meta)
            parts.push({ filename: fn, mimeType: meta.mimeType, size: meta.size, partPath: cur });
        }
        if (Array.isArray(bs.childNodes)) {
          (bs.childNodes as unknown[]).forEach((child, i) => {
            const cp = cur ? `${cur}.${i + 1}` : String(i + 1);
            _walk(child, cp);
          });
        }
      };
      // Re-fetch structure to get part paths — reuse the earlier fetch
      return parts;
    })();

    // Pair each attachment meta to its part by occurrence order for that filename
    const occurrenceCursor = new Map<string, number>();
    const metaToPart = new Map<number, (typeof attachmentParts)[0]>();
    attachmentMetas.forEach((meta, idx) => {
      const occ = occurrenceCursor.get(meta.filename) ?? 0;
      occurrenceCursor.set(meta.filename, occ + 1);
      const candidates = attachmentParts.filter((p) => p.filename === meta.filename);
      if (candidates[occ]) metaToPart.set(idx, candidates[occ]);
    });

    const seenNames = new Map<string, number>();
    const results = await Promise.allSettled(
      attachmentMetas.map(async (meta, idx) => {
        const part = metaToPart.get(idx);
        const partPath = part?.partPath;
        let downloaded: { contentBase64: string; size: number };
        if (partPath) {
          const client = await this.connections.getImapClient(accountName);
          const lock = await ImapService.lockMailbox(client, mailbox);
          try {
            const dl = await client.download(String(uid), partPath, {
              uid: true,
            });
            if (!dl.content) {
              throw new Error(`Failed to download mail part "${partPath}"`);
            }
            const chunks: Buffer[] = [];
            for await (const c of dl.content)
              chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c as never));
            const buf = Buffer.concat(chunks);
            downloaded = { contentBase64: buf.toString('base64'), size: buf.length };
          } finally {
            lock.release();
          }
        } else {
          downloaded = await this.downloadAttachment(
            accountName,
            emailId,
            mailbox,
            meta.filename,
            maxSizeBytes,
          );
        }
        const resolvedDir = path.resolve(destDir);
        let sanitizedBase =
          path
            .basename(meta.filename)
            .replace(/[/\\?%*:|"<>]/g, '_')
            .replace(/^\.+$/, '_') || 'unnamed';
        // Dedup same-basename files: invoice.pdf, invoice-1.pdf, etc.
        const count = seenNames.get(sanitizedBase) ?? 0;
        seenNames.set(sanitizedBase, count + 1);
        if (count > 0) {
          const ext = path.extname(sanitizedBase);
          const base = path.basename(sanitizedBase, ext);
          sanitizedBase = `${base}-${count}${ext}`;
        }
        const localPath = path.resolve(resolvedDir, sanitizedBase);
        if (!localPath.startsWith(resolvedDir + path.sep)) {
          throw new Error(`Refusing to write outside the destination directory`);
        }
        await assertSafeWritePath(localPath, { ...guard, within: destDir });
        const { writeFile } = await import('node:fs/promises');
        await writeFile(localPath, Buffer.from(downloaded.contentBase64, 'base64'), {
          mode: 0o600,
        });
        return {
          filename: meta.filename,
          localPath,
          fileUrl: `file://${localPath}`,
          mimeType: meta.mimeType,
          size: downloaded.size,
        };
      }),
    );

    type FulfilledValue = (typeof results)[0] extends PromiseFulfilledResult<infer T> ? T : never;
    const rejected = results.filter((r) => r.status === 'rejected') as PromiseRejectedResult[];
    if (rejected.length > 0) {
      // Surface failures — caller decides; don't silently drop attachments
      const msgs = rejected.map((r) => String((r.reason as Error)?.message ?? r.reason)).join('; ');
      throw new Error(`Failed to save ${rejected.length} attachment(s): ${msgs}`);
    }
    return results
      .filter((r) => r.status === 'fulfilled')
      .map((r) => (r as PromiseFulfilledResult<FulfilledValue>).value);
  }

  /**
   * Reconstruct an email thread by following References / In-Reply-To chains.
   * Searches by Message-ID header for each reference and returns messages in
   * chronological order. Caps at MAX_THREAD_MESSAGES to prevent runaway chains.
   */
  async getThread(
    accountName: string,
    messageId: string,
    mailbox = 'INBOX',
  ): Promise<{
    threadId: string;
    messages: Email[];
    participants: EmailAddress[];
    messageCount: number;
  }> {
    const MAX_THREAD_MESSAGES = 50;
    const client = await this.connections.getImapClient(accountName);
    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      // Collect all Message-IDs in the thread
      const targetMsgIds = new Set<string>([messageId]);

      // First, find the root message to get its References chain
      const rootSearch = await client.search(
        { header: { 'Message-ID': messageId } },
        { uid: true },
      );
      const rootUids: number[] = Array.isArray(rootSearch) ? rootSearch : [];

      if (rootUids.length > 0) {
        const rootMsg = await client.fetchOne(
          String(rootUids[0]),
          { uid: true, envelope: true, source: true },
          { uid: true },
        );

        if (rootMsg) {
          const raw = rootMsg as unknown as Record<string, unknown>;
          const envelope = (raw.envelope ?? {}) as Record<string, unknown>;
          const inReplyTo = envelope.inReplyTo as string | undefined;
          if (inReplyTo) targetMsgIds.add(inReplyTo);

          // Parse References header from source
          if (raw.source && Buffer.isBuffer(raw.source)) {
            const src = raw.source.toString('utf-8');
            const refMatch = /^References:\s*(.+?)(?:\r?\n(?!\s))/ms.exec(src);
            if (refMatch) {
              refMatch[1]
                .split(/\s+/)
                .filter(Boolean)
                .forEach((ref) => {
                  targetMsgIds.add(ref);
                });
            }
          }
        }
      }

      // Search for all related messages by Message-ID
      const foundUids = new Set<number>();
      // eslint-disable-next-line no-restricted-syntax
      for (const msgId of targetMsgIds) {
        if (foundUids.size >= MAX_THREAD_MESSAGES) break;

        try {
          // eslint-disable-next-line no-await-in-loop
          const searchResult = await client.search(
            { header: { 'Message-ID': msgId } },
            { uid: true },
          );
          if (Array.isArray(searchResult)) {
            searchResult.forEach((uid) => {
              foundUids.add(uid);
            });
          }
        } catch {
          // Header search may not be supported for all messages
        }
      }

      // Also search for messages that reference any of our Message-IDs
      // eslint-disable-next-line no-restricted-syntax
      for (const msgId of targetMsgIds) {
        if (foundUids.size >= MAX_THREAD_MESSAGES) break;

        try {
          // eslint-disable-next-line no-await-in-loop
          const refSearch = await client.search({ header: { References: msgId } }, { uid: true });
          if (Array.isArray(refSearch)) {
            refSearch.forEach((uid) => {
              foundUids.add(uid);
            });
          }
          // eslint-disable-next-line no-await-in-loop
          const replySearch = await client.search(
            { header: { 'In-Reply-To': msgId } },
            { uid: true },
          );
          if (Array.isArray(replySearch)) {
            replySearch.forEach((uid) => {
              foundUids.add(uid);
            });
          }
        } catch {
          // Header search may fail on some servers
        }
      }

      if (foundUids.size === 0) {
        return {
          threadId: messageId,
          messages: [],
          participants: [],
          messageCount: 0,
        };
      }

      // Fetch full content for all thread messages
      const uidList = Array.from(foundUids).slice(0, MAX_THREAD_MESSAGES);
      const range = uidList.join(',');
      const messages: Email[] = [];

      // Collect the whole fetch before converting any of it. messageToEmail
      // downloads a body part, and ImapFlow runs one command at a time — so
      // converting inside this loop deadlocks the connection: the stream can't
      // finish until the download does, and the download can't start until the
      // stream finishes.
      const rawMessages: Record<string, unknown>[] = [];
      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(
        range,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          // Headers, not source: a thread caps at 50 messages, and pulling
          // full sources means transferring 50 entire messages — attachments
          // included — to render what is mostly a summary.
          headers: true,
        },
        { uid: true },
      )) {
        rawMessages.push(msg as unknown as Record<string, unknown>);
      }

      // eslint-disable-next-line no-restricted-syntax
      for (const raw of rawMessages) {
        // eslint-disable-next-line no-await-in-loop
        messages.push(await messageToEmail(raw, client, raw.uid as number));
      }

      // Sort chronologically
      messages.sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());

      // Extract unique participants
      const participantMap = new Map<string, EmailAddress>();
      messages.forEach((email) => {
        const addParticipant = (addr: EmailAddress) => {
          const key = addr.address.toLowerCase();
          if (!participantMap.has(key)) {
            participantMap.set(key, addr);
          }
        };
        addParticipant(email.from);
        email.to.forEach(addParticipant);
        email.cc?.forEach(addParticipant);
      });

      return {
        threadId: messageId,
        messages,
        participants: Array.from(participantMap.values()),
        messageCount: messages.length,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Contact extraction
  // -------------------------------------------------------------------------

  async extractContacts(
    accountName: string,
    options: { mailbox?: string; limit?: number } = {},
  ): Promise<Contact[]> {
    const client = await this.connections.getImapClient(accountName);
    const mailbox = options.mailbox ?? 'INBOX';
    const limit = Math.min(options.limit ?? 100, 500);

    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      // Search for all messages, take the latest N
      const searchResult = await client.search({ all: true }, { uid: true });
      const uids: number[] = Array.isArray(searchResult) ? searchResult : [];

      if (uids.length === 0) return [];

      uids.sort((a, b) => b - a);
      const targetUids = uids.slice(0, limit);
      const range = targetUids.join(',');

      const contactMap = new Map<
        string,
        { name?: string; email: string; frequency: number; lastSeen?: Date }
      >();

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of client.fetch(range, { uid: true, envelope: true }, { uid: true })) {
        const envelope = ((msg as unknown as Record<string, unknown>).envelope ?? {}) as Record<
          string,
          unknown
        >;
        // An unreadable Date header counts the contact but says nothing about when.
        const date = safeDate(envelope.date) ?? (envelope.date ? undefined : new Date());

        const addressLists = [
          envelope.from as { name?: string; address?: string }[] | undefined,
          envelope.to as { name?: string; address?: string }[] | undefined,
          envelope.cc as { name?: string; address?: string }[] | undefined,
        ];

        addressLists.forEach((addrs) => {
          (addrs ?? []).forEach((addr) => {
            if (!addr.address) return;
            const key = addr.address.toLowerCase();
            const existing = contactMap.get(key);
            if (existing) {
              existing.frequency += 1;
              if (date && (!existing.lastSeen || date > existing.lastSeen)) {
                existing.lastSeen = date;
                if (addr.name) existing.name = addr.name;
              }
            } else {
              contactMap.set(key, {
                name: addr.name ?? undefined,
                email: addr.address,
                frequency: 1,
                lastSeen: date,
              });
            }
          });
        });
      }

      // Sort by frequency descending
      const contacts: Contact[] = Array.from(contactMap.values())
        .sort((a, b) => b.frequency - a.frequency)
        .map((c) => ({
          name: c.name,
          email: c.email,
          frequency: c.frequency,
          lastSeen: c.lastSeen ? c.lastSeen.toISOString() : DATE_UNKNOWN,
        }));

      return contacts;
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Email analytics
  // -------------------------------------------------------------------------

  async getEmailStats(
    accountName: string,
    mailbox: string,
    period: 'day' | 'week' | 'month',
  ): Promise<EmailStats> {
    const client = await this.connections.getImapClient(accountName);

    const now = new Date();
    const since = new Date(now);
    if (period === 'day') since.setDate(since.getDate() - 1);
    else if (period === 'week') since.setDate(since.getDate() - 7);
    else since.setMonth(since.getMonth() - 1);

    const lock = await ImapService.lockMailbox(client, mailbox);
    try {
      // Date-range search
      const uids: number[] = await client
        .search({ since }, { uid: true })
        .then((r: unknown) => (Array.isArray(r) ? r : []) as number[]);

      if (uids.length === 0) {
        return {
          period,
          dateRange: {
            from: since.toISOString().split('T')[0],
            to: now.toISOString().split('T')[0],
          },
          totalReceived: 0,
          unreadCount: 0,
          flaggedCount: 0,
          topSenders: [],
          dailyVolume: [],
          hasAttachmentsCount: 0,
          avgPerDay: 0,
        };
      }

      const senderMap = new Map<string, { email: string; name?: string; count: number }>();
      const dailyMap = new Map<string, number>();
      let unread = 0;
      let flagged = 0;
      let withAttachments = 0;

      // eslint-disable-next-line no-restricted-syntax
      for await (const msg of ImapService.fetchUidChunks(
        client,
        uids,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
        },
        { uid: true },
      )) {
        const envelope = ((msg as unknown as Record<string, unknown>).envelope ?? {}) as Record<
          string,
          unknown
        >;
        const flags = ((msg as unknown as Record<string, unknown>).flags ??
          new Set()) as Set<string>;
        const { bodyStructure } = msg as unknown as Record<string, unknown>;

        // Count flags
        if (!flags.has('\\Seen')) unread += 1;
        if (flags.has('\\Flagged')) flagged += 1;
        if (hasAttachments(bodyStructure)) withAttachments += 1;

        // Track sender
        const fromList = (envelope.from ?? []) as {
          name?: string;
          address?: string;
        }[];
        if (fromList.length > 0 && fromList[0].address) {
          const key = fromList[0].address.toLowerCase();
          const existing = senderMap.get(key);
          if (existing) {
            existing.count += 1;
          } else {
            // Sender-chosen text: one clean line, names cut to 100 characters.
            senderMap.set(key, {
              email: sanitizeInline(fromList[0].address, 320),
              name: fromList[0].name ? sanitizeInline(fromList[0].name, 100) : fromList[0].name,
              count: 1,
            });
          }
        }

        // Track daily volume
        const date = safeDate(envelope.date) ?? (envelope.date ? undefined : new Date());
        const dayKey = date ? date.toISOString().split('T')[0] : 'undated';
        dailyMap.set(dayKey, (dailyMap.get(dayKey) ?? 0) + 1);
      }

      const topSenders: SenderStat[] = Array.from(senderMap.values())
        .sort((a, b) => b.count - a.count)
        .slice(0, 10);

      const dailyVolume: DailyVolume[] = Array.from(dailyMap.entries())
        .map(([date, count]) => ({ date, count }))
        .sort((a, b) => a.date.localeCompare(b.date));

      const days = Math.max(1, dailyVolume.length);

      return {
        period,
        dateRange: {
          from: since.toISOString().split('T')[0],
          to: now.toISOString().split('T')[0],
        },
        totalReceived: uids.length,
        unreadCount: unread,
        flaggedCount: flagged,
        topSenders,
        dailyVolume,
        hasAttachmentsCount: withAttachments,
        avgPerDay: Math.round((uids.length / days) * 10) / 10,
      };
    } finally {
      lock.release();
    }
  }

  // -------------------------------------------------------------------------
  // Mailbox snapshot (cheap counters)
  // -------------------------------------------------------------------------

  /**
   * Mailbox counters without scanning the mailbox.
   *
   * STATUS answers the totals directly, and counting today's arrivals needs
   * only the length of a SEARCH result — no envelopes, no body structure. Two
   * round trips, whatever the mailbox holds.
   */
  async getMailboxSnapshot(accountName: string, mailbox = 'INBOX'): Promise<MailboxSnapshot> {
    const client = await this.connections.getImapClient(accountName);
    const safeMailbox = sanitizeMailboxName(mailbox);

    const status = await client.status(safeMailbox, { messages: true, unseen: true });

    const startOfToday = new Date();
    startOfToday.setHours(0, 0, 0, 0);

    const lock = await lockMailboxBounded(client, safeMailbox);
    let receivedToday = 0;
    try {
      const todayUids = await client.search({ since: startOfToday }, { uid: true });
      receivedToday = Array.isArray(todayUids) ? todayUids.length : 0;
    } finally {
      lock.release();
    }

    return {
      total: status === false ? 0 : (status.messages ?? 0),
      unread: status === false ? 0 : (status.unseen ?? 0),
      receivedToday,
    };
  }

  // -------------------------------------------------------------------------
  // Quota
  // -------------------------------------------------------------------------

  async getQuota(accountName: string): Promise<QuotaInfo | null> {
    const client = await this.connections.getImapClient(accountName);
    try {
      const quota = await (
        client as unknown as {
          getQuota: (path: string) => Promise<{
            storage?: { used?: number; limit?: number };
          } | null>;
        }
      ).getQuota('INBOX');

      if (!quota?.storage?.limit) return null;

      const usedMb = Math.round((quota.storage.used ?? 0) / 1024 / 1024);
      const totalMb = Math.round(quota.storage.limit / 1024 / 1024);
      return {
        usedMb,
        totalMb,
        percentage: totalMb > 0 ? Math.round((usedMb / totalMb) * 100) : 0,
      };
    } catch {
      return null;
    }
  }

  // -------------------------------------------------------------------------
  // Capabilities
  // -------------------------------------------------------------------------

  async getCapabilities(accountName: string): Promise<string[]> {
    const client = await this.connections.getImapClient(accountName);
    try {
      const caps = (client as unknown as Record<string, unknown>).capabilities as
        | Map<string, boolean>
        | Set<string>
        | undefined;
      if (!caps) return [];
      if (caps instanceof Map) return Array.from(caps.keys());
      return Array.from(caps as Set<string>);
    } catch {
      return [];
    }
  }

  // -------------------------------------------------------------------------
  // Calendar part extraction
  // -------------------------------------------------------------------------

  /* eslint-disable no-await-in-loop, no-restricted-syntax -- Sequential IMAP fetch required */
  async getCalendarParts(accountName: string, mailbox: string, emailId: string): Promise<string[]> {
    const uid = parseUid(emailId);
    const client = await this.connections.getImapClient(accountName);
    const lock = await ImapService.lockMailbox(client, mailbox);

    try {
      const icsContents: string[] = [];

      // Drain the structure fetch completely before issuing any further
      // command. ImapFlow runs one command at a time, so starting the part
      // fetch inside this loop deadlocks: the outer stream cannot finish until
      // the inner one does, and the inner one cannot start until the outer
      // finishes.
      const partIds: string[] = [];
      for await (const msg of client.fetch(
        String(uid),
        { uid: true, bodyStructure: true },
        { uid: true },
      )) {
        const structure = (msg as unknown as Record<string, unknown>).bodyStructure;
        partIds.push(...this.findCalendarParts(structure));
      }

      // Download each part, one command at a time.
      //
      // `download()` rather than `fetch({ bodyParts })`: calendar parts are
      // almost always base64 or quoted-printable, and a bodyParts fetch hands
      // back the still-encoded bytes. download() applies the transfer decoding,
      // so the ICS parser gets text it can actually read.
      for (const partId of partIds) {
        const part = await client.download(String(uid), partId, { uid: true });
        if (!part?.content) continue;

        const chunks: Buffer[] = [];
        for await (const chunk of part.content) {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        }
        if (chunks.length > 0) {
          icsContents.push(Buffer.concat(chunks).toString('utf-8'));
        }
      }

      return icsContents;
    } finally {
      lock.release();
    }
  }
  /* eslint-enable no-await-in-loop, no-restricted-syntax */

  /**
   * Recursively find body parts with text/calendar content type.
   */
  private findCalendarParts(structure: unknown, prefix = ''): string[] {
    if (!structure || typeof structure !== 'object') return [];
    const s = structure as Record<string, unknown>;
    const parts: string[] = [];

    const { type, subtype } = splitMimeType(s.type);
    const disposition = (s.disposition as string | undefined)?.toLowerCase() ?? '';

    // Check for text/calendar part
    if (type === 'text' && subtype === 'calendar') {
      const partId = s.part as string | undefined;
      if (partId) parts.push(partId);
      else if (prefix) parts.push(prefix);
    }

    // Locate calendar parts. Must use the same predicate as the attachment
    // filter: if the two disagree, a part can be excluded from attachments and
    // never found as calendar, disappearing from both surfaces.
    if (disposition === 'attachment' && typeof s.dispositionParameters === 'object') {
      const params = s.dispositionParameters as Record<string, string>;
      const filename = params.filename ?? '';
      if (isCalendarPart(String(s.type ?? ''), filename)) {
        const partId = s.part as string | undefined;
        if (partId) parts.push(partId);
        else if (prefix) parts.push(prefix);
      }
    }

    // Recurse into child nodes
    if (Array.isArray(s.childNodes)) {
      s.childNodes.forEach((child: unknown, i: number) => {
        const childPrefix = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
        parts.push(...this.findCalendarParts(child, childPrefix));
      });
    }

    return parts;
  }
}
