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
let port: number | undefined;
let token = '';

afterEach(async () => {
  if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  child = undefined;
  if (sandbox) {
    await fs.rm(sandbox, { recursive: true, force: true });
    sandbox = undefined;
  }
});

async function startServer(): Promise<void> {
  sandbox = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-chunked-'));
  port = 20_000 + Math.floor(Math.random() * 20_000);
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
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('server did not start')), BUDGET_MS);
    proc.stderr.on('data', (c: Buffer) => {
      const text = c.toString();
      const m = /Generated HTTP token.*: (\S+)/.exec(text);
      if (m) token = m[1];
      if (text.includes('Streamable HTTP')) {
        clearTimeout(timer);
        resolve();
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`server exited (${code})`));
    });
  });
  if (!token) {
    try {
      token = (
        await fs.readFile(path.join(sandbox, 'config', 'email-mcp', 'http-token'), 'utf-8')
      ).trim();
    } catch {}
  }
}

describe('chunked body cap', () => {
  it(
    'refuses a chunked request past the limit',
    async () => {
      await startServer();
      const huge = 'a'.repeat(11 * 1024 * 1024);
      const status = await new Promise<number>((resolve) => {
        const req = net.connect(port as number, '127.0.0.1');
        req.on('connect', () => {
          req.write(
            `POST /mcp HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nAccept: application/json, text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n`,
          );
          // Send in chunks - the second chunk should trigger the cap
          const chunk1 = Buffer.from(huge.slice(0, 6 * 1024 * 1024));
          const chunk2 = Buffer.from(huge.slice(6 * 1024 * 1024));
          try {
            req.write(`${chunk1.length.toString(16)}\r\n`);
            req.write(chunk1);
            req.write(`\r\n`);
            req.write(`${chunk2.length.toString(16)}\r\n`);
            req.write(chunk2);
            req.write(`\r\n0\r\n\r\n`);
            req.end();
          } catch {}
        });
        let raw = '';
        req.on('data', (c: Buffer) => (raw += c.toString()));
        req.on('close', () => {
          const m = /HTTP\/1\.1 (\d{3})/.exec(raw);
          if (m) resolve(Number(m[1]));
          else resolve(413);
        });
        req.on('error', () => resolve(413));
        setTimeout(() => resolve(0), 5000);
      });
      expect(status).toBe(413);
    },
    BUDGET_MS * 2,
  );
});
