/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import crypto from 'node:crypto';

import type { Transporter } from 'nodemailer';
import { DEFAULT_SEND_LIMIT_MB, resolveSendLimitMb } from '../config/send-limit.js';
import { redactedError, sentCredentials } from '../connections/credential-redaction.js';
import type { IConnectionManager } from '../connections/types.js';
import { mcpLog } from '../logging.js';
import type RateLimiter from '../safety/rate-limiter.js';
import { sanitizeTemplateVariable } from '../safety/validation.js';
import type { AccountConfig, DryRunPlan, SendResult } from '../types/index.js';
import type ImapService from './imap.service.js';
import {
  type OutgoingAttachmentInput,
  resolveOutgoingAttachments,
} from './outgoing-attachments.js';

/** Reply markers: Re (English), AW (German), SV (Nordic). */
export const REPLY_PREFIX = /^\s*(re|aw|sv)\s*:/i;
/** Forward markers: Fwd, Fw, WG (German). */
export const FORWARD_PREFIX = /^\s*(fwd?|wg)\s*:/i;

/**
 * Added to every forward. A local rule refuses to forward a message that
 * already carries it, so a ring of accounts that forward to each other stops
 * after one hop.
 */
export const FORWARD_MARKER_HEADER = 'X-IMAP-Wizard-Forwarded';

export interface SendEmailOptions {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  html?: boolean;
  /** Attachments: inline base64 `content`, or the `path` of a local file (checked by the read guard). */
  attachments?: OutgoingAttachmentInput[];
  /**
   * Explicit Message-ID for retries. Without it nodemailer mints a fresh
   * one per attempt, so a retried send is indistinguishable from a new
   * email and the recipient sees both.
   */
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  /** Set on a deliberate resend to pass the duplicate-send guard. */
  allowDuplicate?: boolean;
}

/**
 * The mail server may or may not have accepted the message (a timeout or a
 * dropped connection after the text was sent). Never retried automatically:
 * the caller must check the Sent folder first.
 */
export class UncertainSendError extends Error {
  constructor(reason: string) {
    super(
      `The mail server did not confirm this email (${reason}), so it may or may not have been sent. ` +
        'Result: unknown. Check the Sent folder before sending again. It was not retried.',
    );
    this.name = 'UncertainSendError';
  }
}

/** Error codes that mean the server never took the message (it refused it or was never reached). */
const NOT_SENT_CODES = new Set([
  'EENVELOPE',
  'EMESSAGE',
  'EAUTH',
  'ECONNREFUSED',
  'ENOTFOUND',
  'EDNS',
  'ETLS',
]);

/**
 * Did the server certainly not accept the message? A reply code to a command,
 * a refused recipient, a refused login or a failure to connect at all all mean
 * yes. A timeout or a dropped connection anywhere else is uncertain: the text
 * may already be delivered.
 */
function isDefiniteRefusal(err: unknown): boolean {
  const { code, responseCode, command } = (err ?? {}) as {
    code?: string;
    responseCode?: number;
    command?: string;
  };
  return (
    (code !== undefined && NOT_SENT_CODES.has(code)) ||
    command === 'CONN' ||
    typeof responseCode === 'number'
  );
}

/** A refused recipient or a server reply leaves the shared connection healthy; only a broken one is dropped. */
function leavesTransportHealthy(err: unknown): boolean {
  const { code, responseCode } = (err ?? {}) as { code?: string; responseCode?: number };
  if (code === 'EENVELOPE' || code === 'EMESSAGE') return true;
  return typeof responseCode === 'number' && code !== 'EAUTH';
}

function domainOf(address: string | undefined): string {
  return (address?.split('@').pop() ?? '').trim().toLowerCase();
}

export interface ReplyOptions {
  emailId: string;
  mailbox?: string;
  body: string;
  replyAll?: boolean;
  html?: boolean;
  attachments?: OutgoingAttachmentInput[];
  /** Set on a deliberate repeat to pass the duplicate-send guard. */
  allowDuplicate?: boolean;
}

