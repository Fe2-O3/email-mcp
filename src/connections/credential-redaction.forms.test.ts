/**
 * Forms of a secret the first redaction pass missed: JSON-escaped, changed to
 * lower case, inside base64 at any byte offset, and a token in a provider's
 * JSON answer that this process never saw.
 */

import { redactSentCredentials } from './credential-redaction.js';

const USER = 'work@example.com';
const PASSWORD = 'S3cret-Pa55word!';

// base64 of "<user>:<password>", encoded outside this suite: the password starts at byte
// offsets 17 (17 mod 3 = 2) and 4 (4 mod 3 = 1), so its own base64 is not a substring.
const BASIC_OFFSET_2 = 'd29ya0BleGFtcGxlLmNvbTpTM2NyZXQtUGE1NXdvcmQh';
const BASIC_OFFSET_1 = 'YWJjOlMzY3JldC1QYTU1d29yZCE=';

describe('redactSentCredentials, more forms', () => {
  it('cuts a password a server quoted JSON-escaped', () => {
    const secret = 'pa"ss\\word-1234';
    const text = `{"error":"bad login for ${JSON.stringify(secret).slice(1, -1)}"}`;
    const out = redactSentCredentials(text, { user: USER, secrets: [secret] });
    expect(out).not.toContain('pa\\"ss');
    expect(out).toContain('[redacted]');
  });

  it('cuts a secret a server echoed in lower case', () => {
    const out = redactSentCredentials('NO login failed for s3cret-pa55word!', {
      user: USER,
      secrets: [PASSWORD],
    });
    expect(out).toBe('NO login failed for [redacted]');
  });

  it.each([
    ['offset 2', BASIC_OFFSET_2],
    ['offset 1', BASIC_OFFSET_1],
  ])('cuts base64 of user:password at %s', (_label, blob) => {
    const out = redactSentCredentials(`Authorization: Basic ${blob} rejected`, {
      user: USER,
      secrets: [PASSWORD],
    });
    expect(out).not.toContain(blob);
    expect(out).not.toContain(blob.slice(8, 24));
  });

  it("cuts tokens in a provider's JSON answer that were never sent", () => {
    const text =
      '{"access_token":"ya29.never-seen-access-token","refresh_token": "1//never-seen-refresh","id_token":"eyJhbGciOi.never.seen","expires_in":3599}';
    const out = redactSentCredentials(text, { user: '', secrets: [] });
    expect(out).not.toMatch(/never-seen|never\.seen/);
    expect(out).toContain('"expires_in":3599');
  });

  it('still leaves the base64 of unrelated text alone', () => {
    const text = 'NO [AUTHENTICATIONFAILED] Invalid credentials (Failure) dGhpcyBpcyBmaW5lIHRleHQ=';
    expect(redactSentCredentials(text, { user: USER, secrets: [PASSWORD] })).toBe(text);
  });
});
