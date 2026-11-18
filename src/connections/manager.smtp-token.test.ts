/**
 * The pooled SMTP transport keeps the OAuth2 token it was built with. Reused
 * past that token's life, the first send on a fresh socket fails its login.
 */

import type OAuthService from '../services/oauth.service.js';
import type { AccountConfig } from '../types/index.js';
import ConnectionManager from './manager.js';

const built = vi.hoisted(() => [] as Array<{ auth: { accessToken?: string } }>);

vi.mock('nodemailer', () => ({
  default: {
    createTransport: (options: { auth: { accessToken?: string } }) => {
      built.push(options);
      return { verify: vi.fn().mockResolvedValue(true), close: vi.fn() };
    },
  },
}));

vi.mock('../logging.js', () => ({ mcpLog: vi.fn().mockResolvedValue(undefined) }));

function oauthAccount(): AccountConfig {
  return {
    name: 'work',
    email: 'me@example.invalid',
    username: 'me@example.invalid',
    oauth2: {
      provider: 'custom',
      clientId: 'id',
      clientSecret: 'client-secret-0123456789',
      refreshToken: 'refresh-token-0123456789',
    },
    imap: { host: 'imap.example.invalid', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: 'smtp.example.invalid', port: 465, tls: true, starttls: false, verifySsl: true },
  } as AccountConfig;
}

/** Hands out token-1, token-2, ... and caches each for an hour, as OAuthService does. */
function fakeOAuth() {
  let issued = 0;
  return {
    getAccessToken: vi.fn(async (oauth2: AccountConfig['oauth2'] & object) => {
      if (oauth2.accessToken && (oauth2.tokenExpiry ?? 0) - 5 * 60_000 > Date.now()) {
        return oauth2.accessToken;
      }
      issued += 1;
      Object.assign(oauth2, {
        accessToken: `token-${issued}`,
        tokenExpiry: Date.now() + 3_600_000,
      });
      return `token-${issued}`;
    }),
  } as unknown as OAuthService;
}

describe('ConnectionManager SMTP transport and OAuth2 tokens', () => {
  beforeEach(() => {
    built.length = 0;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('reuses the transport while its token is fresh', async () => {
    const manager = new ConnectionManager([oauthAccount()], fakeOAuth());
    const first = await manager.getSmtpTransport('work');
    const second = await manager.getSmtpTransport('work');
    expect(second).toBe(first);
    expect(built).toHaveLength(1);
  });

  it('builds a new transport with a fresh token once the old one is near expiry', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    const manager = new ConnectionManager([oauthAccount()], fakeOAuth());
    const first = await manager.getSmtpTransport('work');
    vi.setSystemTime(Date.now() + 56 * 60_000);

    const second = await manager.getSmtpTransport('work');

    expect(second).not.toBe(first);
    expect(built.map((options) => options.auth.accessToken)).toEqual(['token-1', 'token-2']);
  });
});