export interface ForwardOptions {
  emailId: string;
  mailbox?: string;
  to: string[];
  body?: string;
  cc?: string[];
  html?: boolean;
  /** Defaults to true: a forward that silently drops the invoice is the bug. */
  includeAttachments?: boolean;
  /** Set on a deliberate repeat to pass the duplicate-send guard. */
  allowDuplicate?: boolean;
  /** Extra attachments added to the forward: inline base64 `content`, or a local file `path`. */
  attachments?: OutgoingAttachmentInput[];
}

/** SMTP servers that put every message sent through them in the Sent folder themselves. */
const SMTP_HOSTS_THAT_FILE_SENT = new Set(['smtp.gmail.com', 'smtp.googlemail.com']);

export default class SmtpService {
  private readonly pendingSentFilings = new Set<Promise<void>>();

  constructor(
    private connections: IConnectionManager,
    private rateLimiter: RateLimiter,
    private imapService: ImapService,
    private globalAttachmentLimitMb = DEFAULT_SEND_LIMIT_MB,
  ) {}

  // -------------------------------------------------------------------------
  // Send email
  // -------------------------------------------------------------------------

  async sendEmail(accountName: string, options: SendEmailOptions): Promise<SendResult> {
    const key = `${accountName}|${options.to.slice().sort().join(',')}|${options.subject}`;
    return this.guardedSend(key, options.allowDuplicate, async () => {
      this.checkRateLimit(accountName);

      const mailOptions = await this.composeSend(accountName, options);
      const transport = await this.connections.getSmtpTransport(accountName);

      const result = await this.sendWithRecovery(accountName, transport, mailOptions);

      this.fileToSent(accountName, mailOptions);

      return {
        messageId: result.messageId ?? '',
        status: 'sent' as const,
      };
    });
  }

  /** Everything `sendEmail` checks and builds, without sending, filing or counting against the rate limit. */
  async previewSend(accountName: string, options: SendEmailOptions): Promise<DryRunPlan> {
    this.assertRateLimitAvailable(accountName);
    this.peekDuplicate(
      `${accountName}|${options.to.slice().sort().join(',')}|${options.subject}`,
      options.allowDuplicate,
    );
    const mailOptions = await this.composeSend(accountName, options);
    return SmtpService.describeMail('send this email', mailOptions);
  }

  private async composeSend(
    accountName: string,
    options: SendEmailOptions,
  ): Promise<Record<string, unknown>> {
    const account = this.connections.getAccount(accountName);
    const attachments = await this.resolveAttachments(account, options.attachments);

    const messageId =
      options.messageId ?? `<${crypto.randomUUID()}@${account.email.split('@')[1]}>`;
    return {
      from: account.fullName ? { name: account.fullName, address: account.email } : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      subject: options.subject,
      ...(options.html ? { html: options.body } : { text: options.body }),
      messageId,
      ...(options.inReplyTo ? { inReplyTo: options.inReplyTo } : {}),
      ...(options.references ? { references: options.references.join(' ') } : {}),
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
    };
  }

  // -------------------------------------------------------------------------
  // Reply
  // -------------------------------------------------------------------------

  async replyToEmail(accountName: string, options: ReplyOptions): Promise<SendResult> {
    const key = `${accountName}|reply|${options.mailbox ?? 'INBOX'}|${options.emailId}|${options.replyAll ? 'all' : 'one'}`;
    return this.guardedSend(key, options.allowDuplicate, async () => {
      this.checkRateLimit(accountName);

      const { mailOptions, warnings } = await this.composeReply(accountName, options);
      const transport = await this.connections.getSmtpTransport(accountName);

      const result = await this.sendWithRecovery(accountName, transport, mailOptions);

      this.fileToSent(accountName, mailOptions);

      return {
        messageId: result.messageId ?? '',
        status: 'sent' as const,
        to: String(mailOptions.to ?? '')
          .split(', ')
          .filter(Boolean),
        cc: String(mailOptions.cc ?? '')
          .split(', ')
          .filter(Boolean),
        ...(warnings.length > 0 ? { warnings } : {}),
      };
    });
  }

