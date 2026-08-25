/**
 * Connection manager for lazy-persistent IMAP and SMTP connections.
 *
 * - Creates connections on first use per account
 * - Reuses open connections across tool calls
 * - Auto-reconnects on failure
 * - Graceful shutdown closes all connections
 */

import { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import nodemailer from 'nodemailer';
import { mcpLog } from '../logging.js';

import eventBus from '../services/event-bus.js';
import type OAuthService from '../services/oauth.service.js';
import type { AccountConfig } from '../types/index.js';
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
 * @param onDead runs on error or close, for callers that pool the client and
 *   need to evict it. Short-lived clients pass nothing.
 */
function attachImapLifecycleHandlers(client: ImapFlow, label: string, onDead?: () => void): void {
  const handleDead = (reason: string) => {
    // Logging must never throw from inside an error handler.
    mcpLog('warning', 'imap', `IMAP connection lost for "${label}": ${reason}`).catch(() => {
      /* swallow */
    });
    onDead?.();
  };

  client.on('error', (err: unknown) => {
    handleDead(err instanceof Error ? err.message : String(err));
  });

  client.on('close', () => {
    onDead?.();
  });
}

export default class ConnectionManager implements IConnectionManager {
  private imapClients = new Map<string, ImapFlow>();

  private smtpTransports = new Map<string, Transporter>();

  private accounts = new Map<string, AccountConfig>();

  private oauthService?: OAuthService;

  constructor(accounts: AccountConfig[], oauthService?: OAuthService) {
    accounts.forEach((account) => {
      this.accounts.set(account.name, account);
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

  private imapPending = new Map<string, Promise<ImapFlow>>();
  private smtpPending = new Map<string, Promise<Transporter>>();

  // -------------------------------------------------------------------------
  // IMAP
  // -------------------------------------------------------------------------

  async getImapClient(accountName: string): Promise<ImapFlow> {
    const pending = this.imapPending.get(accountName);
    if (pending) return pending;

    const existing = this.imapClients.get(accountName);
    if (existing?.usable) {
      return existing;
    }

    // Clean up stale connection
    if (existing) {
      this.imapClients.delete(accountName);
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

      const client = new ImapFlow({
        host: account.imap.host,
        port: account.imap.port,
        secure: account.imap.tls,
        tls: {
          rejectUnauthorized: account.imap.verifySsl,
        },
        auth,
        logger: false,
        ...(account.imap.starttls ? { doSTARTTLS: true as const } : {}),
      });

      // Evict only if this exact client is still the pooled one. A newer client
      // may already have replaced it, and deleting unconditionally would drop a
      // live connection.
      attachImapLifecycleHandlers(client, accountName, () => {
        if (this.imapClients.get(accountName) === client) {
          this.imapClients.delete(accountName);
        }
      });

      await client.connect();
      await mcpLog(
        'info',
        'imap',
        `Connected to ${account.imap.host}:${account.imap.port} for "${accountName}"`,
      );
      this.imapClients.set(accountName, client);
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
  ): nodemailer.TransportOptions {
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
    } as nodemailer.TransportOptions;
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

      await transport.verify();
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

      client = new ImapFlow({
        host: account.imap.host,
        port: account.imap.port,
        secure: account.imap.tls,
        tls: {
          rejectUnauthorized: account.imap.verifySsl,
        },
        auth,
        logger: false,
      });

      // Not pooled, so nothing to evict — but the listener still has to exist
      // or a mid-probe socket error crashes the process during setup.
      attachImapLifecycleHandlers(client, account.name);

      await client.connect();

      const mailboxes = await client.list();
      let messageCount = 0;
      try {
        const inbox = await client.status('INBOX', {
          messages: true,
          unseen: true,
        });
        messageCount = inbox.messages ?? 0;
      } catch {
        // INBOX may not exist (e.g. Google Workspace uses "All Mail")
        if (mailboxes.length > 0) {
          try {
            const first = await client.status(mailboxes[0].path, {
              messages: true,
            });
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
        error: err instanceof Error ? err.message : String(err),
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
        error: err instanceof Error ? err.message : String(err),
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
