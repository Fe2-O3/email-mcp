/**
 * Reply/forward subject prefixes and CRLF normalisation for IMAP APPEND.
 *
 * Upstream: codefuturist/email-mcp#102 (stacked "Re: RE:" prefixes),
 * codefuturist/email-mcp#116 (Sent copy rejected for bare LF line endings).
 */

import { toCrlf } from './imap.service.js';
import { FORWARD_PREFIX, REPLY_PREFIX } from './smtp.service.js';

describe('reply/forward subject prefixes (#102)', () => {
  it.each(['Re: Budget', 'RE: Budget', 're: Hi', 'AW: Hallo', 'SV: Hej', '  Re : spaced'])(
    'treats "%s" as already a reply',
    (subject) => {
      expect(REPLY_PREFIX.test(subject)).toBe(true);
    },
  );

  it.each(['Fwd: Hi', 'FW: Hi', 'fwd: Hi', 'Fw: Hi', 'WG: Hallo'])(
    'treats "%s" as already a forward',
    (subject) => {
      expect(FORWARD_PREFIX.test(subject)).toBe(true);
    },
  );

  it.each(['Budget', 'Regarding: the plan', 'Forward planning', 'Reply needed'])(
    'still prefixes a plain subject "%s"',
    (subject) => {
      expect(REPLY_PREFIX.test(subject)).toBe(false);
      expect(FORWARD_PREFIX.test(subject)).toBe(false);
    },
  );
});

describe('toCrlf (#116)', () => {
  it('turns every bare LF into CRLF', () => {
    const out = toCrlf(Buffer.from('Subject: x\nTo: a@example.test\n\nline1\nline2\n'));
    expect(out.toString('latin1')).toBe(
      'Subject: x\r\nTo: a@example.test\r\n\r\nline1\r\nline2\r\n',
    );
    expect(/(?<!\r)\n/.test(out.toString('latin1'))).toBe(false);
  });

  it('leaves existing CRLF alone instead of doubling it', () => {
    const raw = 'a\r\nb\r\n';
    expect(toCrlf(Buffer.from(raw)).toString('latin1')).toBe(raw);
  });

  it('preserves non-ASCII bytes exactly', () => {
    const raw = Buffer.from('Grüße — 日本\n', 'utf-8');
    const out = toCrlf(raw);
    expect(out.toString('utf-8')).toBe('Grüße — 日本\r\n');
  });
});
