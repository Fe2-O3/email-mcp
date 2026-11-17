import type { OAuth2Config } from '../types/index.js';
import OAuthService from './oauth.service.js';

const REFRESH = 'refresh-token-0123456789';
const CLIENT_SECRET = 'client-secret-0123456789';
const CODE = 'auth-code-0123456789';

const oauth2: OAuth2Config = {
  provider: 'custom',
  clientId: 'client-id',
  clientSecret: CLIENT_SECRET,
  refreshToken: REFRESH,
  tokenUrl: 'https://auth.example.invalid/token',
  authUrl: 'https://auth.example.invalid/auth',
};

function refuseWith(body: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => body }),
  );
}

describe('OAuthService error redaction', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('redacts the refresh token and client secret from a refused refresh', async () => {
    refuseWith(`invalid_grant: token ${REFRESH} of client ${CLIENT_SECRET} revoked`);

    const failure = await OAuthService.refreshAccessToken(oauth2).catch((e: Error) => e);

    expect((failure as Error).message).toBe(
      'OAuth2 token refresh failed (400): invalid_grant: token [redacted] of client [redacted] revoked',
    );
  });

  it('redacts the code and client secret from a refused code exchange', async () => {
    refuseWith(`bad code ${CODE} for ${CLIENT_SECRET}`);

    const failure = await OAuthService.exchangeCode(oauth2, CODE, 'http://localhost/cb').catch(
      (e: Error) => e,
    );

    expect((failure as Error).message).toBe(
      'OAuth2 code exchange failed (400): bad code [redacted] for [redacted]',
    );
  });
});
