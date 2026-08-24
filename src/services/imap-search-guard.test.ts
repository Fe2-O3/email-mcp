/**
 * Some IMAP servers answer SEARCH with something other than a UID list.
 * Treating any non-array response as "no matches" turned a broken server
 * into a confident-looking empty result: search_emails and every tool built
 * on it silently showed an empty mailbox, which reads as lost mail.
 *
 * The contract now: a usable response drives the result; an unusable one is
 * a loud error naming the problem. Genuine empty results stay empty.
 *
 * Upstream: codefuturist/email-mcp#71
 */

import ImapService from './imap.service.js';

function buildClient(searchResponse: unknown) {
  const releaseFn = vi.fn();
  return {
    usable: true,
    capabilities: new Set<string>(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: releaseFn }),
    search: vi.fn().mockResolvedValue(searchResponse),
  };
}

describe('broken SEARCH responses fail loudly', () => {
  it('a non-array SEARCH response throws instead of reporting an empty mailbox', async () => {
    const service = new ImapService({
      getImapClient: async () => buildClient({ ok: false, results: 'garbage' }),
    } as never);

    await expect(service.listEmails('test', {})).rejects.toThrow(/SEARCH/);
  });

  it('search_emails fails the same way', async () => {
    const service = new ImapService({
      getImapClient: async () => buildClient(undefined),
    } as never);

    await expect(service.searchEmails('test', '', {})).rejects.toThrow(/SEARCH/);
  });

  it('a genuine empty match set still returns an empty page, not an error', async () => {
    const service = new ImapService({
      getImapClient: async () => buildClient([]),
    } as never);

    const result = await service.listEmails('test', {});
    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
  });
});
