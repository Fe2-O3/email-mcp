import type { IConnectionManager } from '../connections/types.js';
import eventBus from '../services/event-bus.js';
import BodyCache from './body-cache.js';
import CacheStore from './store.js';
import SyncEngine from './sync-engine.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

interface MockMessage {
  uid: number;
  envelope?: Record<string, unknown>;
  flags?: Set<string>;
  modseq?: bigint;
  bodyStructure?: unknown;
  internalDate?: Date;
}

/**
 * Shapes mirror what a real server returns — verified against a live IMAP
 * server: `uidValidity` and `highestModseq` are bigint, and `highestModseq`
 * is absent entirely when the server lacks CONDSTORE.
 */
/** ImapFlow exposes capabilities as a Map, not a Set (imap-flow.d.ts:761). */
function capabilityMap(names: string[]): Map<string, boolean | number> {
  return new Map(names.map((n) => [n, true]));
}

function createMockClient(options: { capabilities?: string[] } = {}) {
  const release = vi.fn();
  return {
    capabilities: capabilityMap(options.capabilities ?? []),
    mailbox: {
      uidValidity: 100n,
      uidNext: 10,
      exists: 3,
      highestModseq: undefined as bigint | undefined,
    },
    getMailboxLock: vi.fn().mockResolvedValue({ release }),
    mailboxOpen: vi.fn(),
    search: vi.fn().mockResolvedValue([]),
    fetch: vi.fn().mockImplementation(() => (async function* none() {})()),
    status: vi.fn().mockResolvedValue({}),
    _release: release,
  };
}

function messagesFrom(...messages: MockMessage[]) {
  return () =>
    (async function* gen() {
      for (const m of messages) {
        yield {
          uid: m.uid,
          envelope: m.envelope ?? { subject: `Subject ${m.uid}`, date: new Date('2026-08-01') },
          flags: m.flags ?? new Set(['\\Seen']),
          modseq: m.modseq,
          bodyStructure: m.bodyStructure ?? { type: 'text/plain', size: 10 },
          internalDate: m.internalDate ?? new Date('2026-08-01'),
        };
      }
    })();
}

