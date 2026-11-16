import { resolveSendLimitMb } from './send-limit.js';

function account(overrides: { email?: string; smtpHost?: string; maxAttachmentMb?: number } = {}) {
  return {
    email: overrides.email ?? 'person@example.com',
    smtp: { host: overrides.smtpHost ?? 'smtp.example.com' },
    maxAttachmentMb: overrides.maxAttachmentMb,
  };
}

describe('resolveSendLimitMb', () => {
  it('uses the provider limit when it is stricter than the global setting', () => {
    expect(resolveSendLimitMb(account({ smtpHost: 'smtp.office365.com' }), 25)).toBe(20);
  });

  it('keeps the configured global limit when it is stricter than the provider limit', () => {
    expect(resolveSendLimitMb(account({ smtpHost: 'smtp.fastmail.com' }), 25)).toBe(25);
  });

  it('uses a provider limit based on the email domain with a custom SMTP relay', () => {
    expect(
      resolveSendLimitMb(account({ email: 'person@gmail.com', smtpHost: 'relay.example.net' }), 40),
    ).toBe(25);
  });

  it('uses the explicit per-account limit as an override', () => {
    expect(
      resolveSendLimitMb(
        account({
          email: 'person@outlook.com',
          smtpHost: 'smtp.office365.com',
          maxAttachmentMb: 40,
        }),
        25,
      ),
    ).toBe(40);
  });

  it('falls back to the global limit for unknown providers', () => {
    expect(resolveSendLimitMb(account(), 12)).toBe(12);
  });
});
