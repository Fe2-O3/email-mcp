import type { BodyBundle } from '../services/imap.service.js';
import { BODY_EXTRACTOR_VERSION, MAX_CACHED_BODY_BYTES } from '../services/imap.service.js';
import BodyCache from './body-cache.js';
import CacheStore from './store.js';

const bundle = (overrides: Partial<BodyBundle> = {}): BodyBundle => ({
  envelope: { subject: 'Hi' },
  bodyStructure: { type: 'text/plain' },
  headersRaw: 'Subject: Hi\r\n',
  bodyText: 'hello',
  complete: true,
  ...overrides,
});

describe('BodyCache', () => {
  let store: CacheStore;
  let cache: BodyCache;

  beforeEach(() => {
    store = new CacheStore(':memory:');
    cache = new BodyCache(store);
  });

  afterEach(() => {
    try {
      store.close();
    } catch {
      // already closed by the test
    }
  });

  it('round-trips a complete bundle', () => {
    cache.put('a', 'INBOX', 1, '10', bundle());

    expect(cache.get('a', 'INBOX', 1, '10')).toEqual(bundle());
  });

  it('stores an oversize body as skipped and misses', () => {
    cache.put('a', 'INBOX', 1, '10', bundle({ bodyText: 'x'.repeat(MAX_CACHED_BODY_BYTES + 1) }));

    expect(cache.get('a', 'INBOX', 1, '10')).toBeUndefined();
    expect(store.getBody('a', 'INBOX', 1, '10')).toMatchObject({
      status: 'skipped',
      skipReason: 'oversize',
    });
  });

  it('stores an incomplete bundle as skipped and misses', () => {
    cache.put('a', 'INBOX', 1, '10', bundle({ complete: false }));

    expect(cache.get('a', 'INBOX', 1, '10')).toBeUndefined();
    expect(store.getBody('a', 'INBOX', 1, '10')).toMatchObject({
      status: 'skipped',
      skipReason: 'incomplete',
    });
  });

  it('treats a row from an older extractor as a miss', () => {
    const { complete: _c, ...data } = bundle();
    store.putBodyBundle('a', 'INBOX', 1, '10', data, BODY_EXTRACTOR_VERSION - 1);

    expect(cache.get('a', 'INBOX', 1, '10')).toBeUndefined();
  });

  it('degrades to a miss and a no-op when the store throws', () => {
    store.close();

    expect(cache.get('a', 'INBOX', 1, '10')).toBeUndefined();
    expect(() => cache.put('a', 'INBOX', 1, '10', bundle())).not.toThrow();
    expect(() => cache.forget('a', 'INBOX', [1])).not.toThrow();
  });

  it('evicts least recently used bodies when over budget', () => {
    // 1 MB budget, eight 200 KB bodies: the oldest must be evicted.
    const tiny = new BodyCache(store, 1);
    const big = 'y'.repeat(200 * 1024);
    for (let uid = 1; uid <= 8; uid += 1) {
      tiny.put('a', 'INBOX', uid, '10', bundle({ bodyText: big }));
    }

    expect(store.bodyBytes()).toBeLessThanOrEqual(1024 * 1024);
    expect(store.bodyBytes()).toBeGreaterThan(0);
  });
});
