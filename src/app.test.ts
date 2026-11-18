import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import type { AppServices } from './app.js';
import { startBackgroundServices } from './app.js';

function fakeServices(readOnly: boolean) {
  const hooksService = { start: vi.fn(), stop: vi.fn() };
  const watcherService = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
  const schedulerService = { checkAndSend: vi.fn().mockResolvedValue({ sent: 0 }) };
  const imapService = { dispose: vi.fn() };
  const cacheStore = { close: vi.fn() };
  const syncEngine = { start: vi.fn(), stop: vi.fn(), syncMailbox: vi.fn() };
  const services = {
    config: { settings: { readOnly, cache: { mailboxes: [], syncInterval: 30 } } },
    connections: { getAccountNames: () => [] },
    hooksService,
    watcherService,
    schedulerService,
    imapService,
    syncEngine,
    cacheStore,
  } as unknown as AppServices;
  return {
    services,
    hooksService,
    watcherService,
    schedulerService,
    imapService,
    syncEngine,
    cacheStore,
  };
}

describe('startBackgroundServices', () => {
  let leaseDir: string;
  let leasePath: string;

  beforeEach(() => {
    // The lease lives in the app's state directory; never touch the real one in a test.
    leaseDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bg-lease-'));
    leasePath = path.join(leaseDir, 'mailbox-writers.lock');
    vi.useFakeTimers();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(leaseDir, { recursive: true, force: true });
  });

  it('starts nothing in read_only mode', async () => {
    const f = fakeServices(true);

    const handle = startBackgroundServices(f.services, null, { leasePath });
    // Let any (wrongly) started startup block and its timers run.
    await vi.advanceTimersByTimeAsync(120_000);

    expect(f.hooksService.start).not.toHaveBeenCalled();
    expect(f.syncEngine.start).not.toHaveBeenCalled();
    expect(f.watcherService.start).not.toHaveBeenCalled();
    // Sending overdue scheduled mail is a write, so the scheduler must stay idle.
    expect(f.schedulerService.checkAndSend).not.toHaveBeenCalled();

    await handle.stop();
    expect(f.hooksService.stop).not.toHaveBeenCalled();
    expect(f.watcherService.stop).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shuts down read_only mode like write mode: disposes IMAP and closes the cache', async () => {
    const ro = fakeServices(true);
    await startBackgroundServices(ro.services, null, { leasePath }).stop();
    expect(ro.imapService.dispose).toHaveBeenCalledTimes(1);
    expect(ro.cacheStore.close).toHaveBeenCalledTimes(1);

    const rw = fakeServices(false);
    await startBackgroundServices(rw.services, null, { leasePath }).stop();
    expect(rw.imapService.dispose).toHaveBeenCalledTimes(1);
    expect(rw.cacheStore.close).toHaveBeenCalledTimes(1);
  });

  it('starts the watcher, hooks and scheduler when writable (control)', async () => {
    const f = fakeServices(false);
    // Taking the lease is real file I/O, which fake timers do not drive: wait for its result.
    const watcherStarted = new Promise<void>((resolve) => {
      f.watcherService.start.mockImplementation(async () => {
        resolve();
      });
    });

    const handle = startBackgroundServices(f.services, null, { leasePath });
    await watcherStarted;
    await vi.advanceTimersByTimeAsync(61_000);

    expect(f.hooksService.start).toHaveBeenCalledTimes(1);
    expect(f.syncEngine.start).toHaveBeenCalledTimes(1);
    expect(f.watcherService.start).toHaveBeenCalledTimes(1);
    // Once on startup, once from the 60 second interval.
    expect(f.schedulerService.checkAndSend).toHaveBeenCalledTimes(2);

    await handle.stop();
    expect(f.hooksService.stop).toHaveBeenCalled();
    expect(f.watcherService.stop).toHaveBeenCalled();
  });

  it('lets only one of two processes run the watcher and hooks, and hands them over when it stops', async () => {
    const leader = fakeServices(false);
    const follower = fakeServices(false);
    const leaderStarted = new Promise<void>((resolve) => {
      leader.watcherService.start.mockImplementation(async () => {
        resolve();
      });
    });
    const firstHandle = startBackgroundServices(leader.services, null, { leasePath });
    await leaderStarted;

    const takeoverStarted = new Promise<void>((resolve) => {
      follower.watcherService.start.mockImplementation(async () => {
        resolve();
      });
    });
    // The follower's lease attempt is real file I/O; its first scheduler check marks the end of it.
    const followerChecked = new Promise<void>((resolve) => {
      follower.schedulerService.checkAndSend.mockImplementation(async () => {
        resolve();
        return { sent: 0 };
      });
    });
    const secondHandle = startBackgroundServices(follower.services, null, { leasePath });
    await followerChecked;
    await vi.advanceTimersByTimeAsync(61_000);

    // Both serve tools and keep the scheduler (it has its own lock); only the leader runs the writers.
    expect(leader.watcherService.start).toHaveBeenCalledTimes(1);
    expect(leader.hooksService.start).toHaveBeenCalledTimes(1);
    expect(follower.watcherService.start).not.toHaveBeenCalled();
    expect(follower.hooksService.start).not.toHaveBeenCalled();
    expect(follower.schedulerService.checkAndSend).toHaveBeenCalled();

    // The leader stops and frees the lease; the follower takes over on its next try.
    await firstHandle.stop();
    await vi.advanceTimersByTimeAsync(31_000);
    await takeoverStarted;
    expect(follower.hooksService.start).toHaveBeenCalledTimes(1);
    expect(follower.watcherService.start).toHaveBeenCalledTimes(1);

    await secondHandle.stop();
  });
});