  /** Everything `replyToEmail` checks and builds, without sending or counting against the rate limit. */
  async previewReply(accountName: string, options: ReplyOptions): Promise<DryRunPlan> {
    this.assertRateLimitAvailable(accountName);
    this.peekDuplicate(
      `${accountName}|reply|${options.mailbox ?? 'INBOX'}|${options.emailId}|${options.replyAll ? 'all' : 'one'}`,
      options.allowDuplicate,
    );
    const { mailOptions, warnings } = await this.composeReply(accountName, options);
    const plan = SmtpService.describeMail('send this reply', mailOptions, true);
    plan.notes.push(...warnings.map((w) => `Warning: ${w}`));
    return plan;
  }

  private async composeReply(
    accountName: string,
    options: ReplyOptions,
  ): Promise<{ mailOptions: Record<string, unknown>; warnings: string[] }> {
    const account = this.connections.getAccount(accountName);
    const extraAttachments = await this.resolveAttachments(account, options.attachments);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    // Build recipient list — Reply-To overrides From when present
    const to = [original.replyTo?.address ?? original.from.address];
    const cc: string[] = [];
    const warnings: string[] = [];
    // Using Reply-To is normal. Sending to a different domain than the sender
    // without saying so is what hides a spoofed message, so say it.
    if (
      original.replyTo?.address &&
      domainOf(original.replyTo.address) !== domainOf(original.from.address)
    ) {
      warnings.push(
        `This reply goes to ${original.replyTo.address} (the Reply-To address), which is on a different domain than the sender ${original.from.address}.`,
      );
    }

    if (options.replyAll) {
      // Add all original To recipients except ourselves
      original.to
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          to.push(addr.address);
        });
      // Add CC recipients except ourselves
      (original.cc ?? [])
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          cc.push(addr.address);
        });
    }

    // Build threading headers
    const references = [...(original.references ?? []), original.messageId].filter(Boolean);

    // Any existing reply marker, in any case or common locale (RE:, re:, AW:, SV:),
    // counts: otherwise replies stack "Re: RE: ..." (upstream #102).
    const subject = REPLY_PREFIX.test(original.subject)
      ? original.subject
      : `Re: ${original.subject}`;

    const mailOptions = {
      from: account.fullName ? { name: account.fullName, address: account.email } : account.email,
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject,
      inReplyTo: original.messageId,
      references: references.join(' '),
      messageId: `<${crypto.randomUUID()}@${account.email.split('@')[1]}>`,
      ...(options.html ? { html: options.body } : { text: options.body }),
      ...(extraAttachments.length
        ? {
            attachments: extraAttachments.map((attachment) => ({
              filename: attachment.filename,
              content: attachment.content,
              encoding: 'base64' as const,
              contentType: attachment.contentType,
            })),
          }
        : {}),
      disableFileAccess: true,
      disableUrlAccess: true,
    };
    return { mailOptions, warnings };
  }

  // -------------------------------------------------------------------------
  // Forward
  // -------------------------------------------------------------------------

  async forwardEmail(accountName: string, options: ForwardOptions): Promise<SendResult> {
    return this.guardedSend(
      SmtpService.forwardKey(accountName, options),
      options.allowDuplicate,
      async () => {
        this.checkRateLimit(accountName);

        const mailOptions = await this.composeForward(accountName, options);
        const transport = await this.connections.getSmtpTransport(accountName);

        const result = await this.sendWithRecovery(accountName, transport, mailOptions);

        this.fileToSent(accountName, mailOptions);

        return {
          messageId: result.messageId ?? '',
          status: 'sent' as const,
        };
      },
    );
  }

  private static forwardKey(accountName: string, options: ForwardOptions): string {
    return `${accountName}|forward|${options.mailbox ?? 'INBOX'}|${options.emailId}|${options.to.slice().sort().join(',')}|${(options.cc ?? []).slice().sort().join(',')}`;
  }

  /** Everything `forwardEmail` checks and builds, without sending or counting against the rate limit. */
  async previewForward(accountName: string, options: ForwardOptions): Promise<DryRunPlan> {
    this.assertRateLimitAvailable(accountName);
    this.peekDuplicate(SmtpService.forwardKey(accountName, options), options.allowDuplicate);
    const mailOptions = await this.composeForward(accountName, options);
    return SmtpService.describeMail('forward this email', mailOptions, true);
  }

  private async composeForward(
    accountName: string,
    options: ForwardOptions,
  ): Promise<Record<string, unknown>> {
    const account = this.connections.getAccount(accountName);
    const extraAttachments = await this.resolveAttachments(account, options.attachments);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    const subject = FORWARD_PREFIX.test(original.subject)
      ? original.subject
      : `Fwd: ${original.subject}`;

    const from = original.from.name
      ? `${original.from.name} <${original.from.address}>`
      : original.from.address;
    const to = original.to.map((a) => a.address).join(', ');

    // Every field below comes from a message someone else composed, so the HTML
    // branch escapes them. Interpolating an attacker-chosen display name into
    // the markup of a message the user is forwarding onward is HTML injection.
    const esc = (value: string) => sanitizeTemplateVariable(value, true);

    let fullBody: string;
    if (options.html) {
      const forwardHeader = [
        '<br><hr>',
        '<div>---------- Forwarded message ----------<br>',
        `From: ${esc(from)}<br>`,
        `Date: ${esc(original.date)}<br>`,
        `Subject: ${esc(original.subject)}<br>`,
        `To: ${esc(to)}</div><br>`,
      ].join('');

      // Prefer the original's HTML part; a plain-text original goes in a <pre>
      // so its line breaks survive, rather than collapsing into one paragraph.
      const originalBody = original.bodyHtml ?? `<pre>${esc(original.bodyText ?? '')}</pre>`;

      fullBody = (options.body ?? '') + forwardHeader + originalBody;
    } else {
      const forwardHeader = [
        '',
        '---------- Forwarded message ----------',
        `From: ${from}`,
        `Date: ${original.date}`,
        `Subject: ${original.subject}`,
        `To: ${to}`,
        '',
      ].join('\n');

      const originalBody = original.bodyText ?? original.bodyHtml ?? '';
      fullBody = (options.body ?? '') + forwardHeader + originalBody;
    }

    // Reattach the original's parts. Fetching happens before anything goes
    // out, and the fetch refuses oversized originals at compose time.
    const includeAttachments =
      options.includeAttachments === undefined ? true : options.includeAttachments;
    const originalAttachments = includeAttachments
      ? await this.imapService.fetchMessageAttachments(
          accountName,
          options.emailId,
          options.mailbox ?? 'INBOX',
          this.sendLimitMb(account) * 1024 * 1024,
        )
      : [];
    const attachments = [
      ...originalAttachments,
      ...extraAttachments.map((a) => ({ ...a, encoding: 'base64' as const })),
    ];
    const totalBytes = attachments.reduce((n, a) => n + Buffer.byteLength(a.content, 'utf8'), 0);
    if (totalBytes > this.sendLimitMb(account) * 1024 * 1024) {
      throw new Error(
        `The original's attachments plus the added ones exceed the ${this.sendLimitMb(account)} MB send limit.`,
      );
    }

    return {
      from: account.fullName ? { name: account.fullName, address: account.email } : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject,
      messageId: `<${crypto.randomUUID()}@${account.email.split('@')[1]}>`,
      headers: { [FORWARD_MARKER_HEADER]: account.email },
      ...(options.html ? { html: fullBody } : { text: fullBody }),
      ...(attachments.length > 0 ? { attachments } : {}),
      disableFileAccess: true,
      disableUrlAccess: true,
    };
  }

  // -------------------------------------------------------------------------
  // Rate limit check
  // -------------------------------------------------------------------------

  private checkRateLimit(accountName: string): void {
    if (!this.rateLimiter.tryConsume(accountName)) {
      throw new Error(
        `Rate limit exceeded for account "${accountName}". ` +
          `Please wait before sending more emails.`,
      );
    }
  }

  /** Like `checkRateLimit`, but does not use up a send. */
  private assertRateLimitAvailable(accountName: string): void {
    if (this.rateLimiter.remaining(accountName) < 1) {
      throw new Error(
        `Rate limit exceeded for account "${accountName}". ` +
          `Please wait before sending more emails.`,
      );
    }
  }

  /** Turn a composed message into a dry-run report. Nothing in it is sent. */
  private static describeMail(
    verb: string,
    mail: Record<string, unknown>,
    /** True when the text comes from an existing email, not from the caller. */
    derivedFromMessage = false,
  ): DryRunPlan {
    const list = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const from = mail.from as string | { name?: string; address: string };
    const fromText = typeof from === 'string' ? from : from.address;
    const attachments = (mail.attachments ?? []) as Array<{
      filename?: string;
      content: string;
    }>;
    const bodyText = String(mail.html ?? mail.text ?? '');
    const lines = [
      `From: ${fromText}`,
      `To: ${list(mail.to) ?? '(none)'}`,
      ...(list(mail.cc) ? [`Cc: ${list(mail.cc)}`] : []),
      ...(list(mail.bcc) ? [`Bcc: ${list(mail.bcc)}`] : []),
      `Subject: ${String(mail.subject ?? '')}`,
      ...(list(mail.inReplyTo) ? [`In reply to: ${list(mail.inReplyTo)}`] : []),
      `Body: ${bodyText.length} characters${mail.html ? ' (HTML)' : ''}`,
      ...attachments.map(
        (a) =>
          `Attachment: ${a.filename ?? '(unnamed)'}, ${Buffer.from(a.content, 'base64').length} bytes`,
      ),
    ];
    // A reply, forward or draft is built from an existing email: its subject, addresses and
    // file names are the sender's text, so they are handed on as fenced lines, not notes.
    return derivedFromMessage
      ? { summary: `Would ${verb}.`, notes: [], fromMessage: lines }
      : { summary: `Would ${verb}.`, notes: lines };
  }

  private sendLimitMb(account: ReturnType<IConnectionManager['getAccount']>): number {
    return resolveSendLimitMb(account, this.globalAttachmentLimitMb);
  }

  /** Read path attachments through the read guard and enforce the send limit on the base64 total. */
  private resolveAttachments(
    account: ReturnType<IConnectionManager['getAccount']>,
    attachments: OutgoingAttachmentInput[] | undefined,
  ) {
    return resolveOutgoingAttachments(attachments, {
      maxEncodedBytes: this.sendLimitMb(account) * 1024 * 1024,
    });
  }

  /**
   * Recent sends, keyed by account | what is being sent. A retried send is
   * otherwise indistinguishable from a new one: nodemailer mints a fresh
   * random Message-ID per attempt, so a timeout-then-retry delivers twice and
   * mailbox providers file both copies.
   *
   * A key is reserved BEFORE the first network wait, so two identical calls
   * started together cannot both pass. It is released on a definite failure
   * and kept, marked "unknown", when the server may have accepted the mail.
   */
  private readonly recentSends = new Map<
    string,
    { at: number; state: 'inflight' | 'sent' | 'unknown' }
  >();

  /** Window in which an identical send that went out is refused. */
  private static readonly DUPLICATE_SEND_WINDOW_MS = 60_000;

  /** An unknown result blocks a repeat for longer: the owner needs time to check Sent. */
  private static readonly UNKNOWN_SEND_WINDOW_MS = 30 * 60_000;

  /** Throw if a send with this key is under way, went out lately or ended unknown. Changes nothing. */
  private peekDuplicate(key: string, allowDuplicate?: boolean): void {
    if (allowDuplicate) return;
    const mark = this.recentSends.get(key);
    if (!mark) return;
    const age = Date.now() - mark.at;
    if (mark.state === 'inflight') {
      throw new Error(
        'The same email is already being sent. Wait for it to finish before sending again.',
      );
    }
    if (mark.state === 'unknown' && age < SmtpService.UNKNOWN_SEND_WINDOW_MS) {
      throw new Error(
        'An earlier send with the same details ended with an unknown result: the server may have accepted it. ' +
          'Check the Sent folder first. If it did not go out, set allow_duplicate to true to send it again.',
      );
    }
    if (mark.state === 'sent' && age < SmtpService.DUPLICATE_SEND_WINDOW_MS) {
      throw new Error(
        `An email with the same recipients and subject was sent less than a minute ago. ` +
          `If this is a deliberate resend, set allow_duplicate to true.`,
      );
    }
  }

  /** Reserve the key, run the send, then record how it ended. */
  private async guardedSend<T>(
    key: string,
    allowDuplicate: boolean | undefined,
    run: () => Promise<T>,
  ): Promise<T> {
    this.peekDuplicate(key, allowDuplicate);
    const mark = { at: Date.now(), state: 'inflight' as 'inflight' | 'sent' | 'unknown' };
    this.recentSends.set(key, mark);
    const settle = (state: 'sent' | 'unknown' | 'released') => {
      // A deliberate resend may have replaced our mark; leave theirs alone.
      if (this.recentSends.get(key) !== mark) return;
      if (state === 'released') {
        this.recentSends.delete(key);
        return;
      }
      mark.state = state;
      mark.at = Date.now();
      this.pruneRecentSends();
    };
    try {
      const result = await run();
      settle('sent');
      return result;
    } catch (err) {
      settle(err instanceof UncertainSendError ? 'unknown' : 'released');
      throw err;
    }
  }

  private pruneRecentSends(): void {
    if (this.recentSends.size <= 1000) return;
    const now = Date.now();
    for (const [k, m] of this.recentSends) {
      const ttl =
        m.state === 'unknown'
          ? SmtpService.UNKNOWN_SEND_WINDOW_MS
          : SmtpService.DUPLICATE_SEND_WINDOW_MS;
      if (m.state !== 'inflight' && now - m.at > ttl) this.recentSends.delete(k);
      if (this.recentSends.size <= 500) break;
    }
  }

  /**
   * File a sent message into the Sent folder, best effort. SMTP already
   * succeeded: an APPEND failure is logged as a warning and never surfaces as
   * a failed send - the mail went out either way.
   *
   * The raw message is composed locally via MailComposer — the SMTP transport
   * does not return it (only json/stream transports set `info.message`).
   */
  private fileToSent(accountName: string, mailOptions: Record<string, unknown>): void {
    // The send already worked: nothing here may throw back into it.
    let wanted = true;
    try {
      wanted = SmtpService.appendsSent(this.connections.getAccount(accountName));
    } catch {
      // Unknown account: the APPEND below fails on its own and is logged.
    }
    if (!wanted) return;
    const filing = (async () => {
      try {
        const { default: MailComposer } = await import('nodemailer/lib/mail-composer/index.js');
        const composer = new MailComposer(mailOptions as never);
        const raw = await composer.compile().build();
        const res = await this.imapService.appendSent(accountName, raw);
        if (!res.appended) {
          mcpLog('debug', 'smtp', `No Sent folder found for "${accountName}"; copy not filed`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        mcpLog('warning', 'smtp', `Sent-folder filing failed for "${accountName}": ${reason}`);
      }
    })();
    this.pendingSentFilings.add(filing);
    void filing.then(
      () => this.pendingSentFilings.delete(filing),
      () => this.pendingSentFilings.delete(filing),
    );
  }

  /**
   * Whether this app files the Sent copy. Gmail files every message sent
   * through its SMTP server in Sent on its own, so a copy from here is a
   * duplicate there. `append_sent` in the account settles it either way.
   */
  static appendsSent(account: Pick<AccountConfig, 'appendSent' | 'smtp'>): boolean {
    if (account.appendSent !== undefined) return account.appendSent;
    return !SMTP_HOSTS_THAT_FILE_SENT.has((account.smtp?.host ?? '').trim().toLowerCase());
  }

  /** Wait for best-effort Sent-folder copies before a one-shot CLI closes connections. */
  async waitForSentFilings(): Promise<void> {
    await Promise.all(this.pendingSentFilings);
  }

  /**
   * Send through the pooled transport, and on failure evict it. A pooled SMTP
   * socket that died between messages would otherwise be handed to every
   * later send: only a health check ever re-verified the cache, so the send
   * path wedged until restart. Evicting lets the next call dial fresh.
   */
  private async sendWithRecovery(
    accountName: string,
    transport: Transporter,
    payload: Record<string, unknown>,
  ): Promise<{ messageId?: string; message?: Buffer }> {
    try {
      return (await transport.sendMail(payload as never)) as {
        messageId?: string;
        message?: Buffer;
      };
    } catch (err) {
      // A refused recipient or a server reply leaves the pool fine; closing it
      // would fail other sends queued behind this one for no reason.
      if (!leavesTransportHealthy(err)) this.connections.invalidateSmtpTransport(accountName);
      // A refused login can quote the password or token the server was sent.
      const safe = redactedError(err, sentCredentials(this.connections.getAccount(accountName)));
      if (isDefiniteRefusal(err)) throw safe;
      throw new UncertainSendError(safe.message);
    }
  }

  // -------------------------------------------------------------------------
  // Send draft
  // -------------------------------------------------------------------------

  async sendDraft(
    accountName: string,
    draftId: number,
    mailbox?: string,
    allowDuplicate?: boolean,
  ): Promise<SendResult> {
    const key = `${accountName}|draft|${mailbox ?? ''}|${draftId}`;
    const { result, draftsPath } = await this.guardedSend(key, allowDuplicate, async () => {
      this.checkRateLimit(accountName);

      const composed = await this.composeDraft(accountName, draftId, mailbox);
      const transport = await this.connections.getSmtpTransport(accountName);

      const sent = await this.sendWithRecovery(accountName, transport, composed.mailOptions);
      this.fileToSent(accountName, composed.mailOptions);
      return { result: sent, draftsPath: composed.draftsPath };
    });

    // The mail is out. Tidying the draft is best effort: a failure here must
    // not look like a failed send, because the caller would send it again.
    let warnings: string[] = [];
    try {
      // The sent draft goes to Trash, never a plain permanent delete.
      warnings = await this.imapService.trashDraft(accountName, draftId, draftsPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings = [
        `The email was sent, but the draft could not be moved to Trash (${reason}). Delete draft ${draftId} yourself so it is not sent twice.`,
      ];
    }

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /** Everything `sendDraft` checks and builds, without sending, deleting the draft or using up a send. */
  async previewSendDraft(
    accountName: string,
    draftId: number,
    mailbox?: string,
    allowDuplicate?: boolean,
  ): Promise<DryRunPlan> {
    this.assertRateLimitAvailable(accountName);
    this.peekDuplicate(`${accountName}|draft|${mailbox ?? ''}|${draftId}`, allowDuplicate);
    const { mailOptions, draftsPath } = await this.composeDraft(accountName, draftId, mailbox);
    if (!mailOptions.to && !mailOptions.cc && !mailOptions.bcc) {
      throw new Error(`Draft ${draftId} has no recipients. Add some before sending it.`);
    }
    const plan = SmtpService.describeMail('send this draft', mailOptions, true);
    plan.notes.push(`The draft would then be moved from "${draftsPath}" to Trash.`);
    return plan;
  }

  private async composeDraft(
    accountName: string,
    draftId: number,
    mailbox?: string,
  ): Promise<{ mailOptions: Record<string, unknown>; draftsPath: string }> {
    // Fetch the draft via IMAP
    const { email: draft, mailbox: draftsPath } = await this.imapService.fetchDraft(
      accountName,
      draftId,
      mailbox,
    );

    const account = this.connections.getAccount(accountName);

    const to = draft.to.map((a) => a.address).join(', ');
    const cc = draft.cc?.map((a) => a.address).join(', ');
    const bcc = draft.bcc?.map((a) => a.address).join(', ');

    // A draft saved with attachments must send with them. The draft's own
    // UID addresses its parts in the Drafts mailbox.
    const draftAttachments = await this.imapService.fetchMessageAttachments(
      accountName,
      String(draftId),
      draftsPath,
      this.sendLimitMb(account) * 1024 * 1024,
    );

    const mailOptions = {
      from: account.fullName ? { name: account.fullName, address: account.email } : account.email,
      to,
      cc,
      bcc,
      subject: draft.subject,
      messageId: `<${crypto.randomUUID()}@${account.email.split('@')[1]}>`,
      inReplyTo: draft.inReplyTo,
      references: draft.references?.join(' '),
      ...(draft.bodyHtml ? { html: draft.bodyHtml } : { text: draft.bodyText ?? '' }),
      ...(draftAttachments.length > 0 ? { attachments: draftAttachments } : {}),
      disableFileAccess: true,
      disableUrlAccess: true,
    };
    return { mailOptions, draftsPath };
  }
}
