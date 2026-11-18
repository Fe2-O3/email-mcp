/**
 * Process lifecycle of the stdio transport.
 *
 * The MCP stdio contract is that the client shuts the server down by closing our
 * stdin. Until this test existed the server never noticed: StdioServerTransport
 * subscribes only to 'data' and 'error', and several services hold ref'd handles
 * (scheduler tick, hooks rate-limit timer, IMAP IDLE sockets), so the event loop
 * never drained. Any client death that skips SIGTERM — closed terminal, SIGKILL,
 * crash, MCP reconnect — left an immortal process reparented to launchd/init.
 *
 * The server runs as a real child process on purpose: the defect is the event
 * loop failing to drain, which is unobservable from inside the same process.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('./main.ts', import.meta.url));

/**
 * Budget for the whole spawn → handshake → EOF → exit round trip. Everything in
 * it is local, so this is generous; its job is to fail a regression fast instead
 * of hanging CI until the framework timeout.
 */
const LIFECYCLE_BUDGET_MS = 20_000;

/** Emitted by the server once post-handshake background services have started. */
const READY_LOG = 'IMAP Wizard background services started';

let child: ChildProcessWithoutNullStreams | undefined;
let sandbox: string | undefined;

/** A test about leaked processes must not leak one itself. */
afterEach(async () => {
  if (child?.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
  }
  child = undefined;

  if (sandbox) {
    await fs.rm(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  }
});

/** Resolves once the server has completed the handshake and started its services. */
async function handshakeAndWaitForReady(proc: ChildProcessWithoutNullStreams): Promise<void> {
  const initialize = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'lifecycle-test', version: '1.0.0' },
    },
  };

  return new Promise<void>((resolve, reject) => {
    let stdout = '';
    let stderr = '';
    let initialized = false;

    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();

      // mcpLog writes structured lines to stderr; this one means post-handshake
      // init has started the background services that pin the event loop.
      if (stderr.includes(READY_LOG)) {
        resolve();
      }
    });

    proc.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();

      // Answering `initialize` means the server is live; the notification then
      // triggers the post-handshake block that pins the event loop.
      if (!initialized && stdout.includes('"id":1')) {
        initialized = true;
        proc.stdin.write(
          `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
        );
      }
    });

    proc.once('exit', (code, signal) => {
      reject(
        new Error(
          `server exited during handshake (code=${code}, signal=${signal})\nstderr:\n${stderr}`,
        ),
      );
    });

    proc.stdin.write(`${JSON.stringify(initialize)}\n`);
  });
}

/** Resolves with the exit code, or rejects if the process outlives the budget. */
async function waitForExit(proc: ChildProcessWithoutNullStreams, ms: number): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`process still running ${ms}ms after stdin closed — orphan regression`));
    }, ms);

    proc.once('exit', (code) => {
      clearTimeout(timer);
      resolve(code ?? -1);
    });
  });
}

/**
 * Environment for the sandboxed child: confines every read and write to the
 * sandbox (so the test cannot see a developer's real config or touch a real
 * scheduled-mail queue) and satisfies config validation. No tool is invoked
 * and the watcher is off, so no socket is ever opened to these hosts.
 */
function sandboxEnv(dir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    XDG_CONFIG_HOME: path.join(dir, 'config'),
    XDG_DATA_HOME: path.join(dir, 'data'),
    XDG_STATE_HOME: path.join(dir, 'state'),
    MCP_EMAIL_ADDRESS: 'test@example.invalid',
    MCP_EMAIL_PASSWORD: 'unused',
    MCP_EMAIL_IMAP_HOST: 'imap.example.invalid',
    MCP_EMAIL_SMTP_HOST: 'smtp.example.invalid',
    MCP_EMAIL_WATCHER_ENABLED: 'false',
  };
}

describe('stdio server lifecycle', () => {
  it(
    'exits when the client closes stdin',
    async () => {
      sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-lifecycle-'));

      child = spawn(process.execPath, ['--import', 'tsx', ENTRY, 'stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: sandboxEnv(sandbox),
      });

      await handshakeAndWaitForReady(child);

      child.stdin.end();

      await expect(waitForExit(child, LIFECYCLE_BUDGET_MS)).resolves.toBe(0);
    },
    LIFECYCLE_BUDGET_MS * 2,
  );

  it(
    'exits cleanly and promptly in read-only mode when the client closes stdin',
    async () => {
      sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-lifecycle-'));

      child = spawn(process.execPath, ['--import', 'tsx', ENTRY, 'stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...sandboxEnv(sandbox), MCP_EMAIL_READ_ONLY: 'true' },
      });
      const proc = child;

      // Read-only starts no background writers, so there is no ready log to
      // wait for: the answer to `initialize` is the signal.
      await new Promise<void>((resolve, reject) => {
        let stdout = '';
        proc.stdout.on('data', (chunk: Buffer) => {
          stdout += chunk.toString();
          if (stdout.includes('"id":1')) {
            proc.stdin.write(
              `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
            );
            resolve();
          }
        });
        proc.once('exit', (code) => reject(new Error(`exited during handshake (${code})`)));
        proc.stdin.write(
          `${JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'initialize',
            params: {
              protocolVersion: '2024-11-05',
              capabilities: {},
              clientInfo: { name: 'lifecycle-test', version: '1.0.0' },
            },
          })}\n`,
        );
      });
      // Let the post-handshake block run before the client goes away.
      await new Promise((resolve) => setTimeout(resolve, 300));

      const closedAt = Date.now();
      proc.stdin.end();
      // A timer left running used to hold the process until the 5-second
      // forced exit, which then exited 1.
      await expect(waitForExit(proc, LIFECYCLE_BUDGET_MS)).resolves.toBe(0);
      expect(Date.now() - closedAt).toBeLessThan(1_000);
    },
    LIFECYCLE_BUDGET_MS * 2,
  );

  it(
    'exits on its own after idle_exit seconds with no client requests',
    async () => {
      sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-lifecycle-'));

      child = spawn(process.execPath, ['--import', 'tsx', ENTRY, 'stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...sandboxEnv(sandbox),
          // The idle valve is off by default (idle_exit = 0); turn it on with
          // a window a test can observe.
          MCP_EMAIL_IDLE_EXIT: '2',
        },
      });

      await handshakeAndWaitForReady(child);

      // stdin stays open on purpose: the idle timer is the only thing that can
      // end this connection, so an exit proves the valve fires (and that it
      // takes the graceful path — exit code 0, same as client-driven EOF).
      await expect(waitForExit(child, LIFECYCLE_BUDGET_MS)).resolves.toBe(0);
    },
    LIFECYCLE_BUDGET_MS * 2,
  );
});

