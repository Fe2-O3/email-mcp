/**
 * DNS rebinding: a hostile web page can point its own domain at 127.0.0.1 and
 * then talk to the local server from the victim's browser. Such a request still
 * carries the attacker's name in the Host header, so /mcp must refuse every Host
 * that is not on the allowlist, before the bearer-token check runs.
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
const TOKEN = 'host-check-test-token';

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

async function startServer(extraArgs: string[] = []): Promise<number> {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-host-'));
  const port = 20_000 + Math.floor(Math.random() * 20_000);
  let stderr = '';

  child = spawn(
    process.execPath,
    ['--import', 'tsx', ENTRY, 'http', '--port', String(port), '--token', TOKEN, ...extraArgs],
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
      },
    },
  );

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`server did not start: ${stderr}`)), BUDGET_MS);
    child?.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
      if (stderr.includes('Streamable HTTP')) {
        clearTimeout(timer);
        resolve();
      }
    });
    child?.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited during startup (${code}): ${stderr}`));
    });
  });
  return port;
}

/** POST /mcp with a valid token and the given Host header (null sends none, over HTTP/1.0). */
function status(port: number, host: string | null): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = net.connect(port, '127.0.0.1');
    const head =
      host === null
        ? 'POST /mcp HTTP/1.0\r\n'
        : `POST /mcp HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n`;
    req.on('connect', () => {
      req.write(`${head}Authorization: Bearer ${TOKEN}\r\nContent-Length: 2\r\n\r\n{}`);
    });
    let raw = '';
    req.on('data', (c: Buffer) => {
      raw += c.toString();
    });
    req.on('close', () => {
      const m = /HTTP\/1\.[01] (\d{3})/.exec(raw);
      resolve(m ? Number(m[1]) : 0);
    });
    req.on('error', reject);
  });
}

describe('http Host header check (DNS rebinding)', () => {
  it(
    'serves loopback names and refuses everything else, even with a valid token',
    async () => {
      const port = await startServer();

      // Loopback names pass the Host check (the request then fails on the empty
      // body, which is fine: anything but 403 means the guard let it through).
      await Promise.all(
        [`127.0.0.1:${port}`, `localhost:${port}`, `[::1]:${port}`, 'localhost'].map(
          async (host) => {
            expect(await status(port, host), host).not.toBe(403);
          },
        ),
      );

      // A rebinding page, lookalikes and an absent Host are all refused.
      await Promise.all(
        [
          `evil.example:${port}`,
          'evil.example',
          `localhost.evil.example:${port}`,
          `127.0.0.1.evil.example:${port}`,
          `192.168.1.5:${port}`,
        ].map(async (host) => {
          expect(await status(port, host), host).toBe(403);
        }),
      );
      expect(await status(port, null)).toBe(403);
    },
    BUDGET_MS * 2,
  );

  it(
    'accepts a name given in --allowed-hosts and still refuses others',
    async () => {
      const port = await startServer(['--allowed-hosts', 'mcp.example.test']);

      expect(await status(port, `mcp.example.test:${port}`)).not.toBe(403);
      expect(await status(port, `evil.example:${port}`)).toBe(403);
    },
    BUDGET_MS * 2,
  );

  it(
    'turns the check off only for an explicit wildcard',
    async () => {
      const port = await startServer(['--allowed-hosts', '*']);

      expect(await status(port, `evil.example:${port}`)).not.toBe(403);
    },
    BUDGET_MS * 2,
  );
});
