import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import registerAttachmentTools from './attachments.tool.js';
import registerEmailsTools from './emails.tool.js';

type Handler = (params: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { text: string }[];
  structuredContent?: Record<string, unknown>;
}>;

function register(imap: Record<string, unknown>) {
  const handlers = new Map<string, Handler>();
  const server = {
    registerTool: (name: string, _m: unknown, cb: Handler) => handlers.set(name, cb),
  };
  registerAttachmentTools(server as never, imap as never);
  registerEmailsTools(server as never, imap as never);
  return handlers;
}

describe('download_attachment size limits', () => {
  const downloadAttachment = vi.fn().mockResolvedValue({
    filename: 'big.pdf',
    mimeType: 'application/pdf',
    size: 3,
    contentBase64: 'QUJD',
  });
  const handlers = register({ downloadAttachment });
  const call = handlers.get('download_attachment') as Handler;
  let dir: string;

  beforeEach(async () => {
    downloadAttachment.mockClear();
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dl-att-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('keeps the 5 MB cap for content returned to the model', async () => {
    await call({ account: 'a', id: '1', mailbox: 'INBOX', filename: 'big.pdf' });
    expect(downloadAttachment).toHaveBeenCalledWith(
      'a',
      '1',
      'INBOX',
      'big.pdf',
      5 * 1024 * 1024,
      undefined,
    );
  });

  it('allows 50 MB when the file goes to disk with savePath', async () => {
    const result = await call({
      account: 'a',
      id: '1',
      mailbox: 'INBOX',
      filename: 'big.pdf',
      savePath: path.join(dir, 'big.pdf'),
    });
    expect(result.isError).toBeUndefined();
    expect(downloadAttachment).toHaveBeenCalledWith(
      'a',
      '1',
      'INBOX',
      'big.pdf',
      50 * 1024 * 1024,
      undefined,
    );
    expect(await fs.readFile(path.join(dir, 'big.pdf'), 'utf8')).toBe('ABC');
  });

  it('passes occurrence on, so one of two same-name attachments can be chosen', async () => {
    await call({ account: 'a', id: '1', mailbox: 'INBOX', filename: 'big.pdf', occurrence: 2 });
    expect(downloadAttachment).toHaveBeenCalledWith(
      'a',
      '1',
      'INBOX',
      'big.pdf',
      5 * 1024 * 1024,
      2,
    );
  });
});

describe('get_email on a body that did not download completely', () => {
  it('says so in the text and in the structured result', async () => {
    const getEmail = vi.fn().mockResolvedValue({
      id: '1',
      messageId: '<a@b>',
      subject: 'S',
      from: { address: 'a@b.test' },
      to: [{ address: 'me@b.test' }],
      date: '2026-01-01T00:00:00Z',
      seen: true,
      flagged: false,
      answered: false,
      hasAttachments: false,
      labels: [],
      attachments: [],
      bodyIncomplete: true,
    });
    const handlers = register({ getEmail });
    const result = await (handlers.get('get_email') as Handler)({
      account: 'a',
      emailId: '1',
      mailbox: 'INBOX',
      format: 'full',
    });
    expect(result.content[0]?.text).toMatch(/body could not be downloaded completely/);
    expect(result.structuredContent).toMatchObject({ bodyIncomplete: true });
  });
});
