/**
 * Attachment filenames come from whatever a stranger attached to an email.
 * Saving them to disk must land inside the configured destination directory
 * no matter what the name says — traversal attempts, absolute paths, and
 * encoded tricks included. The guarantee is checked on the resolved path's
 * prefix, never by hunting for '..' in a string.
 *
 * Upstream: codefuturist/email-mcp#12, PR #65
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import ImapService from './imap.service.js';

function makeStructure(filename: string) {
  return {
    type: 'multipart/mixed',
    childNodes: [
      { part: '1', type: 'text/plain', size: 10 },
      {
        part: '2',
        type: 'application/pdf',
        disposition: 'attachment',
        dispositionParameters: { filename },
        size: 100,
      },
    ],
  };
}

function buildService(filename: string, downloadBytes = 'PDF'): ImapService {
  const releaseFn = vi.fn();
  const client = {
    usable: true,
    capabilities: new Set<string>(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: releaseFn }),
    fetchOne: vi.fn().mockResolvedValue({
      uid: 9,
      envelope: { subject: 'S', messageId: '<s@x>' },
      flags: [],
      bodyStructure: makeStructure(filename),
      headers: Buffer.from('Subject: S\r\n\r\n', 'utf-8'),
    }),
    download: vi.fn().mockImplementation(async () => ({
      content: (async function* () {
        yield Buffer.from(downloadBytes, 'utf-8');
      })(),
    })),
  };
  return new ImapService({
    getImapClient: async () => client,
  } as never);
}

describe('saved attachments stay inside the destination directory', () => {
  let destDir: string;

  beforeEach(async () => {
    destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'att-dest-'));
  });

  afterEach(async () => {
    await fs.rm(destDir, { recursive: true, force: true });
  });

  const hostileNames = [
    '../../../../etc/passwd',
    '..\\..\\win.ini',
    '/tmp/pwned-full-path',
    '%2e%2e%2f%2e%2e%2fpwned',
    '..',
  ];

  for (const name of hostileNames) {
    it(`contains a hostile filename: ${name}`, async () => {
      const service = buildService(name);

      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', destDir);
      expect(saved).toHaveLength(1);

      const resolvedFile = path.resolve(saved[0].localPath);
      expect(resolvedFile.startsWith(path.resolve(destDir) + path.sep)).toBe(true);
      expect(resolvedFile).not.toBe(path.resolve(destDir));
    });
  }

  it('keeps a normal filename usable', async () => {
    const service = buildService('invoice.pdf');
    const saved = await service.saveEmailAttachments('test', '9', 'INBOX', destDir);

    expect(saved[0].filename).toBe('invoice.pdf');
    expect(path.resolve(saved[0].localPath)).toBe(path.resolve(destDir, 'invoice.pdf'));
    await expect(fs.readFile(saved[0].localPath)).resolves.toEqual(Buffer.from('PDF'));
  });
});
