/**
 * IMAP IDLE Watcher — real-time email monitoring.
 *
 * Maintains dedicated IMAP connections per account using IDLE to detect
 * new emails in real-time. Emits events on the shared event bus.
 *
 * Key design decisions:
 * - Separate ImapFlow connections from ConnectionManager (IDLE holds lock)
 * - Auto-reconnect with exponential backoff on connection failures
 * - Tracks last-seen UID per folder to detect genuinely new messages
 */

import type { ImapFlow } from 'imapflow';
import { redactedError, sentCredentials } from '../connections/credential-redaction.js';
import { mcpLog } from '../logging.js';
import type { AccountConfig, EmailMeta, WatcherConfig } from '../types/index.js';
import { BULK_HEADER_FIELDS } from '../utils/bulk-headers.js';
import { createImapClient, imapClientOptions } from '../utils/imap-client.js';
import eventBus from './event-bus.js';
import { messageToEmailMeta, safeDate } from './imap.service.js';
import type OAuthService from './oauth.service.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface IdleState {
  client: ImapFlow | null;
  account: AccountConfig;
  folder: string;
  lastSeenUid: number;
  /** UIDVALIDITY lastSeenUid belongs to; a change means the folder was renumbered. */
  uidValidity?: string;
  lock: { release: () => void } | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  stopped: boolean;
  /** New-mail fetches run one at a time, so a catch-up and an EXISTS never report the same mail twice. */
  fetchQueue?: Promise<void>;
}

export interface WatcherStatus {
  account: string;
  folder: string;
  connected: boolean;
  lastSeenUid: number;
}

// ---------------------------------------------------------------------------
// WatcherService
// ---------------------------------------------------------------------------

const MAX_BACKOFF_MS = 60_000;
const INITIAL_BACKOFF_MS = 1_000;

/**
 * After a reconnect, mail that arrived while the watcher was away is handled
 * if it is newer than this; older mail is skipped with a log line, so a long
 * sleep does not set off a week of forwards (owner decision: about an hour).
 */
export const CATCH_UP_WINDOW_MS = 60 * 60 * 1000;

/** Close a client this watcher no longer wants, without letting it throw. */
function closeQuietly(client: ImapFlow): void {
  try {
    client.close();
  } catch {
    /* ignore */
  }
}

export default class WatcherService {
  private idleStates = new Map<string, IdleState>();

  private config: WatcherConfig;

  private accounts: AccountConfig[];

  private oauthService?: OAuthService;

  constructor(config: WatcherConfig, accounts: AccountConfig[], oauthService?: OAuthService) {
    this.config = config;
    this.accounts = accounts;
    this.oauthService = oauthService;
  }

  async start(): Promise<void> {
    if (!this.config.enabled) return;

    const { folders } = this.config;
    const startOps: Promise<void>[] = [];
    this.accounts.forEach((account) => {
      folders.forEach((folder) => {
        startOps.push(this.startIdle(account, folder));
      });
    });
    await Promise.allSettled(startOps);
  }

  async stop(): Promise<void> {
    const stopOps = [...this.idleStates.values()].map(async (state) => {
      this.updateState(WatcherService.stateKey(state), { stopped: true });
      if (state.reconnectTimer) clearTimeout(state.reconnectTimer);
      try {
        state.lock?.release();
        if (state.client) await state.client.logout();
      } catch {
        /* ignore */
      }
    });
    await Promise.allSettled(stopOps);
    this.idleStates.clear();
  }

  /** Whether the config turns the watcher on (it may still run in another process). */
  isEnabled(): boolean {
    return this.config.enabled;
  }

  getStatus(): WatcherStatus[] {
    return [...this.idleStates.values()].map((state) => ({
      account: state.account.name,
      folder: state.folder,
      connected: state.client?.usable === true,
      lastSeenUid: state.lastSeenUid,
    }));
  }

  // -------------------------------------------------------------------------
  // State helpers (avoid param reassignment)
  // -------------------------------------------------------------------------

  private static stateKey(state: IdleState): string {
    return `${state.account.name}:${state.folder}`;
  }

  private updateState(key: string, updates: Partial<IdleState>): void {
    const state = this.idleStates.get(key);
    if (state) Object.assign(state, updates);
  }

  // -------------------------------------------------------------------------
  // IDLE connection lifecycle
  // -------------------------------------------------------------------------

