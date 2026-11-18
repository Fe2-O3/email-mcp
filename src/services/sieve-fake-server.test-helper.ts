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

export interface ScriptStore {
  scripts: Map<string, string>;
  active: () => string | null;
  /** Reply function for startFakeSieveServer. */
  reply: (cmd: ReceivedCommand) => string | undefined;
}

const quote = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
const literal = (s: string): string => `{${Buffer.byteLength(s)}}\r\n${s}\r\n`;

/** First quoted argument of a command line. */
function argOf(line: string): string {
  const match = /^[A-Z]+ "((?:\\.|[^"\\])*)"/.exec(line);
  return (match?.[1] ?? '').replace(/\\(.)/g, '$1');
}

/** An in-memory ManageSieve server state behind the fake socket. */
export function scriptStore(
  initial: Record<string, string>,
  activeName: string | null,
  options: {
    /** CHECKSCRIPT (and PUTSCRIPT) answer NO with this text when it returns one. */
    reject?: (content: string) => string | undefined;
    /** PUTSCRIPT answers NO (QUOTA) for these names. */
    quotaFor?: (name: string) => boolean;
  } = {},
): ScriptStore {
  const scripts = new Map(Object.entries(initial));
  let active = activeName;
  const reply = (cmd: ReceivedCommand): string | undefined => {
    const verb = cmd.line.split(' ')[0];
    const name = argOf(cmd.line);
    switch (verb) {
      case 'LISTSCRIPTS':
        return `${[...scripts.keys()].map((n) => `${quote(n)}${n === active ? ' ACTIVE' : ''}\r\n`).join('')}OK\r\n`;
      case 'GETSCRIPT':
        return scripts.has(name)
          ? `${literal(scripts.get(name) as string)}OK\r\n`
          : 'NO (NONEXISTENT) "There is no script by that name"\r\n';
      case 'CHECKSCRIPT': {
        const why = options.reject?.(cmd.literal ?? '');
        return why ? `NO ${literal(why).trimEnd()}\r\n` : 'OK\r\n';
      }
      case 'PUTSCRIPT': {
        if (options.quotaFor?.(name)) return 'NO (QUOTA/MAXSCRIPTS) "Too many scripts"\r\n';
        const why = options.reject?.(cmd.literal ?? '');
        if (why) return `NO ${literal(why).trimEnd()}\r\n`;
        scripts.set(name, cmd.literal ?? '');
        return 'OK\r\n';
      }
      case 'DELETESCRIPT':
        if (name === active) return 'NO (ACTIVE) "Script is active"\r\n';
        if (!scripts.delete(name)) return 'NO (NONEXISTENT) "No such script"\r\n';
        return 'OK\r\n';
      case 'SETACTIVE':
        if (name === '') {
          active = null;
          return 'OK\r\n';
        }
        if (!scripts.has(name)) return 'NO (NONEXISTENT) "No such script"\r\n';
        active = name;
        return 'OK\r\n';
      default:
        return 'NO "unknown command"\r\n';
    }
  };
  return { scripts, active: () => active, reply };
}
