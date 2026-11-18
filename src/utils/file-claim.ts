// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * Cross-process claims on a lock file.
 *
 * Exclusive create (`wx`) is the only claim. The file holds the holder's token, which names its
 * host and process id. A live holder refreshes the file's mtime as a heartbeat. A claim may be
 * taken when
 *   - its mtime is older than the stale window (the holder stopped, or hung), or
 *   - it was made on this host by a process that no longer exists (the holder was killed), which
 *     does not have to wait out the window.
 * Release deletes the lock only while it still holds this holder's token.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';

export function errnoCode(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null || !('code' in err)) return undefined;
  const { code } = err as { code?: unknown };
  return typeof code === 'string' ? code : undefined;
}

/** `host:pid:random`. The host part may itself contain colons, so the id is read from the right. */
function newToken(): string {
  return `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
}

function parseToken(token: string): { host: string; pid: number } | undefined {
  const parts = token.trim().split(':');
  if (parts.length < 3) return undefined;
  const pid = Number(parts.at(-2));
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  return { host: parts.slice(0, -2).join(':'), pid };
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists but belongs to someone else.
    return errnoCode(err) !== 'ESRCH';
  }
}

/** True only when the claim was made on this host by a process that is no longer running. */
export function holderIsGone(token: string): boolean {
  const owner = parseToken(token);
  if (!owner || owner.host !== os.hostname()) return false;
  return !processExists(owner.pid);
}

async function createClaim(lockPath: string, token: string): Promise<boolean> {
  try {
    await fs.writeFile(lockPath, token, { flag: 'wx' });
    return true;
  } catch (err) {
    if (errnoCode(err) === 'EEXIST') return false;
    throw err;
  }
}

async function claimAge(lockPath: string, now: number): Promise<number | undefined> {
  try {
    const stat = await fs.stat(lockPath);
    return now - stat.mtimeMs;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

async function readClaim(lockPath: string): Promise<string | undefined> {
  try {
    return await fs.readFile(lockPath, 'utf8');
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return undefined;
    throw err;
  }
}

/** One rule for both looks, so the first check and the re-check after parking agree. */
async function claimIsStale(lockPath: string, staleMs: number, now: number): Promise<boolean> {
  const age = await claimAge(lockPath, now);
  if (age === undefined) return true;
  if (age > staleMs) return true;
  const content = await readClaim(lockPath);
  return content !== undefined && holderIsGone(content);
}

async function stealStaleClaim(
  lockPath: string,
  staleMs: number,
  now: number,
  token: string,
): Promise<boolean> {
  const parked = `${lockPath}.${crypto.randomUUID()}`;
  try {
    await fs.rename(lockPath, parked);
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return false;
    throw err;
  }
  try {
    if (!(await claimIsStale(parked, staleMs, now))) {
      try {
        // rename would replace a claim created after the park.
        await fs.link(parked, lockPath);
      } catch (err) {
        if (errnoCode(err) !== 'EEXIST') throw err;
      }
      return false;
    }
    return await createClaim(lockPath, token);
  } finally {
    await fs.unlink(parked).catch(() => undefined);
  }
}

/** The holder's token, or undefined while a live holder has the lock. */
export async function acquireClaim(
  lockPath: string,
  staleMs: number,
  now = Date.now(),
): Promise<string | undefined> {
  const token = newToken();
  if (await createClaim(lockPath, token)) return token;
  if ((await claimAge(lockPath, now)) === undefined) {
    return (await createClaim(lockPath, token)) ? token : undefined;
  }
  if (!(await claimIsStale(lockPath, staleMs, now))) return undefined;
  return (await stealStaleClaim(lockPath, staleMs, now, token)) ? token : undefined;
}

export async function releaseClaim(lockPath: string, token: string): Promise<void> {
  try {
    const current = await fs.readFile(lockPath, 'utf8');
    if (current !== token) return;
  } catch (err) {
    if (errnoCode(err) === 'ENOENT') return;
    throw err;
  }
  try {
    await fs.unlink(lockPath);
  } catch (err) {
    if (errnoCode(err) !== 'ENOENT') throw err;
  }
}
