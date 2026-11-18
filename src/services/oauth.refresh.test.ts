/**
 * Token refresh: one request per account at a time, a provider answer that is
 * checked before it is used, a bound on how long the provider may take, and
 * the mail sender rebuilt before its token goes stale.
 */

import { redactKnownSecrets } from '../connections/credential-redaction.js';
import type { OAuth2Config } from '../types/index.js';
import OAuthService from './oauth.service.js';

function config(): OAuth2Config {
  return {
    provider: 'custom',
    clientId: 'client-id',
    clientSecret: 'client-secret-0123456789',
    refreshToken: 'refresh-token-0123456789',
    tokenUrl: 'https://auth.example.invalid/token',
    authUrl: 'https://auth.example.invalid/auth',
  };
}

function answer(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
}

describe('OAuthService token refresh', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // A provider that rotates refresh tokens invalidates the one the others sent.
  it('sends one refresh for several callers at once', async () => {
    let finish: (value: unknown) => void = () => {};
    const fetch = vi.fn(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    vi.stubGlobal('fetch', fetch);
    const service = new OAuthService();
    const oauth2 = config();

    const calls = [service.getAccessToken(oauth2), service.getAccessToken(oauth2)];
    finish(answer({ access_token: 'access-token-aaaaaaaa', expires_in: 3600 }));

    expect(await Promise.all(calls)).toEqual(['access-token-aaaaaaaa', 'access-token-aaaaaaaa']);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('refuses an answer with no access token, and tries again next time', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(answer({ token_type: 'Bearer' })));
    const service = new OAuthService();
    const oauth2 = config();

    await expect(service.getAccessToken(oauth2)).rejects.toThrow(/no access token/);
    expect(oauth2.accessToken).toBeUndefined();
    expect(OAuthService.isTokenExpired(oauth2)).toBe(true);
  });

  it('assumes one hour when the provider gives no usable expiry', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(answer({ access_token: 'access-token-bbbbbbbb', expires_in: 'x' })),
    );
    const oauth2 = config();

    await new OAuthService().getAccessToken(oauth2);

    expect(Number.isFinite(oauth2.tokenExpiry)).toBe(true);
    expect(OAuthService.isTokenExpired(oauth2)).toBe(false);
  });

  it('keeps a refresh token the provider rotated', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        answer({
          access_token: 'access-token-cccccccc',
          expires_in: 3600,
          refresh_token: 'rotated-refresh-0123456789',
        }),
      ),
    );
    const oauth2 = config();

    await new OAuthService().getAccessToken(oauth2);

    expect(oauth2.refreshToken).toBe('rotated-refresh-0123456789');
  });

  it('gives the provider a bounded time to answer', async () => {
    const fetch = vi.fn().mockResolvedValue(answer({ access_token: 'access-token-dddddddd' }));
    vi.stubGlobal('fetch', fetch);

    await new OAuthService().getAccessToken(config());

    const init = fetch.mock.calls[0][1] as { signal?: AbortSignal };
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  // Server text with no account at hand is scrubbed with the registered secrets.
  it('registers new tokens so server error text never shows them', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        answer({
          access_token: 'fresh-access-token-eeeeeeee',
          expires_in: 3600,
          refresh_token: 'fresh-refresh-token-eeeeeeee',
        }),
      ),
    );

    await new OAuthService().getAccessToken(config());

    expect(redactKnownSecrets('NO token fresh-access-token-eeeeeeee refused')).toBe(
      'NO token [redacted] refused',
    );
    expect(redactKnownSecrets('grant fresh-refresh-token-eeeeeeee')).toBe('grant [redacted]');
  });
});
