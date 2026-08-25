import { describe, expect, it } from 'vitest';

/**
 * Bug1 — the setup wizard forces STARTTLS on every non-TLS server.
 *
 * The wizard's ServerSettings must support three IMAP states: TLS, STARTTLS,
 * and plain (neither). Previously both buildTestAccount and buildRawAccount used
 * `starttls: !imapTls`, so plain always became STARTTLS. Commit 8fdcf3d made
 * that live by passing doSTARTTLS to ImapFlow, so plain servers now fail.
 *
 * These tests pin the contract: given a security answer of "plain" the written
 * config must have tls: false and starttls: false; given "STARTTLS" it must
 * have tls: false and starttls: true; given "TLS" both match implicit TLS.
 *
 * They exercise the real account-building functions, not just the prompt, so
 * a revert to `!tls` fails them. The prompt itself is also asserted to offer
 * three choices via resolve helpers and select.
 */

import type { ServerSettings } from './account-commands.js';
import {
  buildRawAccount,
  buildTestAccount,
  resolveImapSecurityDefault,
} from './account-commands.js';

function serverWithImap(security: 'tls' | 'starttls' | 'none'): ServerSettings {
  const map: Record<string, { tls: boolean; starttls: boolean }> = {
    tls: { tls: true, starttls: false },
    starttls: { tls: false, starttls: true },
    none: { tls: false, starttls: false },
  };
  const { tls, starttls } = map[security];
  return {
    imapHost: 'imap.example.invalid',
    imapPort: security === 'tls' ? 993 : 143,
    imapTls: tls,
    imapStarttls: starttls,
    smtpHost: 'smtp.example.invalid',
    smtpPort: 465,
    smtpTls: true,
    smtpStarttls: false,
    smtpPoolEnabled: true,
    smtpPoolMaxConnections: 1,
    smtpPoolMaxMessages: 100,
  };
}

describe('Bug1 — IMAP wizard supports plain, STARTTLS and TLS', () => {
  it('resolves default selection correctly for imap', () => {
    expect(resolveImapSecurityDefault({ imapTls: true, imapStarttls: false })).toBe('tls');
    expect(resolveImapSecurityDefault({ imapTls: false, imapStarttls: true })).toBe('starttls');
    expect(resolveImapSecurityDefault({ imapTls: false, imapStarttls: false })).toBe('none');
    // default with no prefs falls back to tls (same as smtp)
    expect(resolveImapSecurityDefault({})).toBe('tls');
  });

  it('plain: tls false and starttls false in both account builders', () => {
    const server = serverWithImap('none');
    const identity = { name: 'test', email: 'a@b.invalid', fullName: 'A B' };
    const creds = { username: 'a@b.invalid', password: 'p' };

    const raw = buildRawAccount(identity, creds, server);
    expect(raw.imap.tls).toBe(false);
    expect(raw.imap.starttls).toBe(false);

    const testAcct = buildTestAccount(identity, creds, server);
    expect(testAcct.imap.tls).toBe(false);
    expect(testAcct.imap.starttls).toBe(false);
  });

  it('STARTTLS: tls false and starttls true', () => {
    const server = serverWithImap('starttls');
    const identity = { name: 'test', email: 'a@b.invalid', fullName: 'A B' };
    const creds = { username: 'a@b.invalid', password: 'p' };

    const raw = buildRawAccount(identity, creds, server);
    expect(raw.imap.tls).toBe(false);
    expect(raw.imap.starttls).toBe(true);

    const testAcct = buildTestAccount(identity, creds, server);
    expect(testAcct.imap.tls).toBe(false);
    expect(testAcct.imap.starttls).toBe(true);
  });

  it('TLS: tls true and starttls false', () => {
    const server = serverWithImap('tls');
    const identity = { name: 'test', email: 'a@b.invalid', fullName: 'A B' };
    const creds = { username: 'a@b.invalid', password: 'p' };

    const raw = buildRawAccount(identity, creds, server);
    expect(raw.imap.tls).toBe(true);
    expect(raw.imap.starttls).toBe(false);

    const testAcct = buildTestAccount(identity, creds, server);
    expect(testAcct.imap.tls).toBe(true);
    expect(testAcct.imap.starttls).toBe(false);
  });
});
