import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { resolveOutgoingAttachments } from './outgoing-attachments.js';

describe('resolveOutgoingAttachments', () => {
  let home: string;
  let doc: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'outgoing-'));
    await mkdir(path.join(home, 'Documents'));
    await mkdir(path.join(home, '.ssh'));
    doc = path.join(home, 'Documents', 'report.pdf');
    await writeFile(doc, 'hello');
    await writeFile(path.join(home, '.ssh', 'id_rsa'), 'SECRET-KEY');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const resolve = (atts: Parameters<typeof resolveOutgoingAttachments>[0], max?: number) =>
    resolveOutgoingAttachments(atts, { maxEncodedBytes: max, guard: { home } });

  it('reads a local file into base64 and names it after the file', async () => {
    const [part] = await resolve([{ path: doc }]);
    expect(part).toEqual({
      filename: 'report.pdf',
      content: Buffer.from('hello').toString('base64'),
    });
  });

  it('keeps a given filename (reduced to one segment) and content type', async () => {
    const [part] = await resolve([
      { path: doc, filename: '../evil/name.pdf', contentType: 'application/pdf' },
    ]);
    expect(part.filename).toBe('name.pdf');
    expect(part.contentType).toBe('application/pdf');
  });

  it('passes inline base64 through untouched', async () => {
    const parts = await resolve([{ filename: 'a.txt', content: 'aGk=' }]);
    expect(parts).toEqual([{ filename: 'a.txt', content: 'aGk=' }]);
  });

  it('needs exactly one of path and base64', async () => {
    await expect(resolve([{ filename: 'a' }])).rejects.toThrow(/either/);
    await expect(resolve([{ path: doc, content: 'aGk=' }])).rejects.toThrow(/not both/);
  });

  it('refuses a file in ~/.ssh', async () => {
    await expect(resolve([{ path: path.join(home, '.ssh', 'id_rsa') }])).rejects.toThrow(/hidden/);
  });

  it('refuses a symlink into ~/.ssh and never returns its bytes', async () => {
    const link = path.join(home, 'Documents', 'notes.txt');
    await symlink(path.join(home, '.ssh', 'id_rsa'), link);
    const attempt = resolve([{ path: link }]);
    await expect(attempt).rejects.toThrow(/protected location/);
  });

  it('refuses relative paths, urls and directories', async () => {
    await expect(resolve([{ path: 'report.pdf' }])).rejects.toThrow(/absolute/);
    await expect(resolve([{ path: 'https://example.test/x' }])).rejects.toThrow(/absolute/);
    await expect(resolve([{ path: path.join(home, 'Documents') }])).rejects.toThrow(/regular file/);
  });

  it('enforces the size limit before reading a big file', async () => {
    const big = path.join(home, 'Documents', 'big.bin');
    await writeFile(big, Buffer.alloc(3000));
    await expect(resolve([{ path: big }], 1000)).rejects.toThrow(/send limit/);
  });

  it('enforces the limit across all attachments together', async () => {
    const one = Buffer.alloc(300).toString('base64');
    await expect(resolve([{ content: one }, { content: one }], 500)).rejects.toThrow(/send limit/);
    await expect(resolve([{ content: one }, { path: doc }], 500)).resolves.toHaveLength(2);
    await expect(resolve([{ content: one }, { content: one }, { path: doc }], 800)).rejects.toThrow(
      /send limit/,
    );
  });
});
