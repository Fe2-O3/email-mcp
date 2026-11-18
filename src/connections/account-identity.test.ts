import accountFingerprint from './account-identity.js';

const base = { username: 'me@example.invalid', imap: { host: 'imap.example.invalid', port: 993 } };

describe('accountFingerprint', () => {
  it('is the same for the same server and login, whatever the case', () => {
    expect(
      accountFingerprint({
        username: 'ME@example.invalid',
        imap: { host: 'IMAP.example.invalid ', port: 993 },
      }),
    ).toBe(accountFingerprint(base));
  });

  it('changes with the server, the port or the login', () => {
    const fingerprints = new Set([
      accountFingerprint(base),
      accountFingerprint({ ...base, imap: { host: 'imap.other.invalid', port: 993 } }),
      accountFingerprint({ ...base, imap: { host: 'imap.example.invalid', port: 143 } }),
      accountFingerprint({ ...base, username: 'you@example.invalid' }),
    ]);
    expect(fingerprints.size).toBe(4);
  });
});
