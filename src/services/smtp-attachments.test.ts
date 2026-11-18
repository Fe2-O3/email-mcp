/**
 * Forwarding an email that carries an invoice used to deliver exactly the
 * covering text: no `attachments` key existed on the forward path, nothing
 * was fetched, nothing reached nodemailer. The recipient never learns what
 * they did not receive.
 *
 * These tests pin the corrected contract on all three outbound paths:
 *
 * - forward reattaches the original's parts by default, skips them only when
 *   explicitly asked, and refuses an oversized original at compose time;
 * - direct sends accept inline base64 parts;
 * - every payload is built with filesystem and URL access disabled, so an
 *   attachment can never reach into a local path or network resource.
 *
 * Upstream: codefuturist/email-mcp#52, #67, #77
 */

import { rm } from 'node:fs/promises';
import { join } from 'node:path';

import SmtpService from './smtp.service.js';

const sendMail = vi.fn().mockResolvedValue({ messageId: '<sent@example.invalid>' });

const original = {
  subject: 'Quarterly numbers',
  date: '2026-08-01T10:00:00Z',
  from: { name: 'Alice Example', address: 'alice@example.invalid' },
  to: [{ address: 'bob@example.invalid' }],
  bodyText: 'plain fallback',
  bodyHtml: '<p>the <strong>real</strong> content</p>',
};

const twoParts = [
  {
    filename: 'invoice.pdf',
    content: 'JVBERi0xLjQ=',
    contentType: 'application/pdf',
    encoding: 'base64' as const,
  },
  {
    filename: 'sheet.xlsx',
    content: 'UEsDBBQAAAAI',
    contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    encoding: 'base64' as const,
  },
];

function buildService(
  opts: {
    attachmentParts?: Promise<typeof twoParts>;
    account?: {
      email?: string;
      smtpHost?: string;
      maxAttachmentMb?: number;
    };
    globalAttachmentLimitMb?: number;
  } = {},
) {
  const connections = {
    getAccount: () => ({
      email: opts.account?.email ?? 'me@example.invalid',
      fullName: 'Me',
      smtp: { host: opts.account?.smtpHost ?? 'smtp.example.invalid' },
      maxAttachmentMb: opts.account?.maxAttachmentMb,
    }),
    getSmtpTransport: async () => ({ sendMail }),
  };
  const imapService = {
    getEmail: async () => ({ ...original }),
    fetchMessageAttachments: opts.attachmentParts ?? vi.fn().mockResolvedValue(twoParts),
  };
  return new SmtpService(
    connections as never,
    { tryConsume: () => true } as never,
    imapService as never,
    opts.globalAttachmentLimitMb,
  );
}

