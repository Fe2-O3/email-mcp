// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.

import { spawnSync } from 'node:child_process';
import type { PathLike } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { acquireClaim, holderIsGone, releaseClaim } from './file-claim.js';

describe('acquireClaim', () => {
  let root: string;
  let lockPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-wizard-claim-'));
    lockPath = path.join(root, 'entry.lock');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  // Without the second create, a free lock waits one more check cycle for nothing.
  it('should take a lock its holder released between the failed create and the age check', async () => {
    await fs.writeFile(lockPath, 'holder', { flag: 'wx' });
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementationOnce(async (file, options) => {
      await fs.unlink(lockPath);
      return stat(file, options as { bigint?: false });
    });
    const token = await acquireClaim(lockPath, 60_000);
    expect(await fs.readFile(lockPath, 'utf8').catch(() => 'gone')).toBe(token ?? 'no token');
  });

  async function writeStaleLock(): Promise<void> {
    await fs.writeFile(lockPath, 'dead holder', { flag: 'wx' });
    const abandonedAt = new Date(Date.now() - 120_000);
    await fs.utimes(lockPath, abandonedAt, abandonedAt);
  }

  /**
   * Holds the first rename of the lock until a second caller also found it
   * stale, then runs both renames in that order before either caller resumes.
   */
  function parkBothBeforeEitherResumes(): void {
    const rename = fs.rename.bind(fs);
    type Done = (outcome: Error | undefined) => void;
    let first: { from: PathLike; to: PathLike; done: Done } | undefined;
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      if (first === undefined) {
        const outcome = await new Promise<Error | undefined>((resolve) => {
          first = { from, to, done: resolve };
        });
        if (outcome !== undefined) throw outcome;
        return;
      }
      const failure = (err: Error) => err;
      const firstOutcome = await rename(first.from, first.to).then(() => undefined, failure);
      const ownOutcome = await rename(from, to).then(() => undefined, failure);
      first.done(firstOutcome);
      if (ownOutcome !== undefined) throw ownOutcome;
    });
  }

  // Two scheduler checks that both see a dead holder's lock must not both send the email.
  it('should give a stale lock to exactly one of two concurrent callers', async () => {
    await writeStaleLock();
    parkBothBeforeEitherResumes();
    const tokens = await Promise.all([
      acquireClaim(lockPath, 60_000),
      acquireClaim(lockPath, 60_000),
    ]);
    const winners = tokens.filter((token) => token !== undefined);
    expect({ winners: winners.length, lock: await fs.readFile(lockPath, 'utf8') }).toEqual({
      winners: 1,
      lock: winners[0],
    });
  });

  it('should not take a lock another process created right after the stale one was parked', async () => {
    await writeStaleLock();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      await rename(from, to);
      await fs.writeFile(lockPath, 'other process', { flag: 'wx' });
    });
    const token = await acquireClaim(lockPath, 60_000);
    expect({ token, lock: await fs.readFile(lockPath, 'utf8') }).toEqual({
      token: undefined,
      lock: 'other process',
    });
  });

  // Each steal parks the old lock under a new name, so a parked copy left behind would pile up.
  it('should leave no parked copy behind after taking a stale lock', async () => {
    await writeStaleLock();
    await acquireClaim(lockPath, 60_000);
    expect(await fs.readdir(root)).toEqual(['entry.lock']);
  });

  // The holder renewed just before the park, so the lock goes back. Its parked copy must not stay.
  it('should leave no parked copy behind when the parked claim was renewed', async () => {
    await writeStaleLock();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      const renewedAt = new Date();
      await fs.utimes(from, renewedAt, renewedAt);
      await rename(from, to);
    });
    const token = await acquireClaim(lockPath, 60_000);
    expect({ token, names: await fs.readdir(root) }).toEqual({
      token: undefined,
      names: ['entry.lock'],
    });
  });

  // A token for a lock someone else holds would let two checks send the same email.
  it('should not take a lock a rival created after the holder released it', async () => {
    await fs.writeFile(lockPath, 'holder', { flag: 'wx' });
    const stat = fs.stat.bind(fs);
    vi.spyOn(fs, 'stat').mockImplementationOnce(async (file, options) => {
      await fs.unlink(lockPath);
      try {
        return await stat(file, options as { bigint?: false });
      } finally {
        await fs.writeFile(lockPath, 'rival', { flag: 'wx' });
      }
    });
    const token = await acquireClaim(lockPath, 60_000);
    expect({ token, lock: await fs.readFile(lockPath, 'utf8') }).toEqual({
      token: undefined,
      lock: 'rival',
    });
  });

  // Reported as busy, an unwritable queue would skip its emails without an error.
  it('should reject when the lock cannot be created for a reason other than EEXIST', async () => {
    await expect(
      acquireClaim(path.join(root, 'missing-dir', 'entry.lock'), 60_000),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  });

  // While a live lock is parked its path is empty, so a third process could take it from its holder.
  it('should not park a claim that is still fresh', async () => {
    await fs.writeFile(lockPath, 'holder', { flag: 'wx' });
    const rename = fs.rename.bind(fs);
    const renames: string[] = [];
    vi.spyOn(fs, 'rename').mockImplementation(async (from, to) => {
      renames.push(String(from));
      await rename(from, to);
    });
    const token = await acquireClaim(lockPath, 60_000);
    expect({ token, renames, lock: await fs.readFile(lockPath, 'utf8') }).toEqual({
      token: undefined,
      renames: [],
      lock: 'holder',
    });
  });

  it('should reject when a stale lock cannot be parked for a reason other than ENOENT', async () => {
    await writeStaleLock();
    vi.spyOn(fs, 'rename').mockRejectedValueOnce(
      Object.assign(new Error('EACCES: permission denied, rename'), { code: 'EACCES' }),
    );
    await expect(acquireClaim(lockPath, 60_000)).rejects.toMatchObject({ code: 'EACCES' });
  });

  it('should reject when a renewed lock cannot be put back for a reason other than EEXIST', async () => {
    await writeStaleLock();
    const rename = fs.rename.bind(fs);
    vi.spyOn(fs, 'rename').mockImplementationOnce(async (from, to) => {
      const renewedAt = new Date();
      await fs.utimes(from, renewedAt, renewedAt);
      await rename(from, to);
    });
    vi.spyOn(fs, 'link').mockRejectedValueOnce(
      Object.assign(new Error('EPERM: operation not permitted, link'), { code: 'EPERM' }),
    );
    await expect(acquireClaim(lockPath, 60_000)).rejects.toMatchObject({ code: 'EPERM' });
  });
});

