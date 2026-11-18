/**
 * OAuth2 token management service.
 *
 * Handles token refresh and caching for Google and Microsoft OAuth2/XOAUTH2.
 * Uses native fetch (Node 22+) — no external HTTP dependencies.
 */

import { redactSentCredentials, registerKnownSecret } from '../connections/credential-redaction.js';
import type { OAuth2Config } from '../types/index.js';

// ---------------------------------------------------------------------------
// Provider endpoint configs
// ---------------------------------------------------------------------------

interface ProviderEndpoints {
  tokenUrl: string;
  authUrl: string;
  scopes: string[];
}

const PROVIDER_ENDPOINTS: Record<string, ProviderEndpoints> = {
  google: {
    tokenUrl: 'https://oauth2.googleapis.com/token',
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    scopes: ['https://mail.google.com/'],
  },
  microsoft: {
    tokenUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/token',
    authUrl: 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    scopes: [
      'https://outlook.office.com/IMAP.AccessAsUser.All',
      'https://outlook.office.com/SMTP.Send',
      'offline_access',
    ],
  },
};

/** 5-minute safety buffer before token expiry */
const TOKEN_EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** What a token without a usable `expires_in` is assumed to last (RFC 6749 leaves it optional). */
const DEFAULT_EXPIRES_IN_S = 3600;

/** A provider that has not answered by now is not going to; callers are waiting on it. */
export const TOKEN_REQUEST_TIMEOUT_MS = 30_000;

export default class OAuthService {
  /**
   * One refresh in flight per account. The IMAP pool, the watcher, SMTP and Sieve all ask for a
   * token, and after expiry they ask at once; a provider that rotates refresh tokens would
   * invalidate the token the other requests sent.
   */
  private refreshing = new WeakMap<OAuth2Config, Promise<string>>();

  /**
   * Get a valid access token, refreshing if expired.
   */
  async getAccessToken(oauth2: OAuth2Config): Promise<string> {
    if (!OAuthService.isTokenExpired(oauth2) && oauth2.accessToken) {
      return oauth2.accessToken;
    }

    const pending = this.refreshing.get(oauth2);
    if (pending) return pending;

    const refresh = (async () => {
      const result = await OAuthService.refreshAccessToken(oauth2);
      // Error text from the servers these go to is scrubbed with every known secret.
      registerKnownSecret(result.accessToken);
      if (result.refreshToken) registerKnownSecret(result.refreshToken);
      // Cache on the config object (in-memory only)
      Object.assign(oauth2, {
        accessToken: result.accessToken,
        tokenExpiry: Date.now() + result.expiresIn * 1000,
        ...(result.refreshToken ? { refreshToken: result.refreshToken } : {}),
      });
      return result.accessToken;
    })();
    this.refreshing.set(oauth2, refresh);
    try {
      return await refresh;
    } finally {
      this.refreshing.delete(oauth2);
    }
  }

  /**
   * Check if the cached access token is expired or missing.
   */
  static isTokenExpired(oauth2: OAuth2Config): boolean {
    if (!oauth2.accessToken || !oauth2.tokenExpiry) return true;
    return Date.now() >= oauth2.tokenExpiry - TOKEN_EXPIRY_BUFFER_MS;
  }

  /**
   * Exchange refresh token for a new access token.
   */
  static async refreshAccessToken(
    oauth2: OAuth2Config,
  ): Promise<{ accessToken: string; expiresIn: number; refreshToken?: string }> {
    const endpoints = OAuthService.getProviderEndpoints(oauth2);

    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: oauth2.clientId,
      client_secret: oauth2.clientSecret,
      refresh_token: oauth2.refreshToken,
    });

    const response = await fetch(endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      // The provider's error body can echo the grant or the client secret that was just sent.
      const safe = redactSentCredentials(text, {
        user: '',
        secrets: [oauth2.refreshToken, oauth2.clientSecret, oauth2.accessToken],
      });
      throw new Error(`OAuth2 token refresh failed (${response.status}): ${safe}`);
    }

    const data = (await response.json()) as Record<string, unknown> | null;
    return OAuthService.readTokenAnswer(data, 'refresh');
  }

  /**
   * The parts of a token endpoint answer this app uses, checked. An answer without an access token
   * is refused: kept, it would make every login fail with nothing useful in the error.
   */
  private static readTokenAnswer(
    data: Record<string, unknown> | null,
    what: 'refresh' | 'code exchange',
  ): { accessToken: string; expiresIn: number; refreshToken?: string } {
    const accessToken = data?.access_token;
    if (typeof accessToken !== 'string' || accessToken.length === 0) {
      throw new Error(`OAuth2 token ${what} failed: the provider's answer has no access token`);
    }
    const expiresIn = Number(data?.expires_in);
    const refreshToken = data?.refresh_token;
    return {
      accessToken,
      expiresIn: Number.isFinite(expiresIn) && expiresIn > 0 ? expiresIn : DEFAULT_EXPIRES_IN_S,
      refreshToken:
        typeof refreshToken === 'string' && refreshToken.length > 0 ? refreshToken : undefined,
    };
  }

  /**
   * Get provider endpoints for token exchange and authorization.
   */
  static getProviderEndpoints(oauth2: OAuth2Config): ProviderEndpoints {
    if (oauth2.provider === 'custom') {
      if (!oauth2.tokenUrl || !oauth2.authUrl) {
        throw new Error('Custom OAuth2 provider requires tokenUrl and authUrl');
      }
      return {
        tokenUrl: oauth2.tokenUrl,
        authUrl: oauth2.authUrl,
        scopes: oauth2.scopes ?? [],
      };
    }

    const endpoints = PROVIDER_ENDPOINTS[oauth2.provider];
    if (!endpoints) {
      throw new Error(`Unknown OAuth2 provider: ${oauth2.provider}`);
    }
    return endpoints;
  }

  /**
   * Generate an OAuth2 authorization URL for the CLI setup wizard.
   */
  static generateAuthUrl(oauth2: OAuth2Config, redirectUri: string): string {
    const endpoints = OAuthService.getProviderEndpoints(oauth2);
    const params = new URLSearchParams({
      client_id: oauth2.clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: endpoints.scopes.join(' '),
      access_type: 'offline',
      prompt: 'consent',
    });
    return `${endpoints.authUrl}?${params.toString()}`;
  }

  /**
   * Exchange an authorization code for tokens (initial setup).
   */
  static async exchangeCode(
    oauth2: OAuth2Config,
    code: string,
    redirectUri: string,
  ): Promise<{ accessToken: string; refreshToken: string; expiresIn: number }> {
    const endpoints = OAuthService.getProviderEndpoints(oauth2);

    const body = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: oauth2.clientId,
      client_secret: oauth2.clientSecret,
      code,
      redirect_uri: redirectUri,
    });

    const response = await fetch(endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
      signal: AbortSignal.timeout(TOKEN_REQUEST_TIMEOUT_MS),
    });

    if (!response.ok) {
      const text = await response.text();
      const safe = redactSentCredentials(text, { user: '', secrets: [code, oauth2.clientSecret] });
      throw new Error(`OAuth2 code exchange failed (${response.status}): ${safe}`);
    }

    const data = (await response.json()) as Record<string, unknown> | null;
    const answer = OAuthService.readTokenAnswer(data, 'code exchange');
    return { ...answer, refreshToken: answer.refreshToken ?? '' };
  }
}
