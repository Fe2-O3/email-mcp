/**
 * Real Authentication-Results shapes from the big providers, plus the traps:
 * a header absent entirely, several DKIM signatures disagreeing, and a
 * forged-looking verdict inside a display name that must not count.
 *
 * Upstream: codefuturist/email-mcp#69
 */

import { describe, expect, it } from 'vitest';

import { extractAuthenticationResults, parseAuthSignals } from './auth-results.js';

const GMAIL =
  'authentication-results: mx.google.com;\r\n' +
  '       dkim=pass header.i=@example.org header.s=2024 header.b=abc;\r\n' +
  '       spf=pass (domain of example.org designates 1.2.3.4) smtp.mailfrom=x@example.org;\r\n' +
  '       dmarc=pass (p=NONE sp=NONE dis=NONE)';
const OUTLOOK =
  'authentication-results: spf=fail (sender IP is 5.6.7.8) smtp.mailfrom=evil.example;\r\n' +
  '       dkim=none message.unparsed;\r\n' +
  '       dmarc=fail action=quarantine';
const PROTON =
  'Authentication-Results: dmarc=pass header.from=proton.me\r\n' +
  'AuthENTICATION-RESULTS: spf=temperror smtp.helo=mx.example';

describe('extractAuthenticationResults', () => {
  it('collects folded and repeated headers case-insensitively', () => {
    const block = `${GMAIL}\r\n${PROTON}`;
    const values = extractAuthenticationResults(block);
    expect(values).toHaveLength(3);
    expect(values[0]).toContain('dkim=pass');
    expect(values[2]).toContain('spf=temperror');
  });

  it('ignores a forged verdict inside a display name', () => {
    const block = ['From: "spf=pass dmarc=pass" <attacker@example.invalid>', 'Subject: hello'].join(
      '\r\n',
    );
    expect(extractAuthenticationResults(block)).toEqual([]);
  });
});

describe('parseAuthSignals', () => {
  it('reads the gmail shape', () => {
    const s = parseAuthSignals(extractAuthenticationResults(GMAIL));
    expect(s).toMatchObject({ spf: 'pass', dkim: 'pass', dmarc: 'pass' });
  });

  it('reports fail and none distinctly', () => {
    const s = parseAuthSignals(extractAuthenticationResults(OUTLOOK));
    expect(s).toMatchObject({ spf: 'fail', dkim: 'none', dmarc: 'fail' });
  });

  it('absent headers are none, never pass', () => {
    const s = parseAuthSignals([]);
    expect(s).toEqual({ spf: 'none', dkim: 'none', dkimSignatures: 0, dmarc: 'none' });
  });

  it('any passing dkim signature wins over disagreeing ones', () => {
    const values = [
      'dkim=fail header.b=1',
      'dkim=softfail header.b=2',
      'authserv-id example; dkim=pass header.b=3',
      'dmarc=bestguesspass',
    ];
    const s = parseAuthSignals(values);
    expect(s.dkim).toBe('pass');
    expect(s.dkimSignatures).toBe(3);
    // Unknown dmarc tokens do not become a pass.
    expect(s.dmarc).toBe('none');
  });

  it('keeps temperror instead of inventing a verdict', () => {
    const s = parseAuthSignals(['spf=temperror']);
    expect(s.spf).toBe('temperror');
  });
});
