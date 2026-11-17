/**
 * Connection errors can quote the login the server was sent. Every path that
 * turns one into a message (thrown, returned by the test probes, or logged)
 * must scrub the account's secrets first.
 */

import type { AccountConfig } from '../types/index.js';
import ConnectionManager from './manager.js';

const PASSWORD = 'Hunter2-Sup3r-Secret';
const REFRESH = 'refresh-token-0123456789';
const CLIENT_SECRET = 'client-secret-0123456789';

const state = vi.hoisted(() => ({
  imapError: undefined as Error | undefined,
  smtpError: undefined as Error | undefined,
  handlers: {} as Record<string, (arg: unknown) => void>,
  logs: [] as string[],
}));

vi.mock('imapflow', () => {
  class MockImapFlow {
    usable = true;

    connect = vi.fn(async () => {
      if (state.imapError) throw state.imapError;
    });

    close = vi.fn();

    logout = vi.fn().mockResolvedValue(undefined);

    list = vi.fn().mockResolvedValue([]);

    status = vi.fn().mockResolvedValue({ messages: 0 });

    on(event: string, cb: (arg: unknown) => void): this {
      state.handlers[event] = cb;
      return this;
    }
  }
  return { ImapFlow: MockImapFlow };
});

vi.mock('nodemailer', () => ({
  default: {
    createTransport: () => ({
      verify: async () => {
        if (state.smtpError) throw state.smtpError;
      },
      close: vi.fn(),
    }),
  },
}));

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn(async (_level: string, _logger: string, message: string) => {
    state.logs.push(message);
  }),
}));

const account = {
  name: 'work',
  email: 'me@example.invalid',
  username: 'me@example.invalid',
  password: PASSWORD,
  oauth2: {
    provider: 'custom',
    clientId: 'id',
    clientSecret: CLIENT_SECRET,
    refreshToken: REFRESH,
  },
  imap: { host: 'imap.example.invalid', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.invalid', port: 465, tls: true, starttls: false, verifySsl: true },
} as AccountConfig;

// Password-only variant: with oauth2 present the manager would ask an OAuthService for a token.
const passwordAccount = { ...account, oauth2: undefined } as AccountConfig;

describe('ConnectionManager error redaction', () => {
  beforeEach(() => {
    state.imapError = undefined;
    state.smtpError = undefined;
    state.handlers = {};
    state.logs = [];
  });

  it('redacts the password from a failed IMAP connect', async () => {
    state.imapError = new Error(`NO LOGIN failed for ${PASSWORD}`);
    const manager = new ConnectionManager([passwordAccount]);

    const failure = await manager.getImapClient('work').catch((e: Error) => e);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain('[redacted]');
    expect((failure as Error).message).not.toContain(PASSWORD);
  });

  it('redacts the password from a failed SMTP verify', async () => {
    state.smtpError = new Error(`535 5.7.8 bad credentials ${PASSWORD}`);
    const manager = new ConnectionManager([passwordAccount]);

    const failure = await manager.getSmtpTransport('work').catch((e: Error) => e);

    expect((failure as Error).message).toContain('[redacted]');
    expect((failure as Error).message).not.toContain(PASSWORD);
  });

  it('redacts secrets from an IMAP error event before it is logged', async () => {
    const manager = new ConnectionManager([passwordAccount]);
    await manager.getImapClient('work');

    state.handlers.error(new Error(`connection reset after ${PASSWORD}`));

    const line = state.logs.find((l) => l.includes('connection lost'));
    expect(line).toBeDefined();
    expect(line).not.toContain(PASSWORD);
    expect(line).toContain('[redacted]');
  });

  it('redacts the password from the IMAP test probe result', async () => {
    state.imapError = new Error(`NO ${PASSWORD} rejected`);

    const result = await ConnectionManager.testImap(passwordAccount);

    expect(result.success).toBe(false);
    expect(result.error).not.toContain(PASSWORD);
    expect(result.error).toContain('[redacted]');
  });

  it('redacts the password from the SMTP test probe result', async () => {
    state.smtpError = new Error(`Invalid login: 535 ${PASSWORD} rejected`);

    const result = await ConnectionManager.testSmtp(passwordAccount);

    expect(result.success).toBe(false);
    expect(result.error).not.toContain(PASSWORD);
    expect(result.error).toContain('[redacted]');
  });

  it('also scrubs an OAuth2 refresh token and client secret', async () => {
    state.smtpError = new Error(`rejected ${REFRESH} for client ${CLIENT_SECRET}`);

    const result = await ConnectionManager.testSmtp({
      ...account,
      password: undefined,
    } as unknown as AccountConfig);

    expect(result.error).not.toContain(REFRESH);
    expect(result.error).not.toContain(CLIENT_SECRET);
  });
});