  private async startIdle(account: AccountConfig, folder: string): Promise<void> {
    const key = `${account.name}:${folder}`;
    this.idleStates.set(key, {
      client: null,
      account,
      folder,
      lastSeenUid: 0,
      lock: null,
      reconnectTimer: null,
      backoffMs: INITIAL_BACKOFF_MS,
      stopped: false,
    });
    await this.connectIdle(key);
  }

  private async connectIdle(key: string): Promise<void> {
    const state = this.idleStates.get(key);
    if (!state || state.stopped) return;
    // stop() (and a later start()) replace or drop this state object; an
    // attempt that outlives its state must not install its client anywhere.
    const live = (): boolean => this.idleStates.get(key) === state && !state.stopped;

    let client: ImapFlow | undefined;
    try {
      let auth: { user: string; pass?: string; accessToken?: string };
      if (state.account.oauth2 && this.oauthService) {
        const accessToken = await this.oauthService.getAccessToken(state.account.oauth2);
        auth = { user: state.account.username, accessToken };
      } else if (state.account.oauth2) {
        throw new Error(`OAuth2 account ${state.account.name} requires OAuthService`);
      } else {
        auth = { user: state.account.username, pass: state.account.password };
      }
      if (!live()) return;

      const created = createImapClient(
        imapClientOptions(state.account, auth, {
          maxIdleTime: this.config.idleTimeout * 1000,
        }),
      );
      client = created;

      // Listeners go on BEFORE connect(): ImapFlow emits 'error' on a client
      // that is mid-handshake or that never got its folder open, and an
      // 'error' with no listener ends the whole process.
      created.on('error', () => {
        // Followed by 'close', which decides what happens next.
      });
      created.on('close', () => {
        // Only the client the state holds reconnects. A client still being
        // set up is handled by the catch below; one already replaced is moot.
        if (state.client !== created) return;
        this.updateState(key, { lock: null, client: null });
        if (live()) this.scheduleReconnect(key);
      });

      await created.connect();
      if (!live()) {
        closeQuietly(created);
        return;
      }

      const lock = await created.getMailboxLock(state.folder);
      if (!live()) {
        lock.release();
        closeQuietly(created);
        return;
      }
      const { mailbox } = created;
      const opened =
        mailbox && typeof mailbox === 'object'
          ? (mailbox as { uidNext?: number; uidValidity?: bigint | number })
          : {};
      const uidNext = opened.uidNext ?? 1;
      const uidValidity = opened.uidValidity?.toString();

      // Keep the place across reconnects so mail that arrived in the gap is
      // still seen. Start from "now" only on the first connect, or when the
      // folder was renumbered and the old place means nothing.
      const resume =
        state.lastSeenUid > 0 && uidValidity !== undefined && uidValidity === state.uidValidity;
      const lastSeenUid = resume ? state.lastSeenUid : uidNext - 1;

      this.updateState(key, {
        client: created,
        lock,
        lastSeenUid,
        uidValidity,
        backoffMs: INITIAL_BACKOFF_MS,
      });

      // Listen for new messages
      created.on('exists', (data: { path: string; count: number; prevCount: number }) => {
        if (data.count > data.prevCount) {
          this.handleNewEmails(key).catch(() => {});
        }
      });

      // Messages removed — by us or by another client. Republished so caches
      // and subscribers can drop the message rather than serving a deleted one.
      created.on('expunge', (data) => {
        eventBus.emit('email:expunge', {
          account: state.account.name,
          mailbox: state.folder,
          uid: data.uid,
          seq: data.seq,
        });
      });

      // Flag changes are the most common out-of-band mutation: marking a
      // message read in a phone client must not leave this process convinced
      // it is still unread.
      created.on('flags', (data) => {
        eventBus.emit('email:flags', {
          account: state.account.name,
          mailbox: state.folder,
          uid: data.uid,
          seq: data.seq,
          flags: [...data.flags],
        });
      });

      await mcpLog(
        'info',
        'watcher',
        `IDLE started: ${state.account.name}/${state.folder} (uid > ${lastSeenUid})`,
      );

      if (resume && uidNext - 1 > lastSeenUid) {
        // Mail arrived while the watcher was away: catch up on what is recent.
        await this.handleNewEmails(key, { notBefore: Date.now() - CATCH_UP_WINDOW_MS });
      }
    } catch (err) {
      // A client that connected but never became the watched one is closed
      // here, or it stays logged in, leaks, and later crashes the process
      // when its socket times out.
      if (client) {
        if (state.client === client) this.updateState(key, { lock: null, client: null });
        closeQuietly(client);
      }
      const errMsg = redactedError(err, sentCredentials(state.account)).message;
      await mcpLog(
        'warning',
        'watcher',
        `IDLE connect failed for ${state.account.name}/${state.folder}: ${errMsg}`,
      );
      if (live()) this.scheduleReconnect(key);
    }
  }

