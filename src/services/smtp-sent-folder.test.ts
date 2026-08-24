/**
 * A sent email used to exist only in the recipient's mailbox. Filing the
 * message into the user's own Sent folder via IMAP APPEND closes that gap on
 * every send path.
 *
 * The failure contract matters as much as the feature: SMTP delivery and
 * Sent-folder filing are separate concerns, so an APPEND failure is logged
 * and swallowed - the mail already went out, and reporting it as failed
 * would invite a resend that actually does double-send.
 *
 * Upstream: codefuturist/email-mcp#20, #54, PR #47
 */

import SmtpService from './smtp.service.js';

function buildService(appendSent: ReturnType<typeof vi.fn>) {
  const sendMail = vi.fn().mockResolvedValue({
    messageId: '<sent@example.invalid>',
  });
  const connections = {
    getAccount: () => ({ email: 'me@example.invalid', fullName: 'Me' }),
    getSmtpTransport: async () => ({ sendMail }),
    invalidateSmtpTransport: vi.fn(),
  };
  const imapService = {
    getEmail: async () => ({ subject: '', date: '', from: {}, to: [], attachments: [] }),
    fetchDraft: async () => ({ email: { to: [], subject: '' }, mailbox: 'Drafts' }),
    deleteDraft: async () => undefined,
    appendSent,
  };
  const service = new SmtpService(
    connections as never,
    { tryConsume: () => true } as never,
    imapService as never,
  );
  return { service, sendMail };
}

describe('sent messages are filed into the Sent folder', () => {
  it('appends the raw message after a successful direct send', async () => {
    const appendSent = vi.fn().mockResolvedValue({ appended: true, folder: 'Sent' });
    const { service } = buildService(appendSent);

    await service.sendEmail('work', {
      to: ['c@example.invalid'],
      subject: 's',
      body: 'b',
    });

    await vi.waitFor(() => expect(appendSent).toHaveBeenCalled());
    const [, raw] = appendSent.mock.calls[0] as [string, Buffer];
    expect(raw.toString()).toContain('Subject: s');
    expect(raw.toString()).toContain('c@example.invalid');
  });

  it('an APPEND failure never turns into a failed send', async () => {
    const appendSent = vi.fn().mockRejectedValue(new Error('APPEND refused'));
    const { service } = buildService(appendSent);

    await expect(
      service.sendEmail('work', { to: ['c@example.invalid'], subject: 's', body: 'b' }),
    ).resolves.toMatchObject({ status: 'sent' });
    await vi.waitFor(() => expect(appendSent).toHaveBeenCalled());
  });

  it('a missing Sent folder is not an error either', async () => {
    const appendSent = vi.fn().mockResolvedValue({ appended: false });
    const { service } = buildService(appendSent);

    await expect(
      service.sendEmail('work', { to: ['c@example.invalid'], subject: 's', body: 'b' }),
    ).resolves.toMatchObject({ status: 'sent' });
    await vi.waitFor(() => expect(appendSent).toHaveBeenCalledOnce());
  });

  it('forwards are filed too', async () => {
    const appendSent = vi.fn().mockResolvedValue({ appended: true, folder: 'INBOX/Sent' });
    const connections = {
      getAccount: () => ({ email: 'me@example.invalid', fullName: 'Me' }),
      getSmtpTransport: async () => ({
        sendMail: vi.fn().mockResolvedValue({ messageId: '<f@example.invalid>' }),
      }),
      invalidateSmtpTransport: vi.fn(),
    };
    const imapService = {
      getEmail: async () => ({
        subject: 'orig',
        date: '2026-01-01T00:00:00Z',
        from: { name: 'A', address: 'a@example.invalid' },
        to: [{ address: 'b@example.invalid' }],
        bodyText: 't',
        attachments: [],
      }),
      fetchMessageAttachments: async () => [],
      appendSent,
    };
    const service = new SmtpService(
      connections as never,
      { tryConsume: () => true } as never,
      imapService as never,
    );

    await service.forwardEmail('work', { emailId: '1', to: ['c@example.invalid'] });

    await vi.waitFor(() => expect(appendSent).toHaveBeenCalled());
    const [, raw] = appendSent.mock.calls[0] as [string, Buffer];
    expect(raw.toString()).toContain('Subject: Fwd: orig');
  });
});
