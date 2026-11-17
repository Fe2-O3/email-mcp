import offlineNotice from './offline-notice.js';

describe('offlineNotice', () => {
  it('is absent for a live read', () => {
    expect(offlineNotice({})).toBeUndefined();
  });

  it('names the cache time and the staleness caveat', () => {
    expect(offlineNotice({ offline: { cachedAt: '2026-08-01T10:00:00.000Z' } })).toBe(
      '⚠ Offline: served from local cache (cached 2026-08-01T10:00:00.000Z). Flags may be stale and the message may have been moved or deleted.',
    );
  });
});
