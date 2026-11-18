/**
 * Connection manager for lazy-persistent IMAP and SMTP connections.
 *
 * - Creates connections on first use per account
 * - Reuses open connections across tool calls
 * - Auto-reconnects on failure
 * - Graceful shutdown closes all connections
 */

import type { ImapFlow } from 'imapflow';
import type { TransportConfig, Transporter } from 'nodemailer';
import nodemailer from 'nodemailer';
import { mcpLog } from '../logging.js';

import eventBus from '../services/event-bus.js';
import type OAuthService from '../services/oauth.service.js';
import type { AccountConfig } from '../types/index.js';
import { createImapClient, imapClientOptions } from '../utils/imap-client.js';
import { redactedError, registerKnownSecrets, sentCredentials } from './credential-redaction.js';
import type { IConnectionManager } from './types.js';

type SmtpAuth =
  | { user: string; pass?: string }
  | { type: string; user: string; accessToken: string };

/**
 * Attach `error`/`close` listeners to an ImapFlow client.
 *
 * ImapFlow extends EventEmitter. An `error` event with no registered listener
 * is, in Node, an uncaughtException — it takes the whole process down. Hosted
 * IMAP providers routinely drop sessions after ~29 minutes of inactivity, so a
 * long-lived MCP server reliably hits this. Because clients are constructed
 * with `logger: false`, the crash leaves no trace: the server just vanishes and
 * the MCP client reports its tools as disconnected for no visible reason.
 *
 * Listeners are attached BEFORE `connect()`, because a TLS or auth failure can
 * emit during the connect handshake itself.
 *
 * @param account the account the client belongs to; its secrets are scrubbed from logged errors
 * @param onDead runs on error or close, for callers that pool the client and
 *   need to evict it. Short-lived clients pass nothing.
 */
function attachImapLifecycleHandlers(
  client: ImapFlow,
  account: AccountConfig,
  onDead?: () => void,
): void {
  const label = account.name;
  const handleDead = (reason: string) => {
    // Logging must never throw from inside an error handler.
    mcpLog('warning', 'imap', `IMAP connection lost for "${label}": ${reason}`).catch(() => {
      /* swallow */
    });
    onDead?.();
  };

  client.on('error', (err: unknown) => {
    // The server's error text can quote the login; scrub it before it is logged.
    handleDead(redactedError(err, sentCredentials(account)).message);
  });

  client.on('close', () => {
    onDead?.();
  });
}

export default class ConnectionManager implements IConnectionManager {
  private imapClients = new Map<string, ImapFlow>();

  private imapClientCreatedAt = new Map<string, number>();

  private smtpTransports = new Map<string, Transporter>();

  private accounts = new Map<string, AccountConfig>();

  private oauthService?: OAuthService;

  /** Connections older than this are closed and recreated on next use. */
  private static readonly CONNECTION_MAX_AGE_MS = 30 * 60 * 1000; // 30 minutes

  constructor(accounts: AccountConfig[], oauthService?: OAuthService) {
    accounts.forEach((account) => {
      this.accounts.set(account.name, account);
      registerKnownSecrets(account);
    });
    this.oauthService = oauthService;
  }

  // -------------------------------------------------------------------------
  // Account lookup
  // -------------------------------------------------------------------------

  getAccount(name: string): AccountConfig {
    const account = this.accounts.get(name);
    if (!account) {
      throw new Error(
        `Account "${name}" not found. Available: ${[...this.accounts.keys()].join(', ')}`,
      );
    }
    return account;
  }

  getAccountNames(): string[] {
    return [...this.accounts.keys()];
  }

  /**
   * Whether nothing runs on, waits for or holds this client: no command, no
   * mailbox lock, no open download. imapflow keeps this check internal, so it
   * is read defensively; when it cannot be read the client counts as busy and
   * simply lives past its rotation age.
   */
  private static freeToClose(client: ImapFlow): boolean {
    const probe = (client as unknown as { freeToClose?: () => unknown }).freeToClose;
    if (typeof probe !== 'function') return false;
    try {
      return probe.call(client) === true;
    } catch {
      return false;
    }
  }

  private imapPending = new Map<string, Promise<ImapFlow>>();
  private smtpPending = new Map<string, Promise<Transporter>>();

  // -------------------------------------------------------------------------
  // IMAP
  // -------------------------------------------------------------------------

