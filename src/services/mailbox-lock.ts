// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * Bounded wait for an imapflow mailbox lock.
 *
 * imapflow runs one command at a time per connection and queues lock requests with no limit. A
 * command the server never answers holds the queue until the socket times out (300 s by
 * default), and every later tool call on that account waits behind it. A bounded wait turns that
 * into an error the caller sees and can retry.
 *
 * When the wait runs out, the connection is closed. The command at the head of its queue is the
 * one that is stuck, and the connection cannot get past it; closing it lets the connection
 * manager dial a fresh one on the next call instead of handing the same stuck client out again.
 */

import type { ImapFlow, MailboxLockObject } from 'imapflow';

/** No single command on a healthy server takes this long; MCP clients often drop a request near it. */
export const MAILBOX_LOCK_TIMEOUT_MS = 60_000;

export default async function lockMailbox(
  client: ImapFlow,
  path: string,
  options: { readOnly?: boolean } = {},
): Promise<MailboxLockObject> {
  try {
    return await client.getMailboxLock(path, {
      ...options,
      acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS,
    });
  } catch (err) {
    if ((err as { code?: unknown }).code === 'LockTimeout') {
      try {
        client.close();
      } catch {
        // Already gone; the next getImapClient call sees an unusable client either way.
      }
      throw new Error(
        `Mailbox "${path}" stayed busy for ${MAILBOX_LOCK_TIMEOUT_MS / 1000} s: an earlier operation on this account has not finished. The connection was dropped; try again.`,
        { cause: err },
      );
    }
    throw err;
  }
}
