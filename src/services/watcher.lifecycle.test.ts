/**
 * The watcher must stay alive and honest:
 *
 * - a folder it cannot open never leaves a logged-in client behind with no
 *   error listener (that client crashed the stdio server when it timed out);
 * - a STARTTLS account is never watched over a connection that may skip TLS;
 * - a reconnect keeps its place, catches up on recent mail and skips old mail;
 * - one message with an unreadable Date header never stalls it.
 */

import type { AccountConfig, WatcherConfig } from '../types/index.js';
import eventBus from './event-bus.js';
import WatcherService, { CATCH_UP_WINDOW_MS } from './watcher.service.js';

interface FakeClient {
  opts: Record<string, unknown>;
  handlers: Record<string, (data?: unknown) => void>;
  listenersAtConnect: string[];
  usable: boolean;
  mailbox: { uidNext: number; uidValidity: bigint };
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  getMailboxLock: ReturnType<typeof vi.fn>;
  fetch: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
}

const { instances, plan } = vi.hoisted(() => ({
  instances: [] as FakeClient[],
  /** How the next constructed client behaves. */
  plan: {
    lockFails: false,
    uidNext: 100,
    uidValidity: 1n,
    messages: [] as Record<string, unknown>[],
  },
}));

vi.mock('imapflow', () => {
  class MockImapFlow {
    opts: Record<string, unknown>;
    handlers: Record<string, (data?: unknown) => void> = {};
    listenersAtConnect: string[] = [];
    usable = true;
    mailbox = { uidNext: plan.uidNext, uidValidity: plan.uidValidity };
    connect = vi.fn(async () => {
      this.listenersAtConnect = Object.keys(this.handlers);
    });
    close = vi.fn(() => {
      this.usable = false;
    });
    logout = vi.fn(async () => {
      this.usable = false;
      this.handlers.close?.();
    });
    getMailboxLock = vi.fn(async () => {
      if (plan.lockFails) throw new Error('NO [NONEXISTENT] Unknown Mailbox');
      return { release: vi.fn() };
    });
    fetch = vi.fn(() => {
      const messages = plan.messages;
      return (async function* gen() {
        for (const m of messages) yield m;
      })();
    });
    on = vi.fn((event: string, cb: (data?: unknown) => void) => {
      this.handlers[event] = cb;
    });

    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      instances.push(this as unknown as FakeClient);
    }
  }
  return { ImapFlow: MockImapFlow };
});

const { logs } = vi.hoisted(() => ({ logs: [] as string[] }));
vi.mock('../logging.js', () => ({
  mcpLog: vi.fn(async (_level: string, _source: string, message: string) => {
    logs.push(message);
  }),
}));
vi.mock('./event-bus.js', () => ({ default: { emit: vi.fn() } }));

const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };

function account(imap: Partial<AccountConfig['imap']> = {}): AccountConfig {
  return {
    name: 'test',
    email: 'test@example.com',
    username: 'test@example.com',
    password: 'password',
    imap: {
      host: 'imap.example.com',
      port: 993,
      tls: true,
      starttls: false,
      verifySsl: true,
      ...imap,
    },
    smtp: { host: 'smtp.example.com', port: 465, tls: true, starttls: false, verifySsl: true },
  };
}

function message(uid: number, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uid,
    flags: new Set<string>(),
    envelope: {
      subject: `m${uid}`,
      from: [{ address: 'a@example.com' }],
      to: [],
      date: new Date(),
    },
    internalDate: new Date(),
    ...extra,
  };
}

beforeEach(() => {
  instances.length = 0;
  logs.length = 0;
  plan.lockFails = false;
  plan.uidNext = 100;
  plan.uidValidity = 1n;
  plan.messages = [];
  vi.mocked(eventBus.emit).mockClear();
});

