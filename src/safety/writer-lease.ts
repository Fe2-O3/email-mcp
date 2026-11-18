// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * One process per machine runs the mailbox writers: the new-mail watcher, hooks (alerts and AI
 * triage). Every MCP client window starts its own stdio server against the same accounts, and N
 * watchers mean N classifications, moves and alerts for each new message. The other processes
 * serve tools only and take over when the leader releases its lock, is killed, or stops renewing
 * it. The scheduler is not covered: it has its own lock.
 *
 * If the lock cannot be used at all (read-only or missing state directory, full disk), no process
 * runs the writers: two leaders without a lock would act on every message twice. The lease says
 * so once and tries again on every renewal.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { xdg } from '../config/xdg.js';
import { acquireClaim, errnoCode, releaseClaim } from '../utils/file-claim.js';

export const WRITER_LEASE_FILE = path.join(xdg.state, 'mailbox-writers.lock');
export const WRITER_LEASE_RENEW_MS = 30_000;
/** Four missed renewals, so a stalled event loop does not hand the lease over. */
export const WRITER_LEASE_STALE_MS = 4 * WRITER_LEASE_RENEW_MS;

export interface WriterLeaseOptions {
  lockPath: string;
  onLead: () => Promise<void> | void;
  onLose: () => Promise<void> | void;
  report: (message: string) => void;
  now?: () => number;
  /** Renewal interval. Defaults to {@link WRITER_LEASE_RENEW_MS}. */
  renewMs?: number;
  /** Heartbeat age after which a claim is stale. Defaults to {@link WRITER_LEASE_STALE_MS}. */
  staleMs?: number;
}

export interface WriterLease {
  readonly leading: boolean;
  /** Tries for the lease now and then on every renewal interval. */
  start: () => Promise<void>;
  /** One step: take a free or stale lease, or renew or lose the one held. */
  tick: () => Promise<void>;
  /** Stops trying, and waits for a writer start or stop still running. */
  halt: () => Promise<void>;
  /** Frees the lease for a follower. Call it once the writers have stopped. */
  release: () => Promise<void>;
}

type Holding = 'mine' | 'theirs' | 'missing';

async function whoHolds(lockPath: string, token: string): Promise<Holding> {
  try {
    return (await fs.readFile(lockPath, 'utf8')) === token ? 'mine' : 'theirs';
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return 'missing';
    throw err;
  }
}

/**
 * The file is missing: a follower parked it by rename to check it, or someone deleted it. Writing
 * it back with the same token, create-only, keeps the lease if nobody claimed it meanwhile; a
 * follower that links the parked file back then finds it taken and leaves it.
 */
async function claimBack(lockPath: string, token: string): Promise<Holding> {
  try {
    await fs.writeFile(lockPath, token, { flag: 'wx' });
    return 'mine';
  } catch (err) {
    const code = errnoCode(err);
    if (code === 'EEXIST') return whoHolds(lockPath, token);
    // The folder itself is gone: nobody can hold a lock there now.
    if (code === 'ENOENT') return 'missing';
    throw err;
  }
}

/** Errors that mean "no usable lock file here", as opposed to a transient hiccup. */
const LOCK_UNAVAILABLE = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOTDIR', 'EEXIST', 'ENOSPC']);

export function createWriterLease(options: WriterLeaseOptions): WriterLease {
  const now = options.now ?? Date.now;
  const renewMs = options.renewMs ?? WRITER_LEASE_RENEW_MS;
  const staleMs = options.staleMs ?? WRITER_LEASE_STALE_MS;
  let token: string | undefined;
  /** When the heartbeat was last written; a leader that cannot write it must step down. */
  let renewedAt = 0;
  let unusableReported = false;
  let halted = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;
  /**
   * Writer starts and stops, in order. A start is not awaited by the renewal step: connecting the
   * watcher can take longer than the stale window, and a heartbeat that waited on it would let a
   * second process take the lease meanwhile. A stop always waits for the start before it.
   */
  let writers: Promise<void> = Promise.resolve();

  const reportError = (err: unknown): void => {
    options.report(`Mailbox writer lease: ${err instanceof Error ? err.message : String(err)}`);
  };

  const queueWriters = (change: () => Promise<void> | void): Promise<void> => {
    writers = writers.then(change).catch(reportError);
    return writers;
  };

  const lose = async (): Promise<void> => {
    token = undefined;
    await queueWriters(options.onLose);
  };

  const acquire = async (): Promise<void> => {
    let acquired: string | undefined;
    try {
      await fs.mkdir(path.dirname(options.lockPath), { recursive: true, mode: 0o700 });
      acquired = await acquireClaim(options.lockPath, staleMs, now());
    } catch (err) {
      const code = errnoCode(err);
      if (code === undefined || !LOCK_UNAVAILABLE.has(code) || halted) throw err;
      if (!unusableReported) {
        unusableReported = true;
        options.report(
          `Mailbox writer lease: cannot use ${options.lockPath} (${code}); the watcher and hooks stay off until it works.`,
        );
      }
      return;
    }
    unusableReported = false;
    if (acquired === undefined) return;
    if (halted) {
      await releaseClaim(options.lockPath, acquired);
      return;
    }
    token = acquired;
    renewedAt = now();
    void queueWriters(options.onLead);
  };

  const renew = async (held: string): Promise<void> => {
    let holding: Holding;
    try {
      holding = await whoHolds(options.lockPath, held);
      if (holding === 'missing') holding = await claimBack(options.lockPath, held);
      if (holding === 'mine') {
        const at = new Date(now());
        await fs.utimes(options.lockPath, at, at);
        renewedAt = now();
        return;
      }
    } catch (err) {
      // Others judge this lock by its heartbeat. Step down one renewal before it can look stale,
      // so a follower that takes it over never runs beside this process.
      if (now() - renewedAt >= staleMs - renewMs) {
        reportError(err);
        options.report(
          'Mailbox writer lease: the lock could not be renewed, so this process stopped the watcher and hooks.',
        );
        await lose();
        return;
      }
      throw err;
    }
    await lose();
  };

  const step = async (): Promise<void> => {
    if (token === undefined) {
      await acquire();
      return;
    }
    await renew(token);
  };

  const tick = async (): Promise<void> => {
    running ??= step()
      .catch(reportError)
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  return {
    get leading() {
      return token !== undefined;
    },
    start: async () => {
      timer ??= setInterval(() => {
        tick().catch(() => undefined);
      }, renewMs);
      timer.unref();
      await tick();
    },
    tick,
    halt: async () => {
      halted = true;
      clearInterval(timer);
      await running;
      await writers;
    },
    release: async () => {
      if (token === undefined) return;
      const held = token;
      token = undefined;
      await releaseClaim(options.lockPath, held);
    },
  };
}
