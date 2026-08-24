/**
 * The HTTP server must survive hostile input on the socket.
 *
 * A server that fronts a mailbox is exactly the thing an attacker pokes with
 * malformed requests, and Node's default for an escaped rejection is process
 * death — which takes the watcher and the scheduled-send loop down with it.
 * These tests drive a real child process over real TCP: each case sends
 * something the request path should refuse, then asserts the process still
 * answers afterward. Liveness after is the assertion; the status code alone
 * would pass even if the process died between requests.
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
const BUDGET_MS = 20_000;

let child: ChildProcessWithoutNullStreams | undefined;
let sandbox: string | undefined;
let port: number | undefined;

afterEach(async () => {
  if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child = undefined;
  if (sandbox) {
    await fs.rm(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  }
});

async function startServer(): Promise<{ port: number; token: string }> {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-http-resilience-'));
  port = 20_000 + Math.floor(Math.random() * 20_000);
  let token = '';

  child = spawn(process.execPath, ['--import', 'tsx', ENTRY, 'http', '--port', String(port)], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      XDG_CONFIG_HOME: path.join(sandbox, 'config'),
      XDG_DATA_HOME: path.join(sandbox, 'data'),
      XDG_STATE_HOME: path.join(sandbox, 'state'),
      MCP_EMAIL_ADDRESS: 'test@example.invalid',
      MCP_EMAIL_PASSWORD: 'unused',
      MCP_EMAIL_IMAP_HOST: 'imap.example.invalid',
      MCP_EMAIL_SMTP_HOST: 'smtp.example.invalid',
      MCP_EMAIL_WATCHER_ENABLED: 'false',
    },
  });
  const proc = child as ChildProcessWithoutNullStreams;

  // Wait for the listen banner on stderr.
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), BUDGET_MS);
    proc.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString();
      const m = /Generated HTTP token.*: (\S+)/.exec(text);
      if (m) token = m[1];
      if (text.includes('Streamable HTTP')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited during startup (${code})`));
    });
  });

  if (!token) {
    try {
      token = (
        await fs.readFile(path.join(sandbox, 'config', 'email-mcp', 'http-token'), 'utf-8')
      ).trim();
    } catch {}
  }

  return { port: port as number, token };
}

function request(
  method: string,
  pathName: string,
  headers: Record<string, string>,
  body?: string,
): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = net.connect(port as number, '127.0.0.1');
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    req.on('connect', () => {
      req.write(
        `${method} ${pathName} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${headerLines}\r\n\r\n`,
      );
      if (body) req.write(body);
      req.end();
    });
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString();
    });
    req.on('close', () => {
      const match = /HTTP\/1\.1 (\d{3})/.exec(raw);
      resolve({ status: match ? Number(match[1]) : 0 });
    });
    req.on('error', reject);
  });
}

/** The liveness assertion every case ends with. */
async function assertStillServing(): Promise<void> {
  const health = await request('GET', '/healthz', {});
  expect(health.status).toBe(200);
}

describe('http server resilience', () => {
  it(
    'survives malformed JSON, oversized bodies, and mid-body resets',
    async () => {
      const { token } = await startServer();
      const auth = { Authorization: `Bearer ${token}` };

      // Malformed JSON → protocol-level 400 from the transport.
      const garbage = await request(
        'POST',
        '/mcp',
        { 'content-type': 'application/json', Authorization: auth.Authorization },
        '{not json at all',
      );
      expect(garbage.status).toBe(400);
      await assertStillServing();

      // Oversized declared body → refused before the transport reads it.
      const huge = await request(
        'POST',
        '/mcp',
        {
          'content-type': 'application/json',
          'content-length': String(64 * 1024 * 1024),
          Authorization: auth.Authorization,
        },
        '',
      );
      expect(huge.status).toBe(413);
      await assertStillServing();

      // One byte then hard reset: the classic socket-abuse probe.
      await new Promise<void>((resolve) => {
        const sock = net.connect(port as number, '127.0.0.1');
        sock.on('connect', () => {
          sock.write(
            'POST /mcp HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{',
          );
          sock.resetAndDestroy();
          resolve();
        });
        sock.on('error', () => resolve());
      });
      await assertStillServing();
    },
    BUDGET_MS * 2,
  );
});
