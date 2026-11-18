import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import ImapService from '../services/imap.service.js';
import registerExportTools from './export.tool.js';

const SOURCE = 'Subject: Hello\r\nFrom: a@example.test\r\n\r\nBody\r\n';

function buildClient(opts: { missing?: boolean; source?: string; size?: number } = {}) {
  const source = Buffer.from(opts.source ?? SOURCE, 'utf-8');
  const release = vi.fn();
  const fetchOne = vi
    .fn()
    .mockImplementation(async (_uid: string, query: Record<string, unknown>) => {
      if (opts.missing) return false;
      if (query.source) return { uid: 7, source };
      return {
        uid: 7,
        size: opts.size ?? source.length,
        internalDate: new Date('2026-03-04T10:00:00Z'),
      };
    });
  const client = {
    usable: true,
    getMailboxLock: vi.fn().mockResolvedValue({ release }),
    fetchOne,
    messageFlagsAdd: vi.fn(),
    messageFlagsSet: vi.fn(),
    messageFlagsRemove: vi.fn(),
  };
  return { client, release, source };
}

type Handler = (args: Record<string, unknown>) => Promise<{
  isError?: boolean;
  content: { text: string }[];
}>;

function setup(client: unknown) {
  const service = new ImapService({ getImapClient: async () => client } as never);
  let config: { annotations?: Record<string, unknown> } = {};
  let handler: Handler | undefined;
  registerExportTools(
    {
      registerTool: (_name: string, cfg: typeof config, h: Handler) => {
        config = cfg;
        handler = h;
      },
    } as never,
    service,
  );
  return { call: (args: Record<string, unknown>) => (handler as Handler)(args), config };
}

describe('export_email', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'export-eml-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('returns the raw source as base64 and never touches flags', async () => {
    const { client, release, source } = buildClient();
    const { call } = setup(client);

    const result = await call({ account: 'a', emailId: '7', mailbox: 'INBOX' });

    expect(result.isError).toBeUndefined();
    expect(result.content[1].text).toContain(source.toString('base64'));
    expect(JSON.parse(result.content[0].text).filename).toBe('2026-03-04_7.eml');
    // Read-only mailbox, BODY.PEEK via source:true, no flag command.
    expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX', {
      readOnly: true,
      acquireTimeout: 60_000,
    });
    expect(client.fetchOne).toHaveBeenCalledWith('7', { uid: true, source: true }, { uid: true });
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(client.messageFlagsSet).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalled();
  });

  it('reports a missing message as an error', async () => {
    const { client, release } = buildClient({ missing: true });
    const result = await setup(client).call({ account: 'a', emailId: '99', mailbox: 'INBOX' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('not found');
    expect(release).toHaveBeenCalled();
  });

  it('rejects a non-numeric id before touching the server', async () => {
    const { client } = buildClient();
    const result = await setup(client).call({ account: 'a', emailId: '1,2', mailbox: 'INBOX' });

    expect(result.isError).toBe(true);
    expect(client.getMailboxLock).not.toHaveBeenCalled();
  });

  it('refuses an oversized message without transferring its source', async () => {
    const { client } = buildClient({ size: 6 * 1024 * 1024 });
    const result = await setup(client).call({ account: 'a', emailId: '7', mailbox: 'INBOX' });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('limit');
    expect(client.fetchOne).toHaveBeenCalledTimes(1);
  });

  it('writes into an existing directory under the generated name', async () => {
    const { client, source } = buildClient();
    const result = await setup(client).call({
      account: 'a',
      emailId: '7',
      mailbox: 'INBOX',
      savePath: dir,
    });

    const body = JSON.parse(result.content[0].text);
    expect(body.path).toBe(path.join(dir, '2026-03-04_7.eml'));
    await expect(fs.readFile(body.path)).resolves.toEqual(source);
    expect(result.content).toHaveLength(1); // no base64 alongside a saved file
  });

  it('writes to an explicit file path and creates parent directories', async () => {
    const { client, source } = buildClient();
    const target = path.join(dir, 'nested', 'receipt.eml');
    const result = await setup(client).call({
      account: 'a',
      emailId: '7',
      mailbox: 'INBOX',
      savePath: target,
    });

    expect(JSON.parse(result.content[0].text).path).toBe(target);
    await expect(fs.readFile(target)).resolves.toEqual(source);
  });

  it('never overwrites an existing file', async () => {
    const { client } = buildClient();
    const target = path.join(dir, 'keep.eml');
    await fs.writeFile(target, 'original');
    const result = await setup(client).call({
      account: 'a',
      emailId: '7',
      mailbox: 'INBOX',
      savePath: target,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('overwrite');
    await expect(fs.readFile(target, 'utf8')).resolves.toBe('original');
  });

  it('rejects a relative savePath', async () => {
    const { client } = buildClient();
    const result = await setup(client).call({
      account: 'a',
      emailId: '7',
      mailbox: 'INBOX',
      savePath: '../escape.eml',
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('absolute');
  });

  it('is annotated as a non-destructive local-file writer', () => {
    const { config } = setup(buildClient().client);
    expect(config.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false });
  });
});
