/**
 * HTTP mode must serve real MCP calls: more than one in a row, several at once
 * with the same JSON-RPC id, an oversized body refused, and a clean exit on
 * SIGTERM. These drive a real child process over real TCP, with every state
 * folder in a temp directory and a throwaway env-only account.
 */

import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ENTRY = fileURLToPath(new URL('../main.ts', import.meta.url));
const BUDGET_MS = 30_000;
const TOKEN = 'test-token-for-http-requests';

let child: ChildProcessWithoutNullStreams | undefined;
let sandbox: string | undefined;

afterEach(async () => {
  if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child = undefined;
  if (sandbox) {
    await fs.rm(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  }
});

function reservePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer();
    probe.on('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const addr = probe.address();
      if (typeof addr !== 'object' || addr === null) {
        probe.close(() => reject(new Error('could not reserve a port')));
        return;
      }
      probe.close(() => resolve(addr.port));
    });
  });
}

async function startServer(): Promise<number> {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-http-requests-'));
  const port = await reservePort();
  child = spawn(process.execPath, ['--import', 'tsx', ENTRY, 'http', '--port', String(port)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      HOME: sandbox,
      XDG_CONFIG_HOME: path.join(sandbox, 'config'),
      XDG_DATA_HOME: path.join(sandbox, 'data'),
      XDG_STATE_HOME: path.join(sandbox, 'state'),
      XDG_CACHE_HOME: path.join(sandbox, 'cache'),
      EMAIL_MCP_HTTP_TOKEN: TOKEN,
      MCP_EMAIL_ADDRESS: 'test@example.com',
      MCP_EMAIL_IMAP_HOST: 'imap.example.com',
      MCP_EMAIL_SMTP_HOST: 'smtp.example.com',
      MCP_EMAIL_PASSWORD: 'x',
      MCP_EMAIL_WATCHER_ENABLED: 'false',
    },
  });
  const proc = child as ChildProcessWithoutNullStreams;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), BUDGET_MS);
    proc.stderr.on('data', (chunk: Buffer) => {
      if (chunk.toString().includes('Streamable HTTP')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited during startup (${code})`));
    });
  });
  return port;
}

/** Pull the JSON-RPC message out of either a JSON or an SSE response body. */
function rpcMessage(text: string): { id?: unknown; result?: Record<string, unknown> } {
  const dataLine = text.split('\n').find((l) => l.startsWith('data:'));
  return JSON.parse(dataLine ? dataLine.slice(5).trim() : text) as {
    id?: unknown;
    result?: Record<string, unknown>;
  };
}

async function post(
  port: number,
  body: unknown,
): Promise<{ status: number; message: ReturnType<typeof rpcMessage> }> {
  const res = await fetch(`http://127.0.0.1:${port}/mcp`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${TOKEN}`,
    },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, message: res.status === 200 ? rpcMessage(text) : {} };
}

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'http-requests-test', version: '1' },
  },
};

describe('http server serves real calls', () => {
  it(
    'answers initialize, then tools/list twice, all with 200',
    async () => {
      const port = await startServer();
      const init = await post(port, INITIALIZE);
      expect(init.status).toBe(200);
      expect(init.message.result?.serverInfo).toBeDefined();

      const list1 = await post(port, { jsonrpc: '2.0', id: 2, method: 'tools/list' });
      expect(list1.status).toBe(200);
      expect(Array.isArray(list1.message.result?.tools)).toBe(true);
      expect(((list1.message.result?.tools ?? []) as unknown[]).length).toBeGreaterThan(5);

      const list2 = await post(port, { jsonrpc: '2.0', id: 3, method: 'tools/list' });
      expect(list2.status).toBe(200);
      expect(list2.message.id).toBe(3);
    },
    BUDGET_MS,
  );

  it(
    'two simultaneous calls with the same id each get their own answer',
    async () => {
      const port = await startServer();
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          i % 2 === 0
            ? post(port, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
            : post(port, { jsonrpc: '2.0', id: 1, method: 'ping' }),
        ),
      );
      results.forEach((r, i) => {
        expect(r.status).toBe(200);
        expect(r.message.id).toBe(1);
        // tools/list carries tools; ping carries an empty result. Mixed up
        // answers would show tools on a ping or none on a list.
        expect(Array.isArray(r.message.result?.tools)).toBe(i % 2 === 0);
      });
    },
    BUDGET_MS,
  );

  it(
    'refuses an oversized chunked body (413, or a reset once cut off) and keeps serving',
    async () => {
      const port = await startServer();
      const status = await new Promise<number>((resolve) => {
        const sock = net.connect(port, '127.0.0.1');
        let raw = '';
        sock.on('data', (c: Buffer) => {
          raw += c.toString();
        });
        sock.on('close', () => resolve(Number(/HTTP\/1\.1 (\d{3})/.exec(raw)?.[1] ?? 0)));
        sock.on('error', () => resolve(0));
        sock.on('connect', () => {
          sock.write(
            `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${TOKEN}\r\n` +
              'Accept: application/json, text/event-stream\r\nContent-Type: application/json\r\n' +
              'Transfer-Encoding: chunked\r\n\r\n',
          );
          const mb = Buffer.alloc(1024 * 1024, 0x61);
          for (let i = 0; i < 12; i += 1) {
            sock.write(`${mb.length.toString(16)}\r\n`);
            sock.write(mb);
            sock.write('\r\n');
          }
        });
      });
      // The client is still sending when the server drops it, so a reset can
      // beat the 413 to the client; anything else (a 200, say) is a failure.
      expect([413, 0]).toContain(status);
      const after = await post(port, { jsonrpc: '2.0', id: 9, method: 'ping' });
      expect(after.status).toBe(200);
    },
    BUDGET_MS,
  );

  it(
    'exits within five seconds of SIGTERM',
    async () => {
      const port = await startServer();
      await post(port, { jsonrpc: '2.0', id: 1, method: 'ping' });
      const proc = child as ChildProcessWithoutNullStreams;
      const started = Date.now();
      const exited = new Promise<number | null>((resolve) => {
        proc.once('exit', (code) => resolve(code));
      });
      proc.kill('SIGTERM');
      const code = await exited;
      expect(Date.now() - started).toBeLessThan(5000);
      expect(code).toBe(0);
    },
    BUDGET_MS,
  );
});
