import BodyCache from '../cache/body-cache.js';
import CacheStore from '../cache/store.js';
import type { IConnectionManager } from '../connections/types.js';
import ImapService, { BODY_EXTRACTOR_VERSION, fetchBodyBundle } from './imap.service.js';

function downloadYielding(text: string) {
  return {
    content: (async function* gen() {
      yield Buffer.from(text, 'utf-8');
    })(),
  };
}

const liveMsg = (flags: string[]) => ({
  uid: 42,
  envelope: { subject: 'Cached', messageId: '<c@x>', date: new Date('2026-08-01T10:00:00Z') },
  flags: new Set(flags),
  bodyStructure: { type: 'text/plain', size: 10 },
  headers: Buffer.from('Subject: Cached\r\n\r\n', 'utf-8'),
});

function makeClient() {
  const client = {
    mailbox: { uidValidity: 100n } as { uidValidity: bigint } | false,
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    fetchOne: vi.fn(),
    download: vi.fn(),
  };
  client.download.mockImplementation(async () => downloadYielding('the body'));
  return client;
}

describe('ImapService.getEmail read-through', () => {
  let store: CacheStore;
  let client: ReturnType<typeof makeClient>;
  let service: ImapService;

  const fullFetch = (flags: string[]) => (_seq: string, query: Record<string, unknown>) =>
    Promise.resolve(query.envelope ? liveMsg(flags) : { uid: 42, flags: new Set(flags) });

  beforeEach(() => {
    store = new CacheStore(':memory:');
    client = makeClient();
    const connections = {
      getImapClient: vi.fn().mockResolvedValue(client),
    } as unknown as IConnectionManager;
    service = new ImapService(connections);
    service.attachBodyCache(new BodyCache(store, 200));
  });

  afterEach(() => {
    service.dispose();
    store.close();
  });

  it('misses live, writes back, then hits with only a FLAGS fetch', async () => {
    client.fetchOne.mockImplementation(fullFetch(['\\Seen']));

    const first = await service.getEmail('acct', '42', 'INBOX');
    expect(client.download).toHaveBeenCalledTimes(1);

    client.download.mockClear();
    client.fetchOne.mockClear();
    const second = await service.getEmail('acct', '42', 'INBOX');

    expect(second).toEqual(first);
    expect(client.download).not.toHaveBeenCalled();
    expect(client.fetchOne).toHaveBeenCalledTimes(1);
    expect(client.fetchOne).toHaveBeenCalledWith('42', { uid: true, flags: true }, { uid: true });
  });

  it('throws the live not-found error when the hit finds the message gone', async () => {
    client.fetchOne.mockImplementation(fullFetch([]));
    await service.getEmail('acct', '42', 'INBOX');

    client.fetchOne.mockResolvedValue(null);

    await expect(service.getEmail('acct', '42', 'INBOX')).rejects.toThrow(
      'Email 42 not found in INBOX',
    );
  });

  it('returns current flags on a hit', async () => {
    client.fetchOne.mockImplementation(fullFetch([]));
    const first = await service.getEmail('acct', '42', 'INBOX');
    expect(first.seen).toBe(false);

    client.fetchOne.mockImplementation(fullFetch(['\\Seen', '\\Flagged']));
    const second = await service.getEmail('acct', '42', 'INBOX');

    expect(second.seen).toBe(true);
    expect(second.flagged).toBe(true);
  });

  it('misses when UIDVALIDITY changed', async () => {
    client.fetchOne.mockImplementation(fullFetch([]));
    await service.getEmail('acct', '42', 'INBOX');
    client.download.mockClear();

    client.mailbox = { uidValidity: 101n };
    await service.getEmail('acct', '42', 'INBOX');

    expect(client.download).toHaveBeenCalledTimes(1);
  });

  it('retries live when an earlier read was incomplete', async () => {
    client.fetchOne.mockImplementation(fullFetch([]));
    client.download.mockRejectedValueOnce(new Error('transient'));
    const first = await service.getEmail('acct', '42', 'INBOX');
    expect(first.bodyText).toBeUndefined();

    const second = await service.getEmail('acct', '42', 'INBOX');

    expect(second.bodyText).toBe('the body');
  });

  it('keys a whitespace-padded mailbox name as the trimmed name', async () => {
    // As backfill would write it: keyed by the sanitized (trimmed) name.
    const { complete: _c, ...data } = await fetchBodyBundle(
      liveMsg([]) as unknown as Record<string, unknown>,
      client as never,
      42,
    );
    store.putBodyBundle('acct', 'INBOX', 42, '100', data, BODY_EXTRACTOR_VERSION);
    client.fetchOne.mockImplementation(fullFetch([]));
    client.download.mockClear();

    await service.getEmail('acct', '42', ' INBOX ');

    expect(client.download).not.toHaveBeenCalled();
  });

  it('does not touch the cache path at all without an attached port', async () => {
    const plainConnections = {
      getImapClient: vi.fn().mockResolvedValue(client),
    } as unknown as IConnectionManager;
    const plain = new ImapService(plainConnections);
    client.fetchOne.mockImplementation(fullFetch([]));

    await plain.getEmail('acct', '42', 'INBOX');
    await plain.getEmail('acct', '42', 'INBOX');
    plain.dispose();

    // Two full live fetches, two downloads, never a flags-only fetch.
    expect(client.fetchOne).toHaveBeenCalledTimes(2);
    client.fetchOne.mock.calls.forEach((call) => {
      expect(call[1]).toEqual({
        uid: true,
        envelope: true,
        flags: true,
        bodyStructure: true,
        headers: true,
      });
    });
    expect(client.download).toHaveBeenCalledTimes(2);
    expect(client.getMailboxLock).toHaveBeenCalledWith('INBOX');
    expect(store.getBody('acct', 'INBOX', 42, '100')).toBeUndefined();
  });

  it('forgets cached bodies after a successful delete', async () => {
    client.fetchOne.mockImplementation(fullFetch([]));
    await service.getEmail('acct', '42', 'INBOX');
    expect(store.getBody('acct', 'INBOX', 42, '100')).toBeDefined();

    (client as unknown as Record<string, unknown>).messageDelete = vi.fn().mockResolvedValue(true);
    await service.deleteEmail('acct', '42', 'INBOX', true);

    expect(store.getBody('acct', 'INBOX', 42, '100')).toBeUndefined();
  });
});
