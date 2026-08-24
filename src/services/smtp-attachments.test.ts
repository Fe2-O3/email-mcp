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

function buildService(opts: { attachmentParts?: Promise<typeof twoParts> } = {}) {
  const connections = {
    getAccount: () => ({ email: 'me@example.invalid', fullName: 'Me' }),
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
      getAccount: () => ({ email: 'me@example.invalid', fullName: 'Me' }),
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
      getAccount: () => ({ email: 'me@example.invalid', fullName: 'Me' }),
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