  async getImapClient(accountName: string): Promise<ImapFlow> {
    const pending = this.imapPending.get(accountName);
    if (pending) return pending;

    const existing = this.imapClients.get(accountName);
    if (existing) {
      if (existing.usable) {
        const createdAt = this.imapClientCreatedAt.get(accountName) ?? 0;
        if (Date.now() - createdAt < ConnectionManager.CONNECTION_MAX_AGE_MS) {
          return existing;
        }
        // Rotation: open too long, buffers accumulate. Only when nothing is
        // using it: closing a client mid-download or mid-move would fail that
        // call, and a write cut off mid-command may or may not have happened.
        // The next call after it goes quiet rotates it.
        if (!ConnectionManager.freeToClose(existing)) return existing;
      }
      // Connection is stale (too old) or unusable — close and recreate below.
      this.imapClients.delete(accountName);
      this.imapClientCreatedAt.delete(accountName);
      try {
        existing.close();
      } catch {
        /* ignore */
      }
      // Announce the replacement. A new connection may be talking to a
      // different server, or to a mailbox that has been recreated since —
      // so capability probes, per-account memos and any cached UIDVALIDITY
      // derived from the old connection must be revalidated.
      eventBus.emit('imap:reconnect', { account: accountName });
    }

    const account = this.getAccount(accountName);

    const promise = (async () => {
      // Build auth config based on auth type
      let auth: { user: string; pass?: string; accessToken?: string };
      if (account.oauth2 && this.oauthService) {
        const accessToken = await this.oauthService.getAccessToken(account.oauth2);
        auth = { user: account.username, accessToken };
      } else {
        auth = { user: account.username, pass: account.password };
      }

      const client = createImapClient(imapClientOptions(account, auth));

      // Evict only if this exact client is still the pooled one. A newer client
      // may already have replaced it, and deleting unconditionally would drop a
      // live connection.
      attachImapLifecycleHandlers(client, account, () => {
        if (this.imapClients.get(accountName) === client) {
          this.imapClients.delete(accountName);
          this.imapClientCreatedAt.delete(accountName);
        }
      });

      try {
        await client.connect();
      } catch (err) {
        throw redactedError(err, sentCredentials(account));
      }
      await mcpLog(
        'info',
        'imap',
        `Connected to ${account.imap.host}:${account.imap.port} for "${accountName}"`,
      );
      this.imapClients.set(accountName, client);
      this.imapClientCreatedAt.set(accountName, Date.now());
      return client;
    })();

    this.imapPending.set(accountName, promise);
    try {
      return await promise;
    } finally {
      this.imapPending.delete(accountName);
    }
  }

  // -------------------------------------------------------------------------
  // SMTP
  // -------------------------------------------------------------------------

  private static buildSmtpTransportOptions(
    account: AccountConfig,
    auth: SmtpAuth,
  ): TransportConfig {
    const pool = account.smtp.pool ?? {
      enabled: true,
      maxConnections: 1,
      maxMessages: 100,
    };

    return {
      host: account.smtp.host,
      port: account.smtp.port,
      secure: account.smtp.tls,
      requireTLS: account.smtp.starttls,
      ignoreTLS: !account.smtp.tls && !account.smtp.starttls,
      tls: {
        rejectUnauthorized: account.smtp.verifySsl,
      },
      auth,
      pool: pool.enabled,
      ...(pool.enabled
        ? {
            maxConnections: pool.maxConnections,
            maxMessages: pool.maxMessages,
          }
        : {}),
    } as TransportConfig;
  }

  async getSmtpTransport(
    accountName: string,
    options?: { verify?: boolean },
  ): Promise<Transporter> {
    const pending = this.smtpPending.get(accountName);
    if (pending) return pending;

    const verify = options?.verify ?? false;
    const existing = this.smtpTransports.get(accountName);
    if (existing) {
      if (!verify) {
        return existing;
      }
      try {
        await existing.verify();
        return existing;
      } catch {
        this.smtpTransports.delete(accountName);
        try {
          existing.close();
        } catch {
          /* ignore */
        }
      }
    }

    const account = this.getAccount(accountName);

    const promise = (async () => {
      // Build auth config based on auth type
      let auth: SmtpAuth;
      if (account.oauth2 && this.oauthService) {
        const accessToken = await this.oauthService.getAccessToken(account.oauth2);
        auth = { type: 'OAuth2', user: account.username, accessToken };
      } else {
        auth = { user: account.username, pass: account.password };
      }

      const transport = nodemailer.createTransport(
        ConnectionManager.buildSmtpTransportOptions(account, auth),
      );

      try {
        await transport.verify();
      } catch (err) {
        transport.close();
        throw redactedError(err, sentCredentials(account));
      }
      await mcpLog(
        'info',
        'smtp',
        `Connected to ${account.smtp.host}:${account.smtp.port} for "${accountName}"`,
      );
      this.smtpTransports.set(accountName, transport);
      return transport;
    })();

    this.smtpPending.set(accountName, promise);
    try {
      return await promise;
    } finally {
      this.smtpPending.delete(accountName);
    }
  }

