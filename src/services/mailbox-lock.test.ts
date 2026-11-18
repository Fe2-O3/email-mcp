import type { ImapFlow } from 'imapflow';

import lockMailbox, { MAILBOX_LOCK_TIMEOUT_MS } from './mailbox-lock.js';

/** A client whose lock queue is stuck: it honours acquireTimeout the way imapflow does. */
function stuckClient() {
  return {
    close: vi.fn(),
    getMailboxLock: vi.fn(
      (_path: string, opts: { acquireTimeout?: number }) =>
        new Promise((_resolve, reject) => {
          setTimeout(
            () =>
              reject(
                Object.assign(new Error('Timed out waiting for mailbox lock'), {
                  code: 'LockTimeout',
                }),
              ),
            opts.acquireTimeout,
          );
        }),
    ),
  };
}

describe('lockMailbox', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('passes a bounded acquireTimeout to imapflow', async () => {
    const lock = { release: vi.fn() };
    const client = { getMailboxLock: vi.fn().mockResolvedValue(lock), close: vi.fn() };
    await expect(lockMailbox(client as unknown as ImapFlow, 'INBOX')).resolves.toBe(lock);
    expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX', {
      acquireTimeout: MAILBOX_LOCK_TIMEOUT_MS,
    });
  });

  it('keeps waiting until the limit, then throws a clear error and drops the connection', async () => {
    const client = stuckClient();
    const settled = vi.fn();
    const result = lockMailbox(client as unknown as ImapFlow, 'INBOX').catch((e: Error) => {
      settled();
      return e;
    });

    await vi.advanceTimersByTimeAsync(MAILBOX_LOCK_TIMEOUT_MS - 1);
    expect(settled).not.toHaveBeenCalled();
    expect(client.close).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    const err = (await result) as Error;
    expect(err.message).toMatch(/Mailbox "INBOX" stayed busy for 60 s/);
    expect(err.message).toMatch(/try again/);
    expect(client.close).toHaveBeenCalledTimes(1);
  });

  it('does not drop the connection for other errors', async () => {
    const boom = new Error('NO [NONEXISTENT] no such mailbox');
    const client = { close: vi.fn(), getMailboxLock: vi.fn().mockRejectedValue(boom) };
    await expect(lockMailbox(client as unknown as ImapFlow, 'X')).rejects.toBe(boom);
    expect(client.close).not.toHaveBeenCalled();
  });

  it('survives a close() that throws', async () => {
    const client = stuckClient();
    client.close.mockImplementation(() => {
      throw new Error('already closed');
    });
    const result = lockMailbox(client as unknown as ImapFlow, 'INBOX').catch((e: Error) => e);
    await vi.advanceTimersByTimeAsync(MAILBOX_LOCK_TIMEOUT_MS);
    expect(((await result) as Error).message).toMatch(/stayed busy/);
  });
});
