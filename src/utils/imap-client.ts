/**
 * Constructing ImapFlow clients with the upstream TLS SNI fallback repaired.
 *
 * Ported from codefuturist/email-mcp v0.5.1 (commit 70d4215).
 */

import { ImapFlow } from 'imapflow';

type ImapClientOptions = ConstructorParameters<typeof ImapFlow>[0];

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