describe('shutdown during body backfill', () => {
  it('fetches nothing after stop() and closes the store cleanly', async () => {
    const [{ startBackgroundServices }, { default: SyncEngine }, { default: BodyCache }, store] =
      await Promise.all([
        import('./app.js'),
        import('./cache/sync-engine.js'),
        import('./cache/body-cache.js'),
        import('./cache/store.js').then((m) => new m.default(':memory:')),
      ]);

    const uids = [1, 2, 3, 4, 5, 6];
    let fetchesAfterStop = 0;
    let stopped = false;
    let firstFetch: (() => void) | undefined;
    const firstFetchStarted = new Promise<void>((resolve) => {
      firstFetch = resolve;
    });

    const client = {
      capabilities: new Map<string, boolean | number>(),
      mailbox: { uidValidity: 100n, uidNext: 7, exists: uids.length },
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      search: vi.fn().mockResolvedValue(uids),
      fetch: vi.fn().mockImplementation(() =>
        (async function* gen() {
          for (const uid of uids) {
            yield {
              uid,
              envelope: { subject: `s${uid}` },
              flags: new Set<string>(),
              bodyStructure: { type: 'text/plain', size: 4 },
              internalDate: new Date(uid * 86_400_000),
            };
          }
        })(),
      ),
      fetchOne: vi.fn(async (seq: string) => {
        if (stopped) fetchesAfterStop += 1;
        firstFetch?.();
        // Yield so stop() can land between messages.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return {
          uid: Number(seq),
          envelope: {},
          bodyStructure: { type: 'text/plain', size: 4 },
          headers: Buffer.from(''),
        };
      }),
      download: vi.fn(async () => ({
        content: (async function* gen() {
          yield Buffer.from('body');
        })(),
      })),
    };
    const connections = {
      getAccountNames: vi.fn().mockReturnValue(['work']),
      getImapClient: vi.fn().mockResolvedValue(client),
    };

    const syncEngine = new SyncEngine(
      connections as never,
      store,
      {},
      { cache: new BodyCache(store, 200), bodyMessages: 500, bodyMaxMb: 200, batch: 6 },
    );
    const services = {
      config: {
        settings: {
          readOnly: false,
          cache: { mailboxes: ['INBOX'], syncInterval: 3600 },
        },
      },
      connections,
      hooksService: { start: vi.fn(), stop: vi.fn() },
      watcherService: { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn() },
      schedulerService: { checkAndSend: vi.fn().mockResolvedValue({ sent: 0 }) },
      imapService: { dispose: vi.fn() },
      syncEngine,
      cacheStore: store,
    };

    const leaseDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bg-lease-'));
    const handle = startBackgroundServices(services as never, null, {
      leasePath: path.join(leaseDir, 'mailbox-writers.lock'),
    });
    await firstFetchStarted;
    await handle.stop();
    stopped = true;
    const fetchesAtStop = client.fetchOne.mock.calls.length;

    // Give any straggling loop iteration time to misbehave.
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(fetchesAfterStop).toBe(0);
    // At most the message already in flight when stop() ran.
    expect(client.fetchOne.mock.calls.length).toBe(fetchesAtStop);
    expect(client.fetchOne.mock.calls.length).toBeLessThan(uids.length);
    // stop() closed the store; a late write would have thrown inside the cache
    // adapter, which swallows it, so closed is the observable end state.
    expect(() => store.getBody('work', 'INBOX', 1, '100')).toThrow();
    await fs.rm(leaseDir, { recursive: true, force: true });
  });
});
