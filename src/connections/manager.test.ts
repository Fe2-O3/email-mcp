/**
 * ImapFlow is an EventEmitter, and in Node an `error` event with no listener
 * is an uncaughtException that kills the process. Hosted IMAP providers drop
 * idle sessions after roughly 29 minutes, so a long-running MCP server hits
 * this reliably.
 *
 * These tests assert the property that matters — every client this module
 * constructs has a listener before it can emit — rather than asserting on the
 * shape of the handler. The mock below throws on an unhandled `error`, exactly
 * as Node would, so a regression fails loudly here instead of in production.
 *
 * Upstream: codefuturist/email-mcp#29, #44, #57, #64
 */

import eventBus from '../services/event-bus.js';
import type { AccountConfig } from '../types/index.js';
import ConnectionManager from './manager.js';

type MockListener = (...args: unknown[]) => void;

interface MockClient {
  usable: boolean;
  freeToClose: ReturnType<typeof vi.fn>;
  connect: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  logout: ReturnType<typeof vi.fn>;
  list: ReturnType<typeof vi.fn>;
  status: ReturnType<typeof vi.fn>;
  emit: (event: string, ...args: unknown[]) => boolean;
  listenerCount: (event: string) => number;
}

const imapInstances = vi.hoisted(() => [] as MockClient[]);

vi.mock('imapflow', () => {
  class MockImapFlow {
    usable = true;

    connect = vi.fn().mockResolvedValue(undefined);

    close = vi.fn();

    logout = vi.fn().mockResolvedValue(undefined);

    list = vi.fn().mockResolvedValue([{ path: 'INBOX' }]);

    status = vi.fn().mockResolvedValue({ messages: 1, unseen: 0 });

    /** imapflow's own "nothing running, queued or locked" check. */
    freeToClose = vi.fn(() => true);

    private listeners = new Map<string, MockListener[]>();

    constructor(_options: unknown) {
      imapInstances.push(this as unknown as MockClient);
    }

    on(event: string, listener: MockListener): this {
      const existing = this.listeners.get(event) ?? [];
      existing.push(listener);
      this.listeners.set(event, existing);
      return this;
    }

    listenerCount(event: string): number {
      return (this.listeners.get(event) ?? []).length;
    }

    /** Mirrors Node: an unhandled 'error' event throws. */
    emit(event: string, ...args: unknown[]): boolean {
      const listeners = this.listeners.get(event) ?? [];
      if (event === 'error' && listeners.length === 0) {
        throw args[0] instanceof Error ? args[0] : new Error(String(args[0]));
      }
      listeners.forEach((listener) => {
        listener(...args);
      });
      return listeners.length > 0;
    }
  }

  return { ImapFlow: MockImapFlow };
});

vi.mock('../logging.js', () => ({ mcpLog: vi.fn().mockResolvedValue(undefined) }));

const account: AccountConfig = {
  name: 'test',
  email: 'user@example.invalid',
  username: 'user@example.invalid',
  password: 'not-a-real-password',
  imap: { host: 'imap.example.invalid', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.invalid', port: 465, tls: true, starttls: false, verifySsl: true },
} as AccountConfig;

describe('ConnectionManager IMAP lifecycle', () => {
  beforeEach(() => {
    imapInstances.length = 0;
    vi.clearAllMocks();
    vi.spyOn(eventBus, 'emit');
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('reuses a usable IMAP client without announcing a reconnect', async () => {
    const manager = new ConnectionManager([account]);

    const first = await manager.getImapClient('test');
    const second = await manager.getImapClient('test');

    expect(second).toBe(first);
    expect(imapInstances).toHaveLength(1);
    expect(eventBus.emit).not.toHaveBeenCalledWith('imap:reconnect', expect.anything());
  });

  it('announces a reconnect when it replaces a dead connection', async () => {
    const manager = new ConnectionManager([account]);

    const first = await manager.getImapClient('test');
    // Simulate the socket dying between tool calls.
    (first as unknown as { usable: boolean }).usable = false;

    const second = await manager.getImapClient('test');

    expect(second).not.toBe(first);
    // Anything derived from the old connection — capability probes, cached
    // UIDVALIDITY, label-strategy memos — is now suspect and must be told.
    expect(eventBus.emit).toHaveBeenCalledWith('imap:reconnect', { account: 'test' });
  });

  it('survives an error event on a pooled client instead of crashing', async () => {
    const manager = new ConnectionManager([account]);
    await manager.getImapClient('test');
    const client = imapInstances[0];

    // Would throw if no listener were registered — that throw IS the bug.
    expect(() => client.emit('error', new Error('socket hang up'))).not.toThrow();
  });

  it('evicts the dead client so the next call reconnects', async () => {
    const manager = new ConnectionManager([account]);
    const first = await manager.getImapClient('test');
    imapInstances[0].emit('error', new Error('idle timeout'));

    const second = await manager.getImapClient('test');
    expect(imapInstances).toHaveLength(2);
    expect(second).not.toBe(first);
  });

  it('evicts on close as well as on error', async () => {
    const manager = new ConnectionManager([account]);
    const first = await manager.getImapClient('test');
    imapInstances[0].emit('close');

    const second = await manager.getImapClient('test');
    expect(second).not.toBe(first);
  });

  it('a late event from a replaced client does not evict its replacement', async () => {
    const manager = new ConnectionManager([account]);
    await manager.getImapClient('test');
    const stale = imapInstances[0];

    // Force a reconnect, so a second client becomes the pooled one.
    stale.usable = false;
    const replacement = await manager.getImapClient('test');
    expect(imapInstances).toHaveLength(2);

    // The old socket now finally reports its death. It must not evict the new one.
    stale.emit('close');
    stale.emit('error', new Error('late error from a dead socket'));

    const afterLateEvents = await manager.getImapClient('test');
    expect(afterLateEvents).toBe(replacement);
    expect(imapInstances).toHaveLength(2);
  });

  it('guards the short-lived testImap probe client too', async () => {
    await ConnectionManager.testImap(account);
    const probe = imapInstances[0];

    expect(probe.listenerCount('error')).toBeGreaterThan(0);
    expect(() => probe.emit('error', new Error('mid-probe failure'))).not.toThrow();
  });

  describe('rotation of an old connection', () => {
    const HALF_HOUR_MS = 30 * 60 * 1000;

    afterEach(() => {
      vi.useRealTimers();
    });

    // A download or bulk move still running on the old client would be cut off.
    it('keeps handing out an old connection while a call is still using it', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const manager = new ConnectionManager([account]);
      const first = await manager.getImapClient('test');
      vi.setSystemTime(Date.now() + HALF_HOUR_MS + 1000);
      imapInstances[0].freeToClose.mockReturnValue(false);

      const second = await manager.getImapClient('test');

      expect(second).toBe(first);
      expect(imapInstances[0].close).not.toHaveBeenCalled();
    });

    // The busy check is imapflow's own: an upgrade that dropped it would quietly stop rotation.
    it('relies on a busy check the installed imapflow has', async () => {
      const actual = await vi.importActual<typeof import('imapflow')>('imapflow');
      const proto = actual.ImapFlow.prototype as unknown as { freeToClose?: unknown };
      expect(typeof proto.freeToClose).toBe('function');
    });

    it('replaces an old connection once nothing is using it', async () => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const manager = new ConnectionManager([account]);
      const first = await manager.getImapClient('test');
      vi.setSystemTime(Date.now() + HALF_HOUR_MS + 1000);

      const second = await manager.getImapClient('test');

      expect(second).not.toBe(first);
      expect(imapInstances[0].close).toHaveBeenCalled();
    });
  });
});