  private scheduleReconnect(key: string): void {
    const state = this.idleStates.get(key);
    if (!state || state.stopped) return;

    const { backoffMs } = state;
    mcpLog(
      'info',
      'watcher',
      `Reconnecting ${state.account.name}/${state.folder} in ${backoffMs}ms`,
    ).catch(() => {});

    const timer = setTimeout(() => {
      this.updateState(key, { backoffMs: Math.min(backoffMs * 2, MAX_BACKOFF_MS) });
      this.connectIdle(key).catch(() => {});
    }, backoffMs);

    this.updateState(key, { reconnectTimer: timer });
  }

  // -------------------------------------------------------------------------
  // New email detection
  // -------------------------------------------------------------------------

  /**
   * Hand every message after lastSeenUid to the bus, and move lastSeenUid past
   * each one even if it cannot be read, so one bad message never stalls the
   * watcher. With `notBefore` (a catch-up after a reconnect), messages that
   * arrived before that time are skipped and counted in the log instead.
   */
  private handleNewEmails(key: string, options: { notBefore?: number } = {}): Promise<void> {
    const state = this.idleStates.get(key);
    if (!state) return Promise.resolve();
    const next = (state.fetchQueue ?? Promise.resolve()).then(() =>
      this.fetchNewEmails(key, options),
    );
    state.fetchQueue = next.catch(() => {});
    return next;
  }

  private async fetchNewEmails(key: string, options: { notBefore?: number }): Promise<void> {
    const state = this.idleStates.get(key);
    if (!state?.client) return;

    try {
      const searchRange = `${state.lastSeenUid + 1}:*`;
      const emails: EmailMeta[] = [];
      let maxUid = state.lastSeenUid;
      let skipped = 0;
      let unreadable = 0;

      // eslint-disable-next-line no-restricted-syntax -- need sequential async iteration
      for await (const msg of state.client.fetch(
        searchRange,
        {
          uid: true,
          envelope: true,
          flags: true,
          bodyStructure: true,
          internalDate: true,
          headers: BULK_HEADER_FIELDS,
        },
        // Third arg is what makes `searchRange` a UID range. The `uid` in the
        // query above only asks for the UID to be included in the response.
        { uid: true },
      )) {
        if (msg.uid <= state.lastSeenUid) continue;
        maxUid = Math.max(maxUid, msg.uid);
        if (options.notBefore !== undefined) {
          const arrived = safeDate((msg as { internalDate?: unknown }).internalDate);
          if (arrived && arrived.getTime() < options.notBefore) {
            skipped += 1;
            continue;
          }
        }
        try {
          emails.push(messageToEmailMeta(msg as unknown as Record<string, unknown>));
        } catch {
          unreadable += 1;
        }
      }

      if (maxUid > state.lastSeenUid) {
        this.updateState(key, { lastSeenUid: maxUid });
      }

      if (skipped > 0) {
        await mcpLog(
          'info',
          'watcher',
          `Skipped ${skipped} message(s) in ${state.account.name}/${state.folder} that arrived more than an hour before the watcher reconnected; rules and alerts did not run on them.`,
        );
      }
      if (unreadable > 0) {
        await mcpLog(
          'warning',
          'watcher',
          `${unreadable} new message(s) in ${state.account.name}/${state.folder} could not be read and were passed over.`,
        );
      }

      if (emails.length > 0) {
        eventBus.emit('email:new', {
          account: state.account.name,
          mailbox: state.folder,
          emails,
        });

        await mcpLog(
          'info',
          'watcher',
          `📬 ${emails.length} new email(s) in ${state.account.name}/${state.folder}`,
        );
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      await mcpLog('warning', 'watcher', `Failed to fetch new emails: ${errMsg}`);
    }
  }
}