  /**
   * Drop the cached SMTP transport for an account. Called when a send fails:
   * a pooled socket that died between messages would otherwise be handed to
   * every later send forever, since only a health check re-verifies.
   */
  invalidateSmtpTransport(accountName: string): void {
    const existing = this.smtpTransports.get(accountName);
    if (!existing) return;
    this.smtpTransports.delete(accountName);
    try {
      existing.close();
    } catch {
      /* ignore */
    }
  }

  async verifySmtpTransport(accountName: string): Promise<void> {
    await this.getSmtpTransport(accountName, { verify: true });
  }

  // -------------------------------------------------------------------------
  // Test connections (for setup wizard / test command)
  // -------------------------------------------------------------------------

  static async testImap(
    account: AccountConfig,
    oauthService?: OAuthService,
  ): Promise<{
    success: boolean;
    error?: string;
    details?: { messages: number; folders: number };
  }> {
    let client: ImapFlow | undefined;
    try {
      let auth: { user: string; pass?: string; accessToken?: string };
      if (account.oauth2 && oauthService) {
        const accessToken = await oauthService.getAccessToken(account.oauth2);
        auth = { user: account.username, accessToken };
      } else {
        auth = { user: account.username, pass: account.password };
      }

      // Same options as the pool: a test that skipped STARTTLS would pass
      // against a server whose STARTTLS was stripped, and prove nothing.
      client = createImapClient(imapClientOptions(account, auth));

      // Not pooled, so nothing to evict — but the listener still has to exist
      // or a mid-probe socket error crashes the process during setup.
      attachImapLifecycleHandlers(client, account);

      await client.connect();

      const mailboxes = await client.list();
      let messageCount = 0;
      try {
        const inbox = await client.status('INBOX', {
          messages: true,
          unseen: true,
        });
        // imapflow 2 returns false (not a throw) when STATUS is unsupported —
        // treat it as the INBOX failure it is so the fallback below runs.
        if (inbox === false) throw new Error('INBOX STATUS unsupported');
        messageCount = inbox.messages ?? 0;
      } catch {
        // INBOX may not exist (e.g. Google Workspace uses "All Mail")
        if (mailboxes.length > 0) {
          try {
            const first = await client.status(mailboxes[0].path, {
              messages: true,
            });
            if (first === false) throw new Error('STATUS unsupported');
            messageCount = first.messages ?? 0;
          } catch {
            /* ignore — connection still works */
          }
        }
      }

      return {
        success: true,
        details: {
          messages: messageCount,
          folders: mailboxes.length,
        },
      };
    } catch (err) {
      return {
        success: false,
        error: redactedError(err, sentCredentials(account)).message,
      };
    } finally {
      if (client) {
        try {
          await client.logout();
        } catch {
          /* ignore */
        }
      }
    }
  }

  static async testSmtp(
    account: AccountConfig,
    oauthService?: OAuthService,
  ): Promise<{ success: boolean; error?: string }> {
    let transport: Transporter | undefined;
    try {
      let auth: SmtpAuth;
      if (account.oauth2 && oauthService) {
        const accessToken = await oauthService.getAccessToken(account.oauth2);
        auth = { type: 'OAuth2', user: account.username, accessToken };
      } else {
        auth = { user: account.username, pass: account.password };
      }

      transport = nodemailer.createTransport(
        ConnectionManager.buildSmtpTransportOptions(account, auth),
      );
      await transport.verify();
      return { success: true };
    } catch (err) {
      return {
        success: false,
        error: redactedError(err, sentCredentials(account)).message,
      };
    } finally {
      transport?.close();
    }
  }

  // -------------------------------------------------------------------------
  // Shutdown
  // -------------------------------------------------------------------------

  async closeAll(): Promise<void> {
    await mcpLog('info', 'connections', 'Closing all connections');
    const closeOps: Promise<void>[] = [];

    Array.from(this.imapClients.entries()).forEach(([name, client]) => {
      closeOps.push(
        client
          .logout()
          .catch(() => {})
          .then(() => {
            this.imapClients.delete(name);
            this.imapClientCreatedAt.delete(name);
          }),
      );
    });

    Array.from(this.smtpTransports.entries()).forEach(([name, transport]) => {
      transport.close();
      this.smtpTransports.delete(name);
    });

    await Promise.allSettled(closeOps);
  }
}