function lastPayload(): Record<string, unknown> {
  return sendMail.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

describe('forward_email reattaches the original\u2019s attachments', () => {
  beforeEach(() => {
    sendMail.mockClear();
  });

  it('includes both original parts on the composed message by default', async () => {
    const svc = buildService();
    await svc.forwardEmail('work', {
      emailId: '4821',
      to: ['carol@example.invalid'],
      body: 'See attached.',
    });

    const attachments = lastPayload().attachments as typeof twoParts;
    expect(attachments).toHaveLength(2);
    expect(attachments[0]).toMatchObject({
      filename: 'invoice.pdf',
      contentType: 'application/pdf',
      encoding: 'base64',
    });
    expect(attachments[1].filename).toBe('sheet.xlsx');
  });

  it('fetches nothing when includeAttachments is false', async () => {
    const fetchSpy = vi.fn().mockResolvedValue(twoParts);
    const connections = {
      getAccount: () => ({
        email: 'me@example.invalid',
        fullName: 'Me',
        smtp: { host: 'smtp.example.invalid' },
      }),
      getSmtpTransport: async () => ({ sendMail }),
    };
    const imap = {
      getEmail: async () => ({ ...original }),
      fetchMessageAttachments: fetchSpy,
    };
    const strict = new SmtpService(
      connections as never,
      { tryConsume: () => true } as never,
      imap as never,
    );

    await strict.forwardEmail('work', {
      emailId: '4821',
      to: ['carol@example.invalid'],
      includeAttachments: false,
    });

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(lastPayload().attachments).toBeUndefined();
  });

  it('refuses an oversized original before the transport is touched', async () => {
    const oversized = vi.fn().mockRejectedValue(new Error('Original carries 40MB of attachments'));
    const connections = {
      getAccount: () => ({
        email: 'me@example.invalid',
        fullName: 'Me',
        smtp: { host: 'smtp.example.invalid' },
      }),
      getSmtpTransport: async () => ({ sendMail }),
    };
    const imap = {
      getEmail: async () => ({ ...original }),
      fetchMessageAttachments: oversized,
    };
    const svc = new SmtpService(
      connections as never,
      { tryConsume: () => true } as never,
      imap as never,
    );

    await expect(
      svc.forwardEmail('work', { emailId: '9', to: ['carol@example.invalid'] }),
    ).rejects.toThrow(/40MB/);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('passes the account-specific cap into the forwarded attachment preflight', async () => {
    const fetchAttachments = vi.fn().mockResolvedValue(twoParts);
    const connections = {
      getAccount: () => ({
        email: 'person@outlook.com',
        fullName: 'Me',
        smtp: { host: 'smtp.office365.com' },
      }),
      getSmtpTransport: async () => ({ sendMail }),
    };
    const imap = {
      getEmail: async () => ({ ...original }),
      fetchMessageAttachments: fetchAttachments,
    };
    const svc = new SmtpService(
      connections as never,
      { tryConsume: () => true } as never,
      imap as never,
      25,
    );

    await svc.forwardEmail('work', {
      emailId: '4821',
      to: ['carol@example.invalid'],
    });

    expect(fetchAttachments).toHaveBeenCalledWith('work', '4821', 'INBOX', 20 * 1024 * 1024);
  });
});

describe('send_email accepts inline parts safely', () => {
  beforeEach(() => {
    sendMail.mockClear();
  });

  it('maps base64 parts onto the nodemailer payload', async () => {
    const svc = buildService();
    await svc.sendEmail('work', {
      to: ['carol@example.invalid'],
      subject: 'With files',
      body: 'Attached.',
      attachments: [
        { filename: 'invoice.pdf', content: 'JVBERi0xLjQ=', contentType: 'application/pdf' },
      ],
    });

    const attachments = lastPayload().attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({ filename: 'invoice.pdf', encoding: 'base64' });
  });

  it('accepts local-file attachments on the reply path', async () => {
    const svc = buildService();
    await svc.replyToEmail('work', {
      emailId: '4821',
      body: 'See attached.',
      attachments: [{ filename: 'notes.txt', content: Buffer.from('notes').toString('base64') }],
    });

    expect(lastPayload().attachments).toMatchObject([
      { filename: 'notes.txt', encoding: 'base64' },
    ]);
    expect(lastPayload().disableFileAccess).toBe(true);
    expect(lastPayload().disableUrlAccess).toBe(true);
  });

  it('rejects inline attachments over the effective provider limit before SMTP send', async () => {
    const svc = buildService({
      account: { email: 'person@outlook.com', smtpHost: 'smtp.office365.com' },
      globalAttachmentLimitMb: 25,
    });

    await expect(
      svc.sendEmail('work', {
        to: ['carol@example.invalid'],
        subject: 'Too large',
        body: 'Attached.',
        attachments: [{ filename: 'large.bin', content: 'A'.repeat(20 * 1024 * 1024 + 1) }],
      }),
    ).rejects.toThrow(/20 MB send limit/);
    expect(sendMail).not.toHaveBeenCalled();
  });

  it('never allows filesystem or URL access in any composed mail', async () => {
    const svc = buildService();
    await svc.sendEmail('work', { to: ['c@e.invalid'], subject: 's', body: 'b' });
    expect(lastPayload().disableFileAccess).toBe(true);
    expect(lastPayload().disableUrlAccess).toBe(true);

    await svc.forwardEmail('work', { emailId: '7', to: ['c@e.invalid'] });
    expect(lastPayload().disableFileAccess).toBe(true);
    expect(lastPayload().disableUrlAccess).toBe(true);
  });
});

describe('attaching a local file by path', () => {
  beforeEach(() => {
    sendMail.mockClear();
  });

  async function makeFile(name: string, text: string): Promise<{ file: string; dir: string }> {
    const { mkdtemp, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'smtp-path-'));
    const file = join(dir, name);
    await writeFile(file, text);
    return { file, dir };
  }

  it('send_email reads the file and sends it as base64', async () => {
    const { file, dir } = await makeFile('notes.txt', 'hello');
    try {
      await buildService().sendEmail('work', {
        to: ['a@example.invalid'],
        subject: 's',
        body: 'b',
        attachments: [{ path: file }],
      });
      const [att] = lastPayload().attachments as Array<Record<string, unknown>>;
      expect(att).toMatchObject({
        filename: 'notes.txt',
        content: Buffer.from('hello').toString('base64'),
        encoding: 'base64',
      });
      expect(att.path).toBeUndefined();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reply_email and forward_email take path attachments too', async () => {
    const { file, dir } = await makeFile('r.txt', 'reply');
    try {
      const svc = buildService();
      await svc.replyToEmail('work', { emailId: '1', body: 'x', attachments: [{ path: file }] });
      expect((lastPayload().attachments as Array<{ filename: string }>)[0].filename).toBe('r.txt');
      await svc.forwardEmail('work', {
        emailId: '1',
        to: ['c@example.invalid'],
        attachments: [{ path: file }],
      });
      const names = (lastPayload().attachments as Array<{ filename: string }>).map(
        (a) => a.filename,
      );
      expect(names).toEqual(['invoice.pdf', 'sheet.xlsx', 'r.txt']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a path under a hidden folder and sends nothing', async () => {
    const { mkdtemp, mkdir, writeFile } = await import('node:fs/promises');
    const { tmpdir } = await import('node:os');
    const dir = await mkdtemp(join(tmpdir(), 'smtp-hidden-'));
    await mkdir(join(dir, '.ssh'));
    await writeFile(join(dir, '.ssh', 'id_rsa'), 'SECRET');
    try {
      await expect(
        buildService().sendEmail('work', {
          to: ['a@example.invalid'],
          subject: 's2',
          body: 'b',
          attachments: [{ path: join(dir, '.ssh', 'id_rsa') }],
        }),
      ).rejects.toThrow(/protected location/);
      expect(sendMail).not.toHaveBeenCalled();
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
