// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * One process per machine runs the mailbox writers: the new-mail watcher, hooks (alerts and AI
 * triage). Every MCP client window starts its own stdio server against the same accounts, and N
 * watchers mean N classifications, moves and alerts for each new message. The other processes
 * serve tools only and take over when the leader releases its lock, is killed, or stops renewing
 * it. The scheduler is not covered: it has its own lock.
 *
 * If the lock cannot be used at all (read-only or missing state directory), this process leads
 * without a lock, as a single process always did, and says so once.
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
  /** Stops trying; writers already started keep running until the caller stops them. */
  halt: () => Promise<void>;
  /** Frees the lease for a follower. Call it once the writers have stopped. */
  release: () => Promise<void>;
}

/** Fails closed to "not mine" only for a missing file; any other read error is surfaced. */
async function stillHeld(lockPath: string, token: string): Promise<boolean> {
  try {
    return (await fs.readFile(lockPath, 'utf8')) === token;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
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
  let lockless = false;
  let halted = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let running: Promise<void> | undefined;

  const step = async (): Promise<void> => {
    if (lockless) return;
    if (token === undefined) {
      let acquired: string | undefined;
      try {
        await fs.mkdir(path.dirname(options.lockPath), { recursive: true, mode: 0o700 });
        acquired = await acquireClaim(options.lockPath, staleMs, now());
      } catch (err) {
        const code = errnoCode(err);
        if (code === undefined || !LOCK_UNAVAILABLE.has(code) || halted) throw err;
        lockless = true;
        options.report(
          `Mailbox writer lease: cannot use ${options.lockPath} (${code}); this process runs the writers without a lock.`,
        );
        await options.onLead();
        return;
      }
      if (acquired === undefined) return;
      if (halted) {
        await releaseClaim(options.lockPath, acquired);
        return;
      }
      token = acquired;
      await options.onLead();
      return;
    }
    if (await stillHeld(options.lockPath, token)) {
      const at = new Date(now());
      await fs.utimes(options.lockPath, at, at);
      return;
    }
    token = undefined;
    await options.onLose();
  };

  const tick = async (): Promise<void> => {
    running ??= step()
      .catch((err: unknown) => {
        options.report(`Mailbox writer lease: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        running = undefined;
      });
    return running;
  };

  return {
    get leading() {
      return token !== undefined || lockless;
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
    },
    release: async () => {
      if (token === undefined) return;
      const held = token;
      token = undefined;
      await releaseClaim(options.lockPath, held);
    },
  };
}
