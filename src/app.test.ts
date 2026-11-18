import type { AppServices } from './app.js';
import { startBackgroundServices } from './app.js';

function fakeServices(readOnly: boolean) {
  const hooksService = { start: vi.fn(), stop: vi.fn() };
  const watcherService = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() };
  const schedulerService = { checkAndSend: vi.fn().mockResolvedValue({ sent: 0 }) };
  const imapService = { dispose: vi.fn() };
  const syncEngine = { start: vi.fn(), stop: vi.fn(), syncMailbox: vi.fn() };
  const services = {
    config: { settings: { readOnly, cache: { mailboxes: [], syncInterval: 30 } } },
    connections: { getAccountNames: () => [] },
    hooksService,
    watcherService,
    schedulerService,
    imapService,
    syncEngine,
  } as unknown as AppServices;
  return { services, hooksService, watcherService, schedulerService, imapService, syncEngine };
}

describe('startBackgroundServices', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('starts nothing in read_only mode', async () => {
    const f = fakeServices(true);

    const handle = startBackgroundServices(f.services, null);
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

  it('starts the watcher, hooks and scheduler when writable (control)', async () => {
    const f = fakeServices(false);

    const handle = startBackgroundServices(f.services, null);
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
});
