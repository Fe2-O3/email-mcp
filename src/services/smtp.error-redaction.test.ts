import SmtpService from './smtp.service.js';

const PASSWORD = 'Hunter2-Sup3r-Secret';

describe('SmtpService send error redaction', () => {
  it('redacts the password a refused login quotes, and still evicts the transport', async () => {
    const invalidateSmtpTransport = vi.fn();
    const connections = {
      getAccount: () => ({
        email: 'me@example.invalid',
        fullName: 'Me',
        username: 'me@example.invalid',
        password: PASSWORD,
        smtp: { host: 'smtp.example.invalid' },
      }),
      getSmtpTransport: async () => ({
        sendMail: async () => {
          throw new Error(`Invalid login: 535 5.7.8 ${PASSWORD} rejected`);
        },
      }),
      invalidateSmtpTransport,
    };
    const svc = new SmtpService(
      connections as never,
      { tryConsume: () => true } as never,
      { getEmail: async () => ({}) } as never,
    );

    const failure = await svc
      .sendEmail('work', { to: ['c@example.invalid'], subject: 's', body: 'b' })
      .catch((e: Error) => e);

    expect((failure as Error).message).toBe('Invalid login: 535 5.7.8 [redacted] rejected');
    expect(invalidateSmtpTransport).toHaveBeenCalledWith('work');
  });
});
