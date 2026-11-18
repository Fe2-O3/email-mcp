import { isAllowedRedirect, parseAllowlistEntry, parsePlainAddress } from './redirect-allowlist.js';

describe('parseAllowlistEntry', () => {
  it.each([
    ['me@example.org', { kind: 'address', value: 'me@example.org' }],
    ['Me@Example.ORG', { kind: 'address', value: 'me@example.org' }],
    ['example.net', { kind: 'domain', value: 'example.net' }],
    ['@example.net', { kind: 'domain', value: 'example.net' }],
    ['  sub.example.net ', { kind: 'domain', value: 'sub.example.net' }],
  ])('accepts %s', (raw, expected) => {
    expect(parseAllowlistEntry(raw)).toEqual(expected);
  });

  it.each(['', '*', '*@example.com', '*.example.com', 'example', 'a b@example.com', 'a@b@c.com'])(
    'refuses %j',
    (raw) => {
      expect(parseAllowlistEntry(raw)).toHaveProperty('error');
    },
  );
});

// A Sieve variable reference, as a script would carry it.
const VARIABLE = ['$', '{addr}'].join('');

describe('parsePlainAddress', () => {
  it('reads a bare or angle-bracketed address', () => {
    expect(parsePlainAddress('A@B.com')).toEqual({ local: 'a', domain: 'b.com' });
    expect(parsePlainAddress('<a@b.com>')).toEqual({ local: 'a', domain: 'b.com' });
  });

  it.each(['Name <a@b.com>', 'a@b.com, c@d.com', VARIABLE, '"q"@b.com', 'a@', '@b.com'])(
    'refuses %j',
    (raw) => {
      expect(parsePlainAddress(raw)).toBeNull();
    },
  );
});

describe('isAllowedRedirect', () => {
  const list = ['me@example.org', 'example.net'];

  it('allows a listed address in any case', () => {
    expect(isAllowedRedirect('ME@example.org', list)).toBe(true);
  });

  it('allows any address at a listed domain', () => {
    expect(isAllowedRedirect('anyone@example.net', list)).toBe(true);
  });

  it('does not extend a domain to its subdomains or lookalikes', () => {
    expect(isAllowedRedirect('a@evil.example.net', list)).toBe(false);
    expect(isAllowedRedirect('a@example.net.evil.com', list)).toBe(false);
    expect(isAllowedRedirect('a@notexample.net', list)).toBe(false);
  });

  it('refuses another address at the domain of a listed address', () => {
    expect(isAllowedRedirect('other@example.org', list)).toBe(false);
  });

  it('refuses everything with an empty list', () => {
    expect(isAllowedRedirect('me@example.org', [])).toBe(false);
  });

  it('refuses targets it cannot read with certainty', () => {
    expect(isAllowedRedirect('Me <me@example.org>', list)).toBe(false);
    expect(isAllowedRedirect('me@example.org,x@evil.com', list)).toBe(false);
    expect(isAllowedRedirect(VARIABLE, list)).toBe(false);
  });

  it('ignores invalid list entries rather than letting them match everything', () => {
    expect(isAllowedRedirect('a@evil.com', ['*', '*@evil.com', ''])).toBe(false);
  });
});
