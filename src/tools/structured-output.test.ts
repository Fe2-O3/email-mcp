/**
 * get_email, get_emails, get_thread and list_accounts return structuredContent that validates
 * against their declared outputSchema and carries the same data as the text.
 */

import type { z } from 'zod';

import { UNTRUSTED_BEGIN } from '../safety/untrusted-content.js';
import registerAccountsTools from './accounts.tool.js';
import registerEmailsTools from './emails.tool.js';
import registerThreadTools from './thread.tool.js';

type Result = { content: { text: string }[]; structuredContent?: unknown };
type Handler = (params: Record<string, unknown>) => Promise<Result>;
// biome-ignore lint/suspicious/noExplicitAny: the parsed shape differs per tool and is asserted below
type Parsed = Record<string, any>;
type Registered = { handler: Handler; outputSchema?: z.ZodType };

const email = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  messageId: `<${id}@example.test>`,
  subject: `Subject ${id}`,
  from: { name: 'Ann', address: 'ann@example.test' },
  to: [{ address: 'me@example.test' }],
  date: '2026-01-01T00:00:00Z',
  seen: true,
  flagged: false,
  answered: false,
  hasAttachments: true,
  labels: ['work'],
  attachments: [{ filename: 'a.pdf', mimeType: 'application/pdf', size: 10 }],
  bodyText: `Body of ${id}`,
  ...extra,
});

function setup() {
  const tools = new Map<string, Registered>();
  const server = {
    registerTool: vi.fn((name: string, meta: { outputSchema?: z.ZodType }, handler: Handler) => {
      tools.set(name, { handler, outputSchema: meta.outputSchema });
    }),
  };
  const imap = {
    getEmail: vi.fn(async (_a: string, id: string) => {
      if (id === 'bad') throw new Error('not found');
      return email(
        id,
        id === '1' ? { cc: [{ address: 'cc@example.test' }], inReplyTo: '<p@x>' } : {},
      );
    }),
    getThread: vi.fn().mockResolvedValue({
      threadId: 't1',
      messageCount: 2,
      participants: [{ address: 'ann@example.test' }],
      messages: [email('1'), email('2')],
    }),
  };
  const connections = {
    getAccountNames: () => ['work', 'home'],
    getAccount: (n: string) => ({
      name: n,
      email: `${n}@example.test`,
      fullName: n === 'work' ? 'W' : undefined,
    }),
  };
  registerEmailsTools(server as never, imap as never);
  registerThreadTools(server as never, imap as never);
  registerAccountsTools(server as never, connections as never);
  return tools;
}

describe('structuredContent of the read tools', () => {
  const tools = setup();
  const run = async (name: string, params: Record<string, unknown>) => {
    const tool = tools.get(name);
    if (!tool?.outputSchema) throw new Error(`${name} has no outputSchema`);
    const result = await tool.handler(params);
    return {
      result,
      parsed: tool.outputSchema.parse(result.structuredContent) as Parsed,
    };
  };

  it('get_email', async () => {
    const { result, parsed } = await run('get_email', {
      account: 'a',
      emailId: '1',
      mailbox: 'INBOX',
      format: 'full',
    });
    expect(parsed).toMatchObject({
      account: 'a',
      mailbox: 'INBOX',
      id: '1',
      body: 'Body of 1',
      labels: ['work'],
    });
    expect(parsed.cc).toEqual([{ address: 'cc@example.test' }]);
    expect(result.content[0].text).toContain('Body of 1');
    // The JSON stays raw: no markers in the data.
    expect(JSON.stringify(parsed)).not.toContain(UNTRUSTED_BEGIN);
  });

  it('get_emails reports successes and failures', async () => {
    const { parsed } = await run('get_emails', {
      account: 'a',
      ids: ['1', 'bad'],
      mailbox: 'INBOX',
      format: 'text',
    });
    expect(parsed.count).toBe(1);
    expect(parsed.emails[0].id).toBe('1');
    expect(parsed.errors).toEqual([{ id: 'bad', error: 'not found' }]);
  });

  it('get_thread, with and without newestFirst', async () => {
    const base = { account: 'a', message_id: 'x', mailbox: 'INBOX', format: 'full' };
    const all = (await run('get_thread', { ...base, newestFirst: false })).parsed;
    expect(all.messages.map((m: { body?: string }) => m.body)).toEqual(['Body of 1', 'Body of 2']);
    const newest = (await run('get_thread', { ...base, newestFirst: true })).parsed;
    expect(newest.messages.map((m: { id: string }) => m.id)).toEqual(['2', '1']);
    expect(newest.messages[0].body).toBe('Body of 2');
    expect(newest.messages[1].body).toBeUndefined();
    expect(newest.threadId).toBe('t1');
  });

  it('get_thread with no messages still returns valid structuredContent', async () => {
    const server = { registerTool: vi.fn() };
    const imap = {
      getThread: vi
        .fn()
        .mockResolvedValue({ threadId: '', messageCount: 0, participants: [], messages: [] }),
    };
    registerThreadTools(server as never, imap as never);
    const [, meta, handler] = server.registerTool.mock.calls[0] as [
      string,
      { outputSchema: z.ZodType },
      Handler,
    ];
    const r = await handler({
      account: 'a',
      message_id: 'x',
      mailbox: 'INBOX',
      format: 'full',
      newestFirst: false,
    });
    expect(meta.outputSchema.parse(r.structuredContent)).toMatchObject({
      messageCount: 0,
      messages: [],
    });
  });

  it('list_accounts', async () => {
    const { parsed } = await run('list_accounts', {});
    expect(parsed).toEqual({
      count: 2,
      accounts: [
        { name: 'work', email: 'work@example.test', fullName: 'W' },
        { name: 'home', email: 'home@example.test', fullName: null },
      ],
    });
  });
});