describe('releaseClaim', () => {
  let root: string;
  let lockPath: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'mailoo-release-'));
    lockPath = path.join(root, 'entry.lock');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  // Release runs after the send. Throwing there would fail a check whose email went out.
  it('should resolve when the lock is already gone', async () => {
    await expect(releaseClaim(lockPath, 'token')).resolves.toBeUndefined();
  });

  it('should resolve when the lock disappears after its token was read', async () => {
    await fs.writeFile(lockPath, 'token', { flag: 'wx' });
    const readFile = fs.readFile.bind(fs);
    vi.spyOn(fs, 'readFile').mockImplementationOnce(async (file, options) => {
      const content = await readFile(file, options as { encoding: 'utf8' });
      await fs.unlink(lockPath);
      return content;
    });
    await expect(releaseClaim(lockPath, 'token')).resolves.toBeUndefined();
  });
});

describe('holderIsGone', () => {
  const host = os.hostname();

  it('is false for this very process', () => {
    expect(holderIsGone(`${host}:${process.pid}:abc`)).toBe(false);
  });

  it('is true for a process on this host that has exited', () => {
    const { pid } = spawnSync(process.execPath, ['-e', '0']);
    expect(holderIsGone(`${host}:${pid}:abc`)).toBe(true);
  });

  it('is false for another host, and for text that is not a token', () => {
    const { pid } = spawnSync(process.execPath, ['-e', '0']);
    expect(holderIsGone(`elsewhere:${pid}:abc`)).toBe(false);
    expect(holderIsGone('holder')).toBe(false);
    expect(holderIsGone('')).toBe(false);
    expect(holderIsGone(`${host}:notapid:abc`)).toBe(false);
  });
});
