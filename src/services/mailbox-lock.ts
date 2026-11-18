// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * Bounded wait for an imapflow mailbox lock.
 *
 * imapflow runs one command at a time per connection and queues lock requests with no limit. A
 * command the server never answers holds the queue until the socket times out (300 s by
 * default), and every later tool call on that account waits behind it. A bounded wait turns that
 * into an error the caller sees and can retry.
 *
 * The bound covers the whole wait: the time in imapflow's queue and the SELECT that opens the
 * mailbox once the lock leaves it, which imapflow's own acquire timer no longer covers.
 *
 * When the wait runs out, the connection is usually closed. The command at the head of its queue is
 * the one that is stuck, and the connection cannot get past it; closing it lets the connection
 * manager dial a fresh one on the next call instead of handing the same stuck client out again.
 * Two cases keep the connection: the lock is held by the background mirror sync, which works in
 * short chunks and is not stuck, and the caller is that sync, which has nothing to gain from
 * cutting off a tool call.
 */

import type { ImapFlow, MailboxLockObject } from 'imapflow';

/** No single command on a healthy server takes this long; MCP clients often drop a request near it. */
export const MAILBOX_LOCK_TIMEOUT_MS = 60_000;

/**
 * A background holder past this is treated as stuck after all. One sync chunk on a healthy
 * server takes seconds.
 */
const BACKGROUND_STUCK_MS = 2 * MAILBOX_LOCK_TIMEOUT_MS;

/** Connections whose current lock is the background sync's, with the time it was granted. */
const backgroundHolders = new WeakMap<ImapFlow, number>();

export interface LockMailboxOptions {
  readOnly?: boolean;
  /** The caller is the background mirror sync, not a tool call. */
  background?: boolean;
}

class LockWaitTimeout extends Error {}

function heldByBackground(client: ImapFlow): boolean {
  const since = backgroundHolders.get(client);
  return since !== undefined && Date.now() - since < BACKGROUND_STUCK_MS;
}

export default async function lockMailbox(
  client: ImapFlow,
  path: string,
  options: LockMailboxOptions = {},
): Promise<MailboxLockObject> {
  const { background = false, ...lockOptions } = options;
  const acquiring = client.getMailboxLock(path, {
    ...lockOptions,
    acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new LockWaitTimeout()), MAILBOX_LOCK_TIMEOUT_MS);
  });

  let lock: MailboxLockObject;
  try {
    lock = await Promise.race([acquiring, deadline]);
  } catch (err) {
    const timedOut =
      err instanceof LockWaitTimeout || (err as { code?: unknown }).code === 'LockTimeout';
    if (!timedOut) throw err;
    // A lock granted after this caller gave up must go back, or nobody can lock the mailbox again.
    acquiring.then(
      (late) => late.release(),
      () => undefined,
    );
    const syncHolds = heldByBackground(client);
    if (!background && !syncHolds) {
      try {
        client.close();
      } catch {
        // Already gone; the next getImapClient call sees an unusable client either way.
      }
    }
    if (syncHolds) {
      throw new Error(
        `Mailbox "${path}" stayed busy for ${MAILBOX_LOCK_TIMEOUT_MS / 1000} s: the background mirror sync is still reading it. Try again in a moment.`,
        { cause: err },
      );
    }
    throw new Error(
      `Mailbox "${path}" stayed busy for ${MAILBOX_LOCK_TIMEOUT_MS / 1000} s: an earlier operation on this account has not finished.${
        background ? ' Try again.' : ' The connection was dropped; try again.'
      }`,
      { cause: err },
    );
  } finally {
    clearTimeout(timer);
  }

  if (!background) return lock;
  backgroundHolders.set(client, Date.now());
  return {
    ...lock,
    release: () => {
      backgroundHolders.delete(client);
      lock.release();
    },
  };
}
