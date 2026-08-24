import { describe, expect, it, vi } from 'vitest';

const { MockImapFlow, mockConnect } = vi.hoisted(() => {
  const mockConnect = vi.fn().mockResolvedValue(undefined);
  const MockImapFlow = vi.fn().mockImplementation(function (
    this: Record<string, unknown>,
    opts: never,
  ) {
    this.opts = opts;
    return { connect: mockConnect, on: vi.fn().mockReturnThis() };
  });
  return { MockImapFlow, mockConnect };
});

vi.mock('imapflow', () => ({ ImapFlow: MockImapFlow }));

import ConnectionManager from './manager.js';

describe('IMAP STARTTLS', () => {
  it('passes doSTARTTLS when configured', async () => {
    MockImapFlow.mockClear();
    mockConnect.mockClear();
    const account = {
      name: 'test',
      email: 'a@b.invalid',
      username: 'a@b.invalid',
      password: 'p',
      imap: { host: 'h', port: 143, tls: false, starttls: true, verifySsl: true },
      smtp: { host: 'h', port: 465, tls: true, starttls: false, verifySsl: true },
    } as unknown as never;
    const cm = new ConnectionManager([account] as never, null as never);
    // Trigger client creation via getImapClient
    try {
      await cm.getImapClient('test');
    } catch {}
    const opts = (MockImapFlow.mock.calls[0]?.[0] as Record<string, unknown>) ?? {};
    expect(opts.doSTARTTLS).toBe(true);
  });

  it('omits doSTARTTLS when not configured', async () => {
    MockImapFlow.mockClear();
    const account = {
      name: 'test2',
      email: 'a@b.invalid',
      username: 'a@b.invalid',
      password: 'p',
      imap: { host: 'h', port: 143, tls: true, starttls: false, verifySsl: true },
      smtp: { host: 'h', port: 465, tls: true, starttls: false, verifySsl: true },
    } as unknown as never;
    const cm = new ConnectionManager([account] as never, null as never);
    try {
      await cm.getImapClient('test2');
    } catch {}
    const opts = (MockImapFlow.mock.calls[0]?.[0] as Record<string, unknown>) ?? {};
    expect(opts.doSTARTTLS).toBeUndefined();
  });
});
