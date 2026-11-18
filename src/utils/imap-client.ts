/**
 * Constructing ImapFlow clients with the upstream TLS SNI fallback repaired.
 *
 * Ported from codefuturist/email-mcp v0.5.1 (commit 70d4215).
 */

import { ImapFlow } from 'imapflow';
import assertCanLogIn from '../connections/login-guard.js';
import type { AccountConfig } from '../types/index.js';

type ImapClientOptions = NonNullable<ConstructorParameters<typeof ImapFlow>[0]>;

/**
 * imapflow's constructor falls back to `servername = false` when the host is
 * an IP literal, and node's tls.connect() rejects a non-string servername —
 * so every connection to an IP-literal IMAP host fails before authentication.
 * The repair is applied at runtime because a pnpm patch file would never
 * reach consumers who install this package differently. Drop once the fix
 * ships in an imapflow release.
 */
export function normalizeTlsServername(client: { servername?: string | false | undefined }): void {
  if (client.servername === false) {
    client.servername = undefined;
  }
}

/** Build an ImapFlow client; use this instead of calling `new ImapFlow` directly. */
export function createImapClient(options: ImapClientOptions): ImapFlow {
  const client = new ImapFlow(options);
  normalizeTlsServername(client as unknown as { servername?: string | false | undefined });
  return client;
}

/**
 * The connection options for an account, shared by the pooled client, the
 * IDLE watcher and the account test, so none of them can drift from the
 * others. With `starttls` set, `doSTARTTLS: true` makes ImapFlow refuse to
 * log in when the upgrade fails; without it, a server (or anyone on the path)
 * that hides STARTTLS gets the login in plain text.
 */
export function imapClientOptions(
  account: Pick<AccountConfig, 'imap'> & Partial<Pick<AccountConfig, 'name' | 'credentialError'>>,
  auth: ImapClientOptions['auth'],
  extra: Partial<ImapClientOptions> = {},
): ImapClientOptions {
  assertCanLogIn(account);
  return {
    host: account.imap.host,
    port: account.imap.port,
    secure: account.imap.tls,
    tls: { rejectUnauthorized: account.imap.verifySsl },
    auth,
    logger: false,
    ...(account.imap.starttls && !account.imap.tls ? { doSTARTTLS: true as const } : {}),
    ...extra,
  };
}
