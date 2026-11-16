import type { EmailMeta } from '../types/index.js';
import VerificationService from './verification.service.js';

function meta(overrides: Partial<EmailMeta> = {}): EmailMeta {
  return {
    id: '1',
    messageId: '<m1@example.test>',
    subject: 'Your verification code',
    from: { name: 'Example', address: 'no-reply@example.test' },
    to: [{ address: 'user@example.test' }],
    date: new Date().toISOString(),
    seen: false,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
    ...overrides,
  };
}

function createService(
  items: EmailMeta[],
  bodies: Record<string, { bodyText?: string; bodyHtml?: string }>,
) {
  const imap = {
    listEmails: vi.fn().mockResolvedValue({ items, total: items.length }),
    getEmail: vi.fn(async (_account: string, id: string) => ({
      ...meta({ id }),
      ...bodies[id],
    })),
  };
  return { service: new VerificationService(imap as never), imap };
}

describe('VerificationService', () => {
  it('returns the newest contextualized one-time code', async () => {
    const older = meta({
      id: 'older',
      date: new Date(Date.now() - 60_000).toISOString(),
    });
    const newer = meta({ id: 'newer' });
    const { service, imap } = createService([older, newer], {
      older: { bodyText: 'Your sign-in code is 123456.' },
      newer: { bodyText: 'Your verification code is 654321. It expires in 10 minutes.' },
    });

    const hit = await service.findLatest({
      accountNames: ['personal'],
      mailbox: 'INBOX',
      lookbackMinutes: 15,
      maxMessages: 20,
      includeMagicLinks: false,
    });

    expect(hit).toMatchObject({ kind: 'code', value: '654321', account: 'personal' });
    expect(imap.listEmails).toHaveBeenCalledWith(
      'personal',
      expect.objectContaining({ pageSize: 20, mailbox: 'INBOX' }),
    );
  });

  it('does not mistake an order number for a verification code', async () => {
    const order = meta({ subject: 'Order 482913 confirmed' });
    const { service, imap } = createService([order], {
      '1': { bodyText: 'Your order number is 482913.' },
    });

    const hit = await service.findLatest({
      accountNames: ['personal'],
      mailbox: 'INBOX',
      lookbackMinutes: 15,
      maxMessages: 20,
      includeMagicLinks: false,
    });

    expect(hit).toBeUndefined();
    expect(imap.getEmail).toHaveBeenCalledOnce();
  });

  it('uses the richer HTML body when the plain-text alternative is only a stub', async () => {
    const codeMail = meta();
    const { service } = createService([codeMail], {
      '1': {
        bodyText: 'Verify.',
        bodyHtml: '<p>Your verification code is 739104. It expires in 10 minutes.</p>',
      },
    });

    const hit = await service.findLatest({
      accountNames: ['personal'],
      mailbox: 'INBOX',
      lookbackMinutes: 15,
      maxMessages: 20,
      includeMagicLinks: false,
    });

    expect(hit).toMatchObject({ kind: 'code', value: '739104' });
  });

  it('does not inspect unrelated messages', async () => {
    const newsletter = meta({
      subject: 'Weekly product news',
      from: { address: 'news@example.test' },
    });
    const { service, imap } = createService([newsletter], {});

    const hit = await service.findLatest({
      accountNames: ['personal'],
      mailbox: 'INBOX',
      lookbackMinutes: 15,
      maxMessages: 20,
      includeMagicLinks: false,
    });

    expect(hit).toBeUndefined();
    expect(imap.getEmail).not.toHaveBeenCalled();
  });

  it('only returns a magic link when the setting enables link lookup', async () => {
    const linkMail = meta({ subject: 'Confirm your sign-in' });
    const body = {
      bodyHtml:
        '<p>Continue</p><a href="https://example.test/verify?token=a1B2c3D4e5F6g7H8i9J0k1L2">Verify sign-in</a>',
    };
    const { service } = createService([linkMail], { '1': body });
    const options = {
      accountNames: ['personal'],
      mailbox: 'INBOX',
      lookbackMinutes: 15,
      maxMessages: 20,
    };

    await expect(
      service.findLatest({ ...options, includeMagicLinks: false }),
    ).resolves.toBeUndefined();
    await expect(
      service.findLatest({ ...options, includeMagicLinks: true }),
    ).resolves.toMatchObject({
      kind: 'link',
      value: expect.stringContaining('/verify?token='),
    });
  });
});