describe('a folder the watcher cannot open', () => {
  it('closes the client and had its error listener on before connect', async () => {
    vi.useFakeTimers();
    try {
      plan.lockFails = true;
      const watcher = new WatcherService(config, [account()]);
      await watcher.start();

      const first = instances[0];
      expect(first.listenersAtConnect).toContain('error');
      expect(first.close).toHaveBeenCalled();
      expect(watcher.getStatus()[0].connected).toBe(false);
      // A late error from the closed client has a listener and does not throw.
      expect(() => first.handlers.error?.(new Error('Socket timeout'))).not.toThrow();

      // Each retry closes its own client too, so none piles up.
      await vi.advanceTimersByTimeAsync(1_000);
      expect(instances).toHaveLength(2);
      expect(instances[1].close).toHaveBeenCalled();

      await watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('a client that connects after stop() is closed, not kept', async () => {
    const watcher = new WatcherService(config, [account()]);
    const started = watcher.start();
    await watcher.stop();
    await started;
    for (const client of instances) {
      expect(client.close.mock.calls.length + client.logout.mock.calls.length).toBeGreaterThan(0);
    }
  });
});

describe('STARTTLS', () => {
  it('the watcher demands STARTTLS for a starttls account', async () => {
    const watcher = new WatcherService(config, [
      account({ tls: false, starttls: true, port: 143 }),
    ]);
    await watcher.start();
    expect(instances[0].opts).toMatchObject({ secure: false, doSTARTTLS: true });
    expect(instances[0].opts.maxIdleTime).toBe(1740 * 1000);
    await watcher.stop();
  });

  it('an implicit-TLS account gets no doSTARTTLS', async () => {
    const watcher = new WatcherService(config, [account()]);
    await watcher.start();
    expect(instances[0].opts).toMatchObject({ secure: true });
    expect(instances[0].opts.doSTARTTLS).toBeUndefined();
    await watcher.stop();
  });
});

describe('reconnect', () => {
  async function startAndDrop(): Promise<WatcherService> {
    const watcher = new WatcherService(config, [account()]);
    await watcher.start();
    expect(watcher.getStatus()[0].lastSeenUid).toBe(99);
    return watcher;
  }

  it('keeps its place and catches up on mail that arrived in a short gap', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const watcher = await startAndDrop();
      plan.uidNext = 103;
      plan.messages = [message(100), message(101), message(102)];
      instances[0].handlers.close?.();
      await vi.advanceTimersByTimeAsync(1_000);

      expect(instances).toHaveLength(2);
      expect(instances[1].fetch).toHaveBeenCalledWith('100:*', expect.anything(), { uid: true });
      expect(eventBus.emit).toHaveBeenCalledWith(
        'email:new',
        expect.objectContaining({
          emails: [
            expect.objectContaining({ id: '100' }),
            expect.objectContaining({ id: '101' }),
            expect.objectContaining({ id: '102' }),
          ],
        }),
      );
      expect(watcher.getStatus()[0].lastSeenUid).toBe(102);
      await watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('skips mail older than the catch-up window, with a log line', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const watcher = await startAndDrop();
      plan.uidNext = 102;
      const old = new Date(Date.now() - CATCH_UP_WINDOW_MS - 60_000);
      plan.messages = [message(100, { internalDate: old }), message(101)];
      instances[0].handlers.close?.();
      await vi.advanceTimersByTimeAsync(1_000);

      const emitted = vi.mocked(eventBus.emit).mock.calls.find((c) => c[0] === 'email:new');
      if (!emitted) throw new Error('no email:new event');
      const { emails } = emitted[1] as { emails: { id: string }[] };
      expect(emails.map((e) => e.id)).toEqual(['101']);
      expect(logs.join('\n')).toMatch(/Skipped 1 message/);
      expect(watcher.getStatus()[0].lastSeenUid).toBe(101);
      await watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts from the top again when the folder was renumbered', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const watcher = await startAndDrop();
      plan.uidNext = 7;
      plan.uidValidity = 2n;
      instances[0].handlers.close?.();
      await vi.advanceTimersByTimeAsync(1_000);
      expect(watcher.getStatus()[0].lastSeenUid).toBe(6);
      expect(instances[1].fetch).not.toHaveBeenCalled();
      await watcher.stop();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('a message with a Date header that is not a date', () => {
  it('is reported with a readable date and the watcher moves past it', async () => {
    const watcher = new WatcherService(config, [account()]);
    await watcher.start();
    plan.messages = [
      message(100, {
        envelope: { subject: 'spam', from: [{ address: 's@example.com' }], date: 'sometime soon' },
        internalDate: undefined,
      }),
      message(101),
    ];
    instances[0].handlers.exists?.({ path: 'INBOX', count: 2, prevCount: 0 });
    await vi.waitFor(() => expect(eventBus.emit).toHaveBeenCalled());

    expect(eventBus.emit).toHaveBeenCalledWith(
      'email:new',
      expect.objectContaining({
        emails: [
          expect.objectContaining({ id: '100', date: 'date unknown' }),
          expect.objectContaining({ id: '101' }),
        ],
      }),
    );
    expect(watcher.getStatus()[0].lastSeenUid).toBe(101);
    await watcher.stop();
  });
});
