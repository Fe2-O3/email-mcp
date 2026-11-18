import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { AppConfig } from '../types/index.js';
import { stripControlChars } from '../utils/sanitize-text.js';
import { formatEmail, resolveAccount, runEmailCommandWithServices } from './email-commands.js';

const config = {
  accounts: [
    {
      name: 'personal',
      email: 'user@example.test',
      smtp: { host: 'smtp.example.test' },
    },
  ],
  settings: { readOnly: false, send: { maxAttachmentMb: 25 } },
} as unknown as AppConfig;

describe('email CLI', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-cli-test-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('prints command help without loading accounts or opening connections', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    await runEmailCommandWithServices('send', ['--help'], {} as never);

    expect(log).toHaveBeenCalledWith(expect.stringContaining('imap-wizard send --to'));
  });

  it('selects a requested account and reports unknown names', () => {
    const account = { name: 'personal' };
    const accountConfig = { accounts: [account] } as unknown as AppConfig;

    expect(resolveAccount(accountConfig, 'personal')).toBe(account);
    expect(() => resolveAccount(accountConfig, 'missing')).toThrow(/Unknown account/);
  });

  it('lists messages through the IMAP service', async () => {
    const imap = { listEmails: vi.fn().mockResolvedValue({ items: [], total: 0 }) };
    const services = { config, imap, smtp: {} } as never;

    await runEmailCommandWithServices('list', ['--unread'], services);

    expect(imap.listEmails).toHaveBeenCalledWith(
      'personal',
      expect.objectContaining({ mailbox: 'INBOX', seen: false }),
    );
  });

  it('reads an attachment file and sends it through the SMTP service', async () => {
    const attachmentPath = path.join(tempDir, 'notes.txt');
    await fs.writeFile(attachmentPath, 'hello');
    const sendEmail = vi.fn().mockResolvedValue({ messageId: '<sent@example.test>' });
    const services = { config, imap: {}, smtp: { sendEmail } } as never;

    await runEmailCommandWithServices(
      'send',
      [
        '--to',
        'friend@example.test',
        '--subject',
        'Notes',
        '--body',
        'See attached.',
        '--attach',
        attachmentPath,
      ],
      services,
    );

    expect(sendEmail).toHaveBeenCalledWith(
      'personal',
      expect.objectContaining({
        to: ['friend@example.test'],
        attachments: [{ filename: 'notes.txt', content: Buffer.from('hello').toString('base64') }],
      }),
    );
  });

  it('blocks email-writing commands in read-only mode', async () => {
    const readOnlyConfig = {
      ...config,
      settings: { ...config.settings, readOnly: true },
    } as AppConfig;
    const deleteEmail = vi.fn();
    const services = { config: readOnlyConfig, imap: { deleteEmail }, smtp: {} } as never;

    await expect(runEmailCommandWithServices('delete', ['42', '--yes'], services)).rejects.toThrow(
      /read-only/,
    );
    expect(deleteEmail).not.toHaveBeenCalled();
  });

  it('refuses a range or list as a message id before asking or connecting', async () => {
    const deleteEmail = vi.fn();
    const setFlags = vi.fn();
    const getEmail = vi.fn();
    const services = { config, imap: { deleteEmail, setFlags, getEmail }, smtp: {} } as never;

    for (const id of ['1:*', '*', '1,2', '1e3']) {
      await expect(runEmailCommandWithServices('delete', [id, '--yes'], services)).rejects.toThrow(
        /numeric UID/,
      );
      await expect(runEmailCommandWithServices('flag', [id], services)).rejects.toThrow(
        /numeric UID/,
      );
      await expect(runEmailCommandWithServices('read', [id], services)).rejects.toThrow(
        /numeric UID/,
      );
    }
    expect(deleteEmail).not.toHaveBeenCalled();
    expect(setFlags).not.toHaveBeenCalled();
    expect(getEmail).not.toHaveBeenCalled();
  });

  it('prints no terminal control codes from the message: not in headers, body or file names', () => {
    const text = formatEmail({
      id: '1',
      messageId: '<a@b>',
      subject: 'Hi\u001b]0;pwned\u0007 there\u009b',
      from: { name: 'Eve\u202e', address: 'eve@example.test\u001b[2J' },
      to: [{ address: 'me@example.test' }],
      cc: [{ address: 'x@example.test\u0000' }],
      date: '2026-01-01T00:00:00Z',
      seen: true,
      flagged: false,
      answered: false,
      labels: [],
      attachments: [{ filename: 'a\u001b[31m.pdf', mimeType: 'application/pdf', size: 10 }],
      bodyText: 'line one\n\tindented \u001b[1A\u001b[2Koverwrite \u009b\u202e end',
    } as never);
    // Nothing but plain layout characters is left: cleaning it again changes nothing.
    expect(stripControlChars(text, true)).toBe(text);
    expect(text).toContain('line one\n\tindented ');
    expect(text).toContain('Subject: Hi]0;pwned there');
  });
});