function createConnections(client: ReturnType<typeof createMockClient>) {
  return {
    getAccount: vi.fn().mockReturnValue({ name: 'work' }),
    getAccountNames: vi.fn().mockReturnValue(['work']),
    getImapClient: vi.fn().mockResolvedValue(client),
    getSmtpTransport: vi.fn(),
    closeAll: vi.fn(),
  } as unknown as IConnectionManager;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SyncEngine', () => {
  let store: CacheStore;
  let client: ReturnType<typeof createMockClient>;
  let engine: SyncEngine;

  function build(capabilities: string[] = []): SyncEngine {
    client = createMockClient({ capabilities });
    return new SyncEngine(createConnections(client), store);
  }

  beforeEach(() => {
    store = new CacheStore(':memory:');
  });

  afterEach(() => {
    engine?.stop();
    store.close();
    eventBus.removeAllListeners();
  });

  // -------------------------------------------------------------------------
  // Capability tiers
  // -------------------------------------------------------------------------

  describe('tier detection', () => {
    it('uses qresync when the server advertises it', async () => {
      engine = build(['QRESYNC', 'CONDSTORE']);
      expect(await engine.detectTier('work')).toBe('qresync');
    });

    it('falls back to condstore when qresync is absent', async () => {
      // This is Gmail: it advertises CONDSTORE and X-GM-EXT-1 but never
      // QRESYNC, so it cannot report expunges via modseq.
      engine = build(['CONDSTORE', 'X-GM-EXT-1']);
      expect(await engine.detectTier('work')).toBe('condstore');
    });

    it('falls back to baseline when neither is advertised', async () => {
      engine = build(['IMAP4rev1', 'IDLE', 'MOVE']);
      expect(await engine.detectTier('work')).toBe('baseline');
    });

    it('probes the connection only once per account', async () => {
      client = createMockClient({ capabilities: ['QRESYNC'] });
      const connections = createConnections(client);
      engine = new SyncEngine(connections, store);

      await engine.detectTier('work');
      await engine.detectTier('work');

      expect(connections.getImapClient).toHaveBeenCalledTimes(1);
    });

    it('deduplicates concurrent probes for the same account', async () => {
      client = createMockClient({ capabilities: ['QRESYNC'] });
      const connections = createConnections(client);
      engine = new SyncEngine(connections, store);

      const [a, b] = await Promise.all([engine.detectTier('work'), engine.detectTier('work')]);

      expect(a).toBe('qresync');
      expect(b).toBe('qresync');
      expect(connections.getImapClient).toHaveBeenCalledTimes(1);
    });

    it('re-probes after a reconnect', async () => {
      client = createMockClient({ capabilities: ['QRESYNC'] });
      const connections = createConnections(client);
      engine = new SyncEngine(connections, store);
      engine.start();

      expect(await engine.detectTier('work')).toBe('qresync');

      // A reconnect may land on a different server for the same account, so
      // capabilities probed against the old connection cannot be trusted.
      client.capabilities = capabilityMap(['IMAP4rev1']);
      eventBus.emit('imap:reconnect', { account: 'work' });

      expect(await engine.detectTier('work')).toBe('baseline');
    });
  });

  // -------------------------------------------------------------------------
  // UIDVALIDITY epoch
  // -------------------------------------------------------------------------

  describe('UIDVALIDITY epoch', () => {
    it('records the epoch on first sync', async () => {
      engine = build();
      client.search.mockResolvedValue([]);

      await engine.syncMailbox('work', 'INBOX');

      expect(store.getMailboxState('work', 'INBOX')?.uidValidity).toBe('100');
    });

    it('purges the mirror when UIDVALIDITY changes', async () => {
      engine = build();
      client.fetch.mockImplementation(messagesFrom({ uid: 1 }, { uid: 2 }));
      client.search.mockResolvedValue([1, 2]);
      await engine.syncMailbox('work', 'INBOX');
      expect(store.countMessages('work', 'INBOX')).toBe(2);

      // The mailbox was recreated server-side: every cached UID now refers to
      // a different message, so the whole generation must go.
      client.mailbox.uidValidity = 999n;
      client.mailbox.uidNext = 1;
      client.fetch.mockImplementation(messagesFrom());
      client.search.mockResolvedValue([]);
      await engine.syncMailbox('work', 'INBOX');

      expect(store.countMessages('work', 'INBOX')).toBe(0);
      expect(store.getMailboxState('work', 'INBOX')?.uidValidity).toBe('999');
    });

    it('keeps the mirror when UIDVALIDITY is unchanged', async () => {
      engine = build();
      client.fetch.mockImplementation(messagesFrom({ uid: 1 }));
      client.search.mockResolvedValue([1]);
      await engine.syncMailbox('work', 'INBOX');

      client.fetch.mockImplementation(messagesFrom());
      await engine.syncMailbox('work', 'INBOX');

      expect(store.countMessages('work', 'INBOX')).toBe(1);
    });
  });

  // -------------------------------------------------------------------------
  // Baseline tier
  // -------------------------------------------------------------------------

  describe('baseline tier', () => {
    it('stores fetched messages', async () => {
      engine = build();
      client.fetch.mockImplementation(messagesFrom({ uid: 5 }, { uid: 6 }));
      client.search.mockResolvedValue([5, 6]);

      await engine.syncMailbox('work', 'INBOX');

      expect(store.getMessage('work', 'INBOX', 5, '100')).toBeDefined();
      expect(store.getMessage('work', 'INBOX', 6, '100')).toBeDefined();
    });

    it('only fetches above the stored watermark on a second sync', async () => {
      engine = build();
      client.fetch.mockImplementation(messagesFrom({ uid: 5 }));
      client.search.mockResolvedValue([5]);
      await engine.syncMailbox('work', 'INBOX');

      client.mailbox.uidNext = 20;
      client.fetch.mockClear();
      client.fetch.mockImplementation(messagesFrom({ uid: 15 }));
      client.search.mockResolvedValue([5, 15]);
      await engine.syncMailbox('work', 'INBOX');

      // Refetching from 1 would re-download the entire mailbox every sync.
      const [range] = client.fetch.mock.calls[0];
      expect(range).toBe('10:*');
    });

    it('removes messages the server no longer lists', async () => {
      engine = build();
      client.fetch.mockImplementation(messagesFrom({ uid: 1 }, { uid: 2 }, { uid: 3 }));
      client.search.mockResolvedValue([1, 2, 3]);
      client.mailbox.exists = 3;
      await engine.syncMailbox('work', 'INBOX');

      // uid 2 was deleted by another client. Without a UID-set diff a
      // baseline-tier server gives no signal at all, and the mirror would
      // keep serving a message that no longer exists. `exists` moves with the
      // search result, as it does on a server that is not mid-resync.
      client.fetch.mockImplementation(messagesFrom());
      client.search.mockResolvedValue([1, 3]);
      client.mailbox.exists = 2;
      await engine.syncMailbox('work', 'INBOX');

      expect(store.getMessage('work', 'INBOX', 2, '100')).toBeUndefined();
      expect(store.countMessages('work', 'INBOX')).toBe(2);
    });
  });

  // -------------------------------------------------------------------------
  // CONDSTORE tier
  // -------------------------------------------------------------------------

  describe('condstore tier', () => {
    it('passes changedSince once a modseq watermark exists', async () => {
      engine = build(['CONDSTORE']);
      client.mailbox.highestModseq = 500n;
      client.fetch.mockImplementation(messagesFrom({ uid: 1, modseq: 400n }));
      client.search.mockResolvedValue([1]);
      await engine.syncMailbox('work', 'INBOX');

      expect(store.getMailboxState('work', 'INBOX')?.highestModseq).toBe('500');

      client.mailbox.highestModseq = 700n;
      client.fetch.mockClear();
      client.fetch.mockImplementation(messagesFrom({ uid: 1, modseq: 650n }));
      await engine.syncMailbox('work', 'INBOX');

      const changedSince = client.fetch.mock.calls.at(-1)?.[2]?.changedSince;
      expect(changedSince).toBe(500n);
    });

    it('picks up a flag change made by another client', async () => {
      engine = build(['CONDSTORE']);
      client.mailbox.highestModseq = 500n;
      client.fetch.mockImplementation(
        messagesFrom({ uid: 1, flags: new Set(['\\Seen']), modseq: 400n }),
      );
      client.search.mockResolvedValue([1]);
      await engine.syncMailbox('work', 'INBOX');
      expect(store.getMessage('work', 'INBOX', 1, '100')?.flags).toEqual(['\\Seen']);

      client.mailbox.highestModseq = 700n;
      client.fetch.mockImplementation(
        messagesFrom({ uid: 1, flags: new Set(['\\Seen', '\\Flagged']), modseq: 650n }),
      );
      await engine.syncMailbox('work', 'INBOX');

      expect(store.getMessage('work', 'INBOX', 1, '100')?.flags).toEqual(['\\Seen', '\\Flagged']);
    });
  });

  // -------------------------------------------------------------------------
  // Resilience
  // -------------------------------------------------------------------------

  describe('deletion reconciliation safety', () => {
    async function seedThree(): Promise<void> {
      client.fetch.mockImplementation(messagesFrom({ uid: 1 }, { uid: 2 }, { uid: 3 }));
      client.search.mockResolvedValue([1, 2, 3]);
      client.mailbox.exists = 3;
      await engine.syncMailbox('work', 'INBOX');
    }

    it('does not purge the mirror when the server reports an empty mailbox it should not', async () => {
      engine = build();
      await seedThree();
      expect(store.countMessages('work', 'INBOX')).toBe(3);

      // Observed against a real server mid-resync: SEARCH returns nothing
      // while SELECT still reports messages present. Believing SEARCH here
      // deletes the entire mirror for a mailbox that is perfectly intact.
      client.search.mockResolvedValue([]);
      client.mailbox.exists = 3;
      client.fetch.mockImplementation(messagesFrom());
      await engine.syncMailbox('work', 'INBOX');

      expect(store.countMessages('work', 'INBOX')).toBe(3);
    });

    it('still removes messages when SEARCH and SELECT agree', async () => {
      engine = build();
      await seedThree();

      // Genuine deletion: both the search result and the message count drop.
      client.search.mockResolvedValue([1, 3]);
      client.mailbox.exists = 2;
      client.fetch.mockImplementation(messagesFrom());
      await engine.syncMailbox('work', 'INBOX');

      expect(store.countMessages('work', 'INBOX')).toBe(2);
      expect(store.getMessage('work', 'INBOX', 2, '100')).toBeUndefined();
    });

    it('accepts a genuinely emptied mailbox', async () => {
      engine = build();
      await seedThree();

      client.search.mockResolvedValue([]);
      client.mailbox.exists = 0;
      client.fetch.mockImplementation(messagesFrom());
      await engine.syncMailbox('work', 'INBOX');

      expect(store.countMessages('work', 'INBOX')).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Retention caps (window_days / max_size_mb)
  // -------------------------------------------------------------------------

  describe('retention caps', () => {
    function buildWithRetention(retention: { windowDays?: number; maxSizeMb?: number }) {
      client = createMockClient();
      return new SyncEngine(createConnections(client), store, retention);
    }

    it('drops mail older than window_days after a sync', async () => {
      engine = buildWithRetention({ windowDays: 90 });
      client.fetch.mockImplementation(
        messagesFrom({ uid: 1, internalDate: new Date('2020-01-01') }),
      );
      client.search.mockResolvedValue([1]);
      client.mailbox.exists = 1;

      const result = await engine.syncMailbox('work', 'INBOX');

      expect(result.ok).toBe(true);
      expect(result.pruned).toBe(1);
      expect(store.getMessage('work', 'INBOX', 1, '100')).toBeUndefined();
    });

    it('keeps recent mail inside the window', async () => {
      engine = buildWithRetention({ windowDays: 90 });
      client.fetch.mockImplementation(messagesFrom({ uid: 1, internalDate: new Date() }));
      client.search.mockResolvedValue([1]);
      client.mailbox.exists = 1;

      const result = await engine.syncMailbox('work', 'INBOX');

      expect(result.pruned).toBe(0);
      expect(store.getMessage('work', 'INBOX', 1, '100')).toBeDefined();
    });

    it('prunes oldest-first when the mirror exceeds max_size_mb', async () => {
      // A hundredth of a kilobyte: any real database page exceeds it, so the
      // backstop must fire no matter how small the fixture is.
      engine = buildWithRetention({ maxSizeMb: 0.0001 });
      client.fetch.mockImplementation(messagesFrom({ uid: 1 }, { uid: 2 }));
      client.search.mockResolvedValue([1, 2]);
      client.mailbox.exists = 2;

      const result = await engine.syncMailbox('work', 'INBOX');

      expect(result.ok).toBe(true);
      expect(result.pruned).toBeGreaterThan(0);
      expect(store.countMessages('work', 'INBOX')).toBe(0);
    });

    it('applies no caps when none are configured', async () => {
      engine = build();
      client.fetch.mockImplementation(
        messagesFrom({ uid: 1, internalDate: new Date('2020-01-01') }),
      );
      client.search.mockResolvedValue([1]);
      client.mailbox.exists = 1;

      const result = await engine.syncMailbox('work', 'INBOX');

      expect(result.pruned).toBe(0);
      expect(store.getMessage('work', 'INBOX', 1, '100')).toBeDefined();
    });
  });

  describe('resilience', () => {
    it('leaves existing rows in place when a sync fails', async () => {
      engine = build();
      client.fetch.mockImplementation(messagesFrom({ uid: 1 }));
      client.search.mockResolvedValue([1]);
      await engine.syncMailbox('work', 'INBOX');

      client.getMailboxLock.mockRejectedValue(new Error('ECONNRESET'));

      // A stale row still answers a question; a deleted one cannot. Sync
      // failures must never escalate into data loss.
      await expect(engine.syncMailbox('work', 'INBOX')).resolves.toBeDefined();
      expect(store.countMessages('work', 'INBOX')).toBe(1);
    });

    it('reports failure rather than throwing', async () => {
      engine = build();
      client.getMailboxLock.mockRejectedValue(new Error('ECONNRESET'));

      const result = await engine.syncMailbox('work', 'INBOX');

      expect(result.ok).toBe(false);
      expect(result.error).toMatch(/ECONNRESET/);
    });

    it('releases the mailbox lock even when the fetch throws', async () => {
      engine = build();
      client.fetch.mockImplementation(() => {
        throw new Error('mid-stream failure');
      });

      await engine.syncMailbox('work', 'INBOX');

      expect(client._release).toHaveBeenCalled();
    });
  });
});

// ---------------------------------------------------------------------------
// Body backfill
// ---------------------------------------------------------------------------

describe('SyncEngine body backfill', () => {
  let store: CacheStore;
  let client: ReturnType<typeof createMockClient> & {
    fetchOne: ReturnType<typeof vi.fn>;
    download: ReturnType<typeof vi.fn>;
  };
  let engine: SyncEngine;

  /** N messages, uid i dated i days after epoch, so a higher uid is newer. */
  function seedServer(count: number): void {
    const uids = Array.from({ length: count }, (_, i) => i + 1);
    client.fetch.mockImplementation(
      messagesFrom(...uids.map((uid) => ({ uid, internalDate: new Date(uid * 86_400_000) }))),
    );
    client.search.mockResolvedValue(uids);
    client.mailbox.exists = count;
  }

  function build(
    backfill: { bodyMessages?: number; bodyMaxMb?: number; batch?: number } | undefined,
  ): SyncEngine {
    const base = createMockClient();
    client = Object.assign(base, {
      fetchOne: vi.fn(async (seq: string) => ({
        uid: Number(seq),
        envelope: { subject: `Subject ${seq}` },
        bodyStructure: { type: 'text/plain', size: 5 },
        headers: Buffer.from('Subject: x\r\n\r\n'),
      })),
      download: vi.fn(async () => ({
        content: (async function* gen() {
          yield Buffer.from('body text');
        })(),
      })),
    });
    return new SyncEngine(
      createConnections(client),
      store,
      {},
      backfill
        ? {
            cache: new BodyCache(store, backfill.bodyMaxMb ?? 200),
            bodyMessages: backfill.bodyMessages ?? 500,
            bodyMaxMb: backfill.bodyMaxMb ?? 200,
            batch: backfill.batch,
          }
        : undefined,
    );
  }

  beforeEach(() => {
    store = new CacheStore(':memory:');
  });

  afterEach(() => {
    engine?.stop();
    store.close();
    eventBus.removeAllListeners();
  });

  it('fetches at most one batch per cycle, newest first', async () => {
    engine = build({ batch: 3 });
    seedServer(10);

    const result = await engine.syncMailbox('work', 'INBOX');

    expect(result.ok).toBe(true);
    expect(client.fetchOne.mock.calls.map((c) => c[0])).toEqual(['10', '9', '8']);
    expect(store.getBody('work', 'INBOX', 10, '100')?.status).toBe('ok');
    expect(store.getBody('work', 'INBOX', 7, '100')).toBeUndefined();
  });

  it('only considers the newest body_messages messages', async () => {
    engine = build({ batch: 10, bodyMessages: 2 });
    seedServer(5);

    await engine.syncMailbox('work', 'INBOX');

    expect(client.fetchOne.mock.calls.map((c) => c[0])).toEqual(['5', '4']);
  });

  it('continues with the next batch on the next cycle', async () => {
    engine = build({ batch: 2 });
    seedServer(4);

    await engine.syncMailbox('work', 'INBOX');
    await engine.syncMailbox('work', 'INBOX');

    expect(client.fetchOne.mock.calls.map((c) => c[0])).toEqual(['4', '3', '2', '1']);
  });

  it('takes and releases the mailbox lock once per message', async () => {
    engine = build({ batch: 3 });
    seedServer(3);

    await engine.syncMailbox('work', 'INBOX');

    // One lock for the reconcile, one per backfilled message.
    expect(client.getMailboxLock).toHaveBeenCalledTimes(1 + 3);
    expect(client._release).toHaveBeenCalledTimes(1 + 3);
  });

  it('skips a vanished UID and keeps going', async () => {
    engine = build({ batch: 3 });
    seedServer(3);
    client.fetchOne.mockImplementation(async (seq: string) =>
      seq === '3'
        ? null
        : {
            uid: Number(seq),
            envelope: {},
            bodyStructure: { type: 'text/plain', size: 5 },
            headers: Buffer.from(''),
          },
    );

    const result = await engine.syncMailbox('work', 'INBOX');

    expect(result.ok).toBe(true);
    expect(store.getBody('work', 'INBOX', 3, '100')).toBeUndefined();
    expect(store.getBody('work', 'INBOX', 2, '100')?.status).toBe('ok');
  });

  it('marks a failing message skipped/error, continues, and the sync is still ok', async () => {
    engine = build({ batch: 3 });
    seedServer(3);
    client.fetchOne.mockImplementation(async (seq: string) => {
      if (seq === '3') throw new Error('Command failed');
      return {
        uid: Number(seq),
        envelope: {},
        bodyStructure: { type: 'text/plain', size: 5 },
        headers: Buffer.from(''),
      };
    });

    const result = await engine.syncMailbox('work', 'INBOX');

    expect(result.ok).toBe(true);
    expect(store.getBody('work', 'INBOX', 3, '100')).toMatchObject({
      status: 'skipped',
      skipReason: 'error',
    });
    expect(store.getBody('work', 'INBOX', 2, '100')?.status).toBe('ok');
    // A skipped row is not retried by the next cycle.
    client.fetchOne.mockClear();
    await engine.syncMailbox('work', 'INBOX');
    expect(client.fetchOne.mock.calls.map((c) => c[0])).not.toContain('3');
  });

  it('does not mark messages skipped when the connection drops', async () => {
    engine = build({ batch: 3 });
    seedServer(3);
    client.fetchOne.mockRejectedValue(Object.assign(new Error('closed'), { code: 'ECONNRESET' }));

    await engine.syncMailbox('work', 'INBOX');

    expect(client.fetchOne).toHaveBeenCalledTimes(1);
    expect(store.getBody('work', 'INBOX', 3, '100')).toBeUndefined();
  });

  it('stops fetching once aborted between messages', async () => {
    engine = build({ batch: 5 });
    seedServer(5);
    // Pretend stop() arrives while the first message is downloading.
    client.fetchOne.mockImplementation(async (seq: string) => {
      engine.stop();
      return {
        uid: Number(seq),
        envelope: {},
        bodyStructure: { type: 'text/plain', size: 5 },
        headers: Buffer.from(''),
      };
    });

    await engine.syncMailbox('work', 'INBOX');

    expect(client.fetchOne).toHaveBeenCalledTimes(1);
  });

  it('stops at the body budget', async () => {
    engine = build({ batch: 5, bodyMaxMb: 1 });
    seedServer(3);
    // Budget already full.
    store.putBodyBundle(
      'work',
      'Other',
      1,
      '1',
      { envelope: {}, bodyStructure: {}, headersRaw: 'x'.repeat(1024 * 1024) },
      1,
    );

    await engine.syncMailbox('work', 'INBOX');

    expect(client.fetchOne).not.toHaveBeenCalled();
  });

  it('does not backfill when read_through is off (no backfill config)', async () => {
    engine = build(undefined);
    seedServer(3);

    const result = await engine.syncMailbox('work', 'INBOX');

    expect(result.ok).toBe(true);
    expect(client.fetchOne).not.toHaveBeenCalled();
    expect(client.getMailboxLock).toHaveBeenCalledTimes(1);
  });

  it('does not backfill when body_messages is 0', async () => {
    engine = build({ bodyMessages: 0 });
    seedServer(3);

    await engine.syncMailbox('work', 'INBOX');

    expect(client.fetchOne).not.toHaveBeenCalled();
  });

  it('keys rows by the sanitized mailbox name', async () => {
    engine = build({ batch: 1 });
    seedServer(2);

    await engine.syncMailbox('work', ' INBOX ');

    expect(store.getMailboxState('work', 'INBOX')).toBeDefined();
    expect(store.getBody('work', 'INBOX', 2, '100')?.status).toBe('ok');
  });

  it('reports a failed sync instead of throwing for an invalid mailbox name', async () => {
    engine = build({});

    const result = await engine.syncMailbox('work', 'bad*name');

    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/wildcard/);
  });

  describe('size backstop', () => {
    it('evicts bodies before pruning any message row', async () => {
      const base = createMockClient();
      client = Object.assign(base, { fetchOne: vi.fn(), download: vi.fn() });
      engine = new SyncEngine(createConnections(client), store, { maxSizeMb: 0.0001 });
      // More bodies than ten bounded eviction rounds can clear.
      for (let uid = 1; uid <= 5100; uid += 1) {
        store.putBodyBundle(
          'work',
          'INBOX',
          uid,
          '100',
          { envelope: {}, bodyStructure: {}, headersRaw: 'h', bodyText: 'b' },
          1,
        );
      }
      seedServer(2);

      const result = await engine.syncMailbox('work', 'INBOX');

      expect(result.ok).toBe(true);
      expect(store.countOkBodies()).toBe(100);
      // Still over budget, but content bodies remain, so no message row is pruned.
      expect(result.pruned).toBe(0);
      expect(store.countMessages('work', 'INBOX')).toBe(2);
    });

    it('prunes message rows only once no content bodies remain', async () => {
      const base = createMockClient();
      client = Object.assign(base, { fetchOne: vi.fn(), download: vi.fn() });
      engine = new SyncEngine(createConnections(client), store, { maxSizeMb: 0.0001 });
      store.putBodyBundle(
        'work',
        'INBOX',
        1,
        '100',
        { envelope: {}, bodyStructure: {}, headersRaw: 'h', bodyText: 'b' },
        1,
      );
      seedServer(2);

      const result = await engine.syncMailbox('work', 'INBOX');

      expect(store.countOkBodies()).toBe(0);
      expect(result.pruned).toBeGreaterThan(0);
    });
  });
});
