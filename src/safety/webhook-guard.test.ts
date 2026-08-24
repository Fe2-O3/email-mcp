/**
 * Contract tests for the webhook destination guard.
 *
 * Every case here was run against the previous string-only validator and
 * passed it — that is the failure this guard exists to close. Resolution is
 * injected, so the table is deterministic and needs no network.
 */

import { describe, expect, it } from 'vitest';

import { assertWebhookTargetAllowed, isForbiddenAddress, type Lookup } from './webhook-guard.js';

/** Maps names to addresses the way a hostile or odd resolver might. */
function fakeLookup(entries: Record<string, string[]>): Lookup {
  return async (hostname) => {
    const addresses = entries[hostname];
    if (!addresses) throw new Error(`ENOTFOUND ${hostname}`);
    return addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
  };
}

const PUBLIC = {
  'hooks.example.invalid': ['93.184.216.34'],
  'v6.example.invalid': ['2620:0:2d0:200::7'],
};

describe('isForbiddenAddress', () => {
  const forbidden = [
    '127.0.0.1',
    '10.1.2.3',
    '172.16.5.4',
    '192.168.1.1',
    '169.254.169.254',
    '100.64.1.1',
    '198.18.0.5',
    '192.0.0.9',
    '0.0.0.0',
    '224.0.0.1',
    '::1',
    'fd00::1',
    'fe80::1',
    '::ffff:127.0.0.1',
    '::ffff:10.0.0.1',
  ];

  const allowed = ['93.184.216.34', '8.8.8.8', '2620:0:2d0:200::7'];

  for (const address of forbidden) {
    it(`refuses ${address}`, () => {
      expect(isForbiddenAddress(address)).toBe(true);
    });
  }

  for (const address of allowed) {
    it(`allows ${address}`, () => {
      expect(isForbiddenAddress(address)).toBe(false);
    });
  }
});

describe('assertWebhookTargetAllowed', () => {
  it('accepts a public literal and a public resolving name', async () => {
    await assertWebhookTargetAllowed('https://93.184.216.34/hook');
    await assertWebhookTargetAllowed(
      'https://hooks.example.invalid/services/x',
      fakeLookup(PUBLIC),
    );
    await assertWebhookTargetAllowed('https://v6.example.invalid/hook', fakeLookup(PUBLIC));
  });

  it('refuses non-http schemes', async () => {
    await expect(assertWebhookTargetAllowed('file:///etc/hosts')).rejects.toThrow(/http or https/);
    await expect(assertWebhookTargetAllowed('ftp://example.invalid/x')).rejects.toThrow(
      /http or https/,
    );
  });

  it('refuses forbidden literals outright', async () => {
    const literals = [
      'http://127.0.0.1:8080/admin',
      'http://169.254.169.254/latest/meta-data/',
      'http://[::1]/',
      'http://[fd00::1]/',
      'http://[fe80::5]/',
      'http://[::ffff:127.0.0.1]/',
      'http://100.64.1.1/',
      'http://198.18.0.5/',
      'http://0.0.0.0/',
    ];
    for (const url of literals) {
      await expect(assertWebhookTargetAllowed(url)).rejects.toThrow(/not routable|public address/);
    }
  });

  it('normalises alternate IPv4 encodings before checking', async () => {
    // The WHATWG URL parser folds these to dotted-quad form; assert they are
    // still refused after normalisation.
    const encodings = [
      'http://0x7f000001/',
      'http://2130706433/',
      'http://0177.0.0.1/',
      'http://127.1/',
    ];
    for (const url of encodings) {
      await expect(assertWebhookTargetAllowed(url)).rejects.toThrow(/not routable|public address/);
    }
  });

  it('refuses names that resolve into forbidden space', async () => {
    const lookup = fakeLookup({
      localhost: ['127.0.0.1'],
      'localhost.': ['127.0.0.1'],
      'metadata.google.internal': ['169.254.169.254'],
      'rebind.example.invalid': ['93.184.216.34', '10.0.0.7'],
    });

    await expect(
      assertWebhookTargetAllowed('http://localhost.:45998/hook', lookup),
    ).rejects.toThrow(/not routable/);
    await expect(
      assertWebhookTargetAllowed('http://metadata.google.internal/computeMetadata/v1/', lookup),
    ).rejects.toThrow(/not routable/);
    // One public and one private answer: refuse unless EVERY address is clean.
    await expect(
      assertWebhookTargetAllowed('http://rebind.example.invalid/hook', lookup),
    ).rejects.toThrow(/not routable/);
  });

  it('fails closed when the name does not resolve', async () => {
    const lookup = fakeLookup({});
    await expect(
      assertWebhookTargetAllowed('https://nonexistent.example.invalid/hook', lookup),
    ).rejects.toThrow(/does not resolve/);
  });
});
