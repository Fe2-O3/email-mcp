/**
 * Adapter between ImapService's `BodyCachePort` and the SQLite store.
 *
 * Every method swallows its own errors and degrades to a miss or a no-op. The
 * cache is an optimization over a working live path, so a corrupt file, a full
 * disk or a closed database must never turn a read that would have succeeded
 * into a failure.
 */

import type { BodyBundle, BodyCachePort } from '../services/imap.service.js';
import { BODY_EXTRACTOR_VERSION, MAX_CACHED_BODY_BYTES } from '../services/imap.service.js';
import type CacheStore from './store.js';

/** At most this many eviction rounds per call, so one write cannot stall a read. */
const MAX_EVICT_ROUNDS = 10;
const EVICT_BATCH = 500;

export default class BodyCache implements BodyCachePort {
  constructor(
    private store: CacheStore,
    /** LRU budget for cached bodies in megabytes; 0 or less disables the budget. */
    private bodyMaxMb = 0,
  ) {}

  get(account: string, mailbox: string, uid: number, uidValidity: string): BodyBundle | undefined {
    try {
      const row = this.store.getBody(account, mailbox, uid, uidValidity);
      // Skipped rows and rows from an older extractor are misses, so a decoding
      // fix is never shadowed by a stale cached body.
      if (row?.status !== 'ok' || !row.bundle || row.extractorVersion !== BODY_EXTRACTOR_VERSION) {
        return undefined;
      }
      this.store.touchBody(account, mailbox, uid, uidValidity);
      return { ...row.bundle, complete: true };
    } catch {
      return undefined;
    }
  }

  put(
    account: string,
    mailbox: string,
    uid: number,
    uidValidity: string,
    bundle: BodyBundle,
  ): void {
    try {
      if (!bundle.complete) {
        // A transient download failure must not be served forever: the read
        // path treats skipped rows as misses and retries live.
        this.store.markBodySkipped(
          account,
          mailbox,
          uid,
          uidValidity,
          'incomplete',
          BODY_EXTRACTOR_VERSION,
        );
        return;
      }

      const bytes =
        Buffer.byteLength(bundle.headersRaw, 'utf-8') +
        Buffer.byteLength(bundle.bodyText ?? '', 'utf-8') +
        Buffer.byteLength(bundle.bodyHtml ?? '', 'utf-8');
      if (bytes > MAX_CACHED_BODY_BYTES) {
        // Never truncate: a shortened body would differ from the live answer.
        this.store.markBodySkipped(
          account,
          mailbox,
          uid,
          uidValidity,
          'oversize',
          BODY_EXTRACTOR_VERSION,
        );
        return;
      }

      const { complete: _complete, ...data } = bundle;
      this.store.putBodyBundle(account, mailbox, uid, uidValidity, data, BODY_EXTRACTOR_VERSION);
      this.enforceBudget();
    } catch {
      // No-op: see file header.
    }
  }

  forget(account: string, mailbox: string, uids: number[]): void {
    try {
      this.store.forgetBodies(account, mailbox, uids);
    } catch {
      // No-op: see file header.
    }
  }

  /** Evict least-recently-read bodies until under budget, in bounded rounds. */
  enforceBudget(): void {
    if (this.bodyMaxMb <= 0) return;
    const limit = this.bodyMaxMb * 1024 * 1024;
    for (let round = 0; round < MAX_EVICT_ROUNDS && this.store.bodyBytes() > limit; round += 1) {
      if (this.store.evictBodiesLru(EVICT_BATCH) === 0) break;
    }
  }
}
