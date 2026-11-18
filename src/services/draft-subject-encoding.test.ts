/**
 * A draft's subject goes through MailComposer, so a non-ASCII subject must reach
 * the server as an RFC 2047 encoded-word, never as raw 8-bit header bytes.
 */

import ImapService from './imap.service.js';

function buildService() {
  const append = vi.fn().mockResolvedValue({ uid: 42 });
  const client = {
    usable: true,
    list: vi.fn().mockResolvedValue([{ path: 'Drafts', specialUse: '\\Drafts' }]),
    append,
  };
  const service = new ImapService({
    getImapClient: async () => client,
    getAccount: () => ({
      email: 'me@example.test',
      fullName: 'Me',
      smtp: { host: 'smtp.example.test' },
    }),
  } as never);
  return { service, append };
}

function header(raw: string, name: string): string {
  // Unfold continuation lines, then read the named header.
  const head = raw.split(/\r\n\r\n/)[0].replace(/\r\n[ \t]+/g, ' ');
  const line = head.split('\r\n').find((l) => l.toLowerCase().startsWith(`${name.toLowerCase()}:`));
  return line ?? '';
}

describe('saveDraft subject encoding', () => {
  it('encodes a non-ASCII subject as an RFC 2047 encoded-word', async () => {
    const { service, append } = buildService();
    const subject = 'Réunion à 15h — café ☕';

    const result = await service.saveDraft('acct', {
      to: ['bob@example.test'],
      subject,
      body: 'x',
    });

    expect(result).toEqual({ id: 42, mailbox: 'Drafts' });
    const raw = (append.mock.calls[0][1] as Buffer).toString('latin1');
    const line = header(raw, 'Subject');
    expect(line).toMatch(/^Subject: =\?UTF-8\?[BQ]\?[^?]+\?=/i);
    // The head of the message is pure ASCII: no raw UTF-8 bytes leaked through.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: checking for any byte outside 7-bit
    expect(/[^\x00-\x7F]/.test(raw.split(/\r\n\r\n/)[0])).toBe(false);

    // And decoding the encoded-word gives the original subject back.
    const words = [...line.matchAll(/=\?UTF-8\?([BQ])\?([^?]+)\?=/gi)];
    const decoded = words
      .map(([, enc, text]) =>
        enc.toUpperCase() === 'B'
          ? Buffer.from(text, 'base64').toString('utf8')
          : Buffer.from(
              text
                .replace(/_/g, ' ')
                .replace(/=([0-9A-F]{2})/gi, (_m, h: string) =>
                  String.fromCharCode(parseInt(h, 16)),
                ),
              'latin1',
            ).toString('utf8'),
      )
      .join('');
    expect(decoded).toBe(subject);
  });

  it('leaves a plain ASCII subject readable', async () => {
    const { service, append } = buildService();

    await service.saveDraft('acct', {
      to: ['bob@example.test'],
      subject: 'Quarterly plan',
      body: 'x',
    });

    const raw = (append.mock.calls[0][1] as Buffer).toString('latin1');
    expect(header(raw, 'Subject')).toBe('Subject: Quarterly plan');
  });

  it('files the draft with the Draft flag', async () => {
    const { service, append } = buildService();

    await service.saveDraft('acct', { to: ['bob@example.test'], subject: 's', body: 'x' });

    expect(append.mock.calls[0][0]).toBe('Drafts');
    expect(append.mock.calls[0][2]).toContain('\\Draft');
  });
});

describe('saveDraft attachments', () => {
  it('stores a local file by path as a real attachment part', async () => {
    const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const dir = await mkdtemp(join(tmpdir(), 'draft-att-'));
    await writeFile(join(dir, 'plan.txt'), 'the plan');
    try {
      const { service, append } = buildService();
      await service.saveDraft('acct', {
        to: [],
        subject: 's',
        body: 'b',
        attachments: [{ path: join(dir, 'plan.txt') }],
      });
      const raw = (append.mock.calls[0][1] as Buffer).toString('latin1');
      expect(raw).toMatch(/filename="?plan\.txt"?/);
      expect(raw).toContain(Buffer.from('the plan').toString('base64'));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a secret path before opening any connection', async () => {
    const { service, append } = buildService();
    await expect(
      service.saveDraft('acct', {
        to: [],
        subject: 's',
        body: 'b',
        attachments: [{ path: '/etc/hosts' }],
      }),
    ).rejects.toThrow(/protected location/);
    expect(append).not.toHaveBeenCalled();
  });
});
