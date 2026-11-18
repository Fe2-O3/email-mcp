import ConnectionManager from '../connections/manager.js';
import type { AccountConfig } from '../types/index.js';
import { imapCommand, isConnectivityError } from './imap-error.js';

/** ImapFlow throws Error('Command failed') and puts the detail on `.response`. */
function rejection(response: string): Error & { response: string } {
  return Object.assign(new Error('Command failed'), { response });
}

describe('imapCommand', () => {
  it('passes a successful result through', async () => {
    await expect(imapCommand('Doing a thing', async () => 42)).resolves.toBe(42);
  });

  it('replaces the generic failure with what the server said', async () => {
    const run = imapCommand('Creating mailbox "X"', async () => {
      throw rejection('6 NO invalid mailbox name ["X"]: operation not allowed');
    });

    await expect(run).rejects.toThrow(
      'Creating mailbox "X" rejected by server: invalid mailbox name ["X"]: operation not allowed',
    );
  });

  it('strips the tag from a BAD response too', async () => {
    const run = imapCommand('Selecting', async () => {
      throw rejection('a7 BAD Missing required argument');
    });

    await expect(run).rejects.toThrow(/Selecting rejected by server: Missing required argument/);
  });

  it('keeps the original error as the cause', async () => {
    const original = rejection('9 NO over quota');
    try {
      await imapCommand('Appending', async () => {
        throw original;
      });
      expect.unreachable('should have thrown');
    } catch (err) {
      expect((err as Error).cause).toBe(original);
    }
  });

  it('leaves an error with no server response untouched', async () => {
    // A socket reset carries no protocol detail; rewriting it would only
    // obscure the real cause.
    const run = imapCommand('Fetching', async () => {
      throw new Error('ECONNRESET');
    });

    await expect(run).rejects.toThrow('ECONNRESET');
  });

  it('falls back to the raw response when it does not match the tagged form', async () => {
    const run = imapCommand('Fetching', async () => {
      throw rejection('something unparseable');
    });

    await expect(run).rejects.toThrow(/something unparseable/);
  });
});

describe('imapCommand redaction', () => {
  it('cuts a configured password out of the server text, in the clear or as base64', async () => {
    const password = 'correct-horse-battery';
    // The manager remembers every configured account's secrets.
    new ConnectionManager([
      {
        name: 'x',
        email: 'x@example.test',
        username: 'x@example.test',
        password,
        imap: { host: 'h', port: 993, tls: true, starttls: false, verifySsl: true },
        smtp: { host: 'h', port: 465, tls: true, starttls: false, verifySsl: true },
      } as AccountConfig,
    ]);
    const echoed = Buffer.from(password).toString('base64');
    const run = imapCommand('Opening mailbox "X"', async () => {
      throw rejection(`3 NO denied for ${password}; blob ${echoed}`);
    });
    const error = await run.then(
      () => undefined,
      (e: Error) => e,
    );
    expect(error?.message).toMatch(/^Opening mailbox "X" rejected by server: denied for /);
    expect(error?.message).not.toContain(password);
    expect(error?.message).not.toContain(echoed);
  });
});

describe('isConnectivityError', () => {
  const withCode = (code: string, extra: Record<string, unknown> = {}) =>
    Object.assign(new Error(code), { code, ...extra });

  it.each([
    'ECONNREFUSED',
    'ECONNRESET',
    'ETIMEDOUT',
    'EHOSTUNREACH',
    'ENETUNREACH',
    'ENOTFOUND',
    'EAI_AGAIN',
    'EPIPE',
    'EConnectionClosed',
    'NoConnection',
    'ETIMEOUT',
  ])('is true for %s', (code) => {
    expect(isConnectivityError(withCode(code))).toBe(true);
  });

  it('walks the cause chain', () => {
    const wrapped = new Error('wrapped', {
      cause: new Error('mid', { cause: withCode('ECONNRESET') }),
    });
    expect(isConnectivityError(wrapped)).toBe(true);
  });

  it('is false for an authentication failure, even one carrying a network-looking cause', () => {
    expect(
      isConnectivityError(withCode('AUTHENTICATIONFAILED', { authenticationFailed: true })),
    ).toBe(false);
    const err = Object.assign(new Error('Invalid credentials'), {
      authenticationFailed: true,
      cause: withCode('ECONNRESET'),
    });
    expect(isConnectivityError(err)).toBe(false);
  });

  it('is false for not-found, permission, generic and non-error values', () => {
    expect(isConnectivityError(new Error('Email 1 not found in INBOX'))).toBe(false);
    expect(isConnectivityError(withCode('NONEXISTENT'))).toBe(false);
    expect(isConnectivityError(withCode('EACCES'))).toBe(false);
    expect(isConnectivityError(new Error('Command failed'))).toBe(false);
    expect(isConnectivityError(undefined)).toBe(false);
    expect(isConnectivityError('ECONNREFUSED')).toBe(false);
  });

  it('survives a cyclic cause', () => {
    const a: Record<string, unknown> = {};
    a.cause = a;
    expect(isConnectivityError(a)).toBe(false);
  });
});
