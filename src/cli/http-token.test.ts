/**
 * Loopback is not a trust boundary. Any local process can reach 127.0.0.1,
 * so /mcp must require a bearer token even there. The token is generated
 * once, stored 0o600, and an explicit --no-token opt-out is required to
 * disable it.
 */

import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
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

afterEach(async () => {
  if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child = undefined;
  if (sandbox) {
    await fs.rm(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  }
});

async function startServer(
  extraArgs: string[] = [],
  extraEnv: Record<string, string> = {},
): Promise<{ port: number; token?: string; stderr: string }> {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-token-'));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  let stderr = '';
  let token: string | undefined;

  child = spawn(
    process.execPath,
    ['--import', 'tsx', ENTRY, 'http', '--port', String(port), ...extraArgs],
    {
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
        ...extraEnv,
      },
    },
  );

  child.stderr.on('data', (c: Buffer) => {
    const text = c.toString();
    stderr += text;
    const m = /Generated HTTP token.*: (\S+)/.exec(text);
    if (m) token = m[1];
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), BUDGET_MS);
    child?.stderr.on('data', (c: Buffer) => {
      if (c.toString().includes('Streamable HTTP')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child?.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited during startup (${code}): ${stderr}`));
    });
  });

  // Token file may have been written — wait a tick for fs
  await new Promise((r) => setTimeout(r, 100));
  if (!token) {
    try {
      const tokenPath = path.join(sandbox, 'config', 'email-mcp', 'http-token');
      token = (await fs.readFile(tokenPath, 'utf-8')).trim();
    } catch {}
  }

  return { port, token, stderr };
}

function request(port: number, headers: Record<string, string> = {}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = net.connect(port, '127.0.0.1');
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n');
    const extra = headerLines ? `${headerLines}\r\n` : '';
    req.on('connect', () => {
      req.write(
        `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n${extra}Content-Length: 2\r\n\r\n{}`,
      );
      req.end();
    });
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString();
    });
    req.on('close', () => {
      const m = /HTTP\/1\.1 (\d{3})/.exec(raw);
      resolve({ status: m ? Number(m[1]) : 0 });
    });
    req.on('error', reject);
  });
}

describe('http loopback token', () => {
  it(
    'requires a token on loopback, serves with it, and stores it 0o600',
    async () => {
      const { port, token } = await startServer();
      expect(token).toBeTruthy();

      // No token → 401
      const noAuth = await request(port);
      expect(noAuth.status).toBe(401);

      // With token → not 401 (will be 400/404 for empty body, but not unauthorized)
      const withAuth = await request(port, { Authorization: `Bearer ${token}` });
      expect(withAuth.status).not.toBe(401);

      // File mode 0o600
      const tokenPath = path.join(sandbox!, 'config', 'email-mcp', 'http-token');
      const stat = await fs.stat(tokenPath);
      expect(stat.mode & 0o777).toBe(0o600);

      // /healthz stays open without token
      const health = await new Promise<{ status: number }>((resolve, reject) => {
        const req = net.connect(port, '127.0.0.1');
        req.on('connect', () => {
          req.write(`GET /healthz HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\n\r\n`);
          req.end();
        });
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString()));
        req.on('close', () => {
          const m = /HTTP\/1\.1 (\d{3})/.exec(raw);
          resolve({ status: m ? Number(m[1]) : 0 });
        });
        req.on('error', reject);
      });
      expect(health.status).toBe(200);
    },
    BUDGET_MS * 2,
  );

  it(
    '--no-token serves without auth and warns',
    async () => {
      const { port, stderr } = await startServer(['--no-token']);
      expect(stderr).toContain('WARNING: running without authentication');

      const noAuth = await request(port);
      expect(noAuth.status).not.toBe(401);
    },
    BUDGET_MS * 2,
  );
});
