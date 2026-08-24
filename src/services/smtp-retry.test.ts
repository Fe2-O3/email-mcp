/**
 * A retried send used to be indistinguishable from a new one: nodemailer
 * mints a fresh random Message-ID per attempt, so a timeout-then-retry
 * delivered the same email twice and mailbox providers filed both copies.
 *
 * Two defenses, both pinned here:
 * - an explicit messageId is passed through to the transport verbatim, so a
 *   retry carries the identity of the original attempt;
 * - an identical account+recipients+subject send inside a short window is
 *   refused unless the caller marks it as a deliberate resend.
 *
 * Upstream: codefuturist/email-mcp#62
 */

import SmtpService from './smtp.service.js';

const sendMail = vi.fn().mockResolvedValue({ messageId: '<minted@example.invalid>' });

function buildService() {
  const connections = {
    getAccount: () => ({ email: 'me@example.invalid', fullName: 'Me' }),
    getSmtpTransport: async () => ({ sendMail }),
    invalidateSmtpTransport: vi.fn(),
  };
  return new SmtpService(
    connections as never,
    { tryConsume: () => true } as never,
    { getEmail: async () => ({}) } as never,
  );
}

describe('retry idempotency', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    sendMail.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('passes an explicit messageId to the transport verbatim on every attempt', async () => {
    const svc = buildService();

    await svc.sendEmail('work', {
      to: ['c@example.invalid'],
      subject: 'Invoice',
      body: 'b',
      messageId: '<retry-me@example.invalid>',
    });
    expect(sendMail.mock.calls[0][0]).toMatchObject({ messageId: '<retry-me@example.invalid>' });
  });

  it('refuses an identical resend inside the window without an override', async () => {
    const svc = buildService();

    await svc.sendEmail('work', { to: ['c@example.invalid'], subject: 'Invoice', body: 'b' });
    await expect(
      svc.sendEmail('work', { to: ['c@example.invalid'], subject: 'Invoice', body: 'b' }),
    ).rejects.toThrow(/allow_duplicate|deliberate resend/i);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('lets a deliberate duplicate through with the override', async () => {
    const svc = buildService();

    await svc.sendEmail('work', { to: ['c@example.invalid'], subject: 'Invoice', body: 'b' });
    await expect(
      svc.sendEmail('work', {
        to: ['c@example.invalid'],
        subject: 'Invoice',
        body: 'b',
        allowDuplicate: true,
      }),
    ).resolves.toMatchObject({ status: 'sent' });
    expect(sendMail).toHaveBeenCalledTimes(2);
  });

  it('different recipients or subjects are not duplicates', async () => {
    const svc = buildService();

    await svc.sendEmail('work', { to: ['a@example.invalid'], subject: 'Hi', body: 'b' });
    await expect(
      svc.sendEmail('work', { to: ['b@example.invalid'], subject: 'Hi', body: 'b' }),
    ).resolves.toBeDefined();
    await expect(
      svc.sendEmail('work', { to: ['a@example.invalid'], subject: 'Bye', body: 'b' }),
    ).resolves.toBeDefined();
    expect(sendMail).toHaveBeenCalledTimes(3);
  });
});
