/**
 * A scripted ManageSieve peer on loopback for unit tests. It speaks plain text,
 * which the client allows only for a loopback host.
 */

import net from 'node:net';

import type { AccountConfig } from '../types/index.js';

export interface ReceivedCommand {
  /** The command line with any literal cut out, e.g. `PUTSCRIPT "a" {5+}`. */
  line: string;
  /** The literal payload, if the command carried one. */
  literal?: string;
}

export interface FakeSieveServer {
  port: number;
  received: ReceivedCommand[];
  connections: () => number;
  close: () => Promise<void>;
}

export const DEFAULT_GREETING =
  '"IMPLEMENTATION" "fake"\r\n"SASL" "PLAIN"\r\n"SIEVE" "fileinto"\r\n"VERSION" "1.0"\r\nOK "ready"\r\n';

/**
 * `reply` returns the raw bytes for each command, or undefined to stay silent.
 * AUTHENTICATE goes to `auth`, which by default accepts the login.
 */
export async function startFakeSieveServer(
  reply: (cmd: ReceivedCommand) => string | undefined,
  greeting = DEFAULT_GREETING,
  auth: (cmd: ReceivedCommand) => string | undefined = () => 'OK "welcome"\r\n',
): Promise<FakeSieveServer> {
  const received: ReceivedCommand[] = [];
  let connections = 0;
  const server = net.createServer((socket) => {
    connections += 1;
    let buf = Buffer.alloc(0);
    let pending: { line: string; need: number } | undefined;
    socket.on('error', () => {});
    socket.write(greeting);
    socket.on('data', (chunk: Buffer) => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        if (pending) {
          if (buf.length < pending.need) return;
          const literal = buf.subarray(0, pending.need).toString('utf8');
          buf = buf.subarray(pending.need);
          const end = buf.indexOf('\r\n');
          if (end < 0) return;
          const rest = buf.subarray(0, end).toString('utf8');
          buf = buf.subarray(end + 2);
          const cmd = { line: `${pending.line}${rest}`, literal };
          pending = undefined;
          received.push(cmd);
          const out = reply(cmd);
          if (out !== undefined) socket.write(out);
          continue;
        }
        const end = buf.indexOf('\r\n');
        if (end < 0) return;
        const line = buf.subarray(0, end).toString('utf8');
        buf = buf.subarray(end + 2);
        const lit = /\{(\d+)\+?\}$/.exec(line);
        if (lit) {
          pending = { line, need: Number(lit[1]) };
          continue;
        }
        const cmd = { line };
        received.push(cmd);
        const out = line.startsWith('AUTHENTICATE') ? auth(cmd) : reply(cmd);
        if (out !== undefined) socket.write(out);
      }
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address();
  if (!address || typeof address !== 'object')
    throw new Error('fake ManageSieve server has no port');
  return {
    port: address.port,
    received,
    connections: () => connections,
    close: async () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.unref();
      }),
  };
}

/** An account that talks plain text to the fake server on loopback. */
export function loopbackSieveAccount(
  port: number,
  overrides: Partial<AccountConfig> = {},
): AccountConfig {
  return {
    name: 'test',
    email: 'user@example.com',
    username: 'user@example.com',
    password: 's3cret-password',
    imap: { host: '127.0.0.1', port: 993, tls: true, starttls: false, verifySsl: true },
    smtp: { host: '127.0.0.1', port: 465, tls: true, starttls: false, verifySsl: true },
    sieve: { enabled: true, host: '127.0.0.1', port, tls: false, starttls: false },
    ...overrides,
  };
}
