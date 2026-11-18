/**
 * A move, delete or flag change cut off by a dropped connection may already
 * have been done by the server. Saying only "failed" invites a blind retry.
 */

import registerBulkTools from './bulk.tool.js';
import registerManageTools from './manage.tool.js';

type Result = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function handlersFor(imap: Record<string, unknown>) {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _cfg: unknown, h: Handler) => {
      handlers.set(name, h);
    },
  } as never;
  registerManageTools(server, imap as never);
  registerBulkTools(server, imap as never);
  return handlers;
}

const dropped = () =>
  Object.assign(new Error('Connection not available'), { code: 'NoConnection' });

describe('write tools cut off by a dropped connection', () => {
  it('move_email says the move may have happened', async () => {
    const result = await handlersFor({ moveEmail: vi.fn().mockRejectedValue(dropped()) }).get(
      'move_email',
    )?.({ account: 'a', emailId: '5', sourceMailbox: 'INBOX', destinationMailbox: 'Archive' });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toMatch(/may or may not have done it/);
  });

  it('delete_email and mark_email say the same', async () => {
    const handlers = handlersFor({
      deleteEmail: vi.fn().mockRejectedValue(dropped()),
      setFlags: vi.fn().mockRejectedValue(dropped()),
    });
    const deleted = await handlers.get('delete_email')?.({
      account: 'a',
      emailId: '5',
      mailbox: 'INBOX',
      permanent: false,
    });
    const marked = await handlers.get('mark_email')?.({
      account: 'a',
      id: '5',
      mailbox: 'INBOX',
      action: 'read',
    });
    expect(deleted?.content[0].text).toMatch(/may or may not have done it/);
    expect(marked?.content[0].text).toMatch(/may or may not have done it/);
  });

  it('a refusal from a reachable server gets no such note', async () => {
    const result = await handlersFor({
      moveEmail: vi.fn().mockRejectedValue(new Error('Mailbox "Archive" does not exist')),
    }).get('move_email')?.({
      account: 'a',
      emailId: '5',
      sourceMailbox: 'INBOX',
      destinationMailbox: 'Archive',
    });
    expect(result?.content[0].text).not.toMatch(/may or may not/);
  });
});
