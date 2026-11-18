// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * ManageSieve (RFC 5804) client: capabilities, list, get, put, check, delete, activate.
 *
 * Ported from Mailoo's client (socket reader, byte budget, deadlines, PLAIN login) and
 * changed here:
 *   - responses are read as whole logical lines, so a `NO {n}` literal message (a
 *     multi-line syntax error) is read to the end instead of left in the buffer;
 *   - CHECKSCRIPT when the server advertises VERSION;
 *   - implicit TLS where configured, STARTTLS otherwise, certificates always checked;
 *     credentials go over plain text only to a loopback host;
 *   - OAUTHBEARER / XOAUTH2 for OAuth accounts, SASL PLAIN otherwise;
 *   - one connection serves several commands (a backup and a write in one session).
 *
 * The safety rules (allowlist, backups, previews) live in sieve-manager.service.ts.
 */

import type { Socket } from 'node:net';
import { isIP, connect as netConnect } from 'node:net';
import { TLSSocket, connect as tlsConnect } from 'node:tls';

import type { SentCredentials } from '../connections/credential-redaction.js';
import { REDACTED, redactedError, sentCredentials } from '../connections/credential-redaction.js';
import type { AccountConfig, OAuth2Config } from '../types/index.js';
import { isLoopbackHost } from '../utils/loopback.js';

/* eslint-disable no-param-reassign -- the ManageSieve reader mutates the connection buffer */

export const DEFAULT_SIEVE_PORT = 4190;

/** Script literal cap for uploads and server responses; oversized uploads never open a socket. */
export const MAX_SIEVE_SCRIPT_BYTES = 1024 * 1024;

/** One maximum-size script plus 64 KiB for framing, capabilities and status lines. */
export const MAX_SIEVE_RESPONSE_BYTES = MAX_SIEVE_SCRIPT_BYTES + 64 * 1024;

/** Absolute deadlines prevent a busy peer from holding an operation open indefinitely. */
export const SIEVE_CONNECT_TIMEOUT_MS = 15_000;
export const SIEVE_RESPONSE_TIMEOUT_MS = 30_000;
export const SIEVE_TLS_HANDSHAKE_TIMEOUT_MS = 30_000;

/**
 * RFC 5804 §1.6: servers must accept names up to 128 characters and may accept
 * longer. 255 is a client-side ceiling above that floor so an oversized name is
 * refused before a connection is opened.
 */
export const MAX_SIEVE_SCRIPT_NAME_CHARS = 255;

/**
 * Providers whose IMAP host is known to have no ManageSieve (checked 2026-11-17,
 * see docs/dev/sieve-plan.md). Without an explicit `sieve` block these answer
 * "not supported" without a connection attempt.
 */
const NO_MANAGESIEVE_DOMAINS = [
  'gmail.com',
  'googlemail.com',
  'outlook.com',
  'office365.com',
  'hotmail.com',
  'live.com',
  'me.com',
  'icloud.com',
  'yahoo.com',
  'zoho.com',
  'zoho.eu',
  'zoho.in',
  'fastmail.com',
  'posteo.de',
  'runbox.com',
  'strato.de',
  'secureserver.net',
];

export const SIEVE_NOT_SUPPORTED_HINT =
  'Use local rules instead (add_local_rule). They run only while IMAP Wizard is running.';

export interface SieveScriptInfo {
  name: string;
  active: boolean;
}

export type SieveSecurity = 'tls' | 'starttls' | 'plain';

export interface SieveEndpoint {
  host: string;
  port: number;
  security: SieveSecurity;
  /** True when the account has a `sieve` block, false when auto-detected. */
  configured: boolean;
}

export type SieveEndpointResolution =
  | { kind: 'endpoint'; endpoint: SieveEndpoint }
  | { kind: 'disabled'; reason: string }
  | { kind: 'unsupported'; reason: string };

export interface SieveCapabilities {
  implementation?: string;
  sieveExtensions: string[];
  notifyMethods: string[];
  sasl: string[];
  starttls: boolean;
  /** RFC 5804 VERSION; when present the server supports CHECKSCRIPT. */
  version?: string;
  maxRedirects?: number;
  owner?: string;
}

export interface SieveStatus {
  available: boolean;
  host?: string;
  port?: number;
  security?: SieveSecurity;
  /** Why rules are unavailable, and what to do instead. */
  reason?: string;
  capabilities?: SieveCapabilities;
  scripts?: SieveScriptInfo[];
  active?: string | null;
}

interface Token {
  kind: 'atom' | 'string' | 'code';
  value: string;
}

export interface SieveResponse {
  status: 'OK' | 'NO' | 'BYE' | 'CONTINUE';
  /** First word of the response code, e.g. NONEXISTENT, ACTIVE, WARNINGS, QUOTA/MAXSCRIPTS. */
  code?: string;
  message: string;
  data: Token[][];
}

/** A command the server answered with NO or BYE. The message is complete (literals included). */
export class SieveCommandError extends Error {
  readonly command: string;

  readonly code?: string;

  readonly serverMessage: string;

  constructor(command: string, response: SieveResponse) {
    const code = response.code ? ` (${response.code})` : '';
    super(`${command} failed${code}: ${response.message || response.status}`);
    this.name = 'SieveCommandError';
    this.command = command;
    this.code = response.code;
    this.serverMessage = response.message;
  }
}

export interface SieveSession {
  readonly endpoint: SieveEndpoint;
  readonly capabilities: SieveCapabilities;
  listScripts: () => Promise<SieveScriptInfo[]>;
  /** Throws SieveCommandError with code NONEXISTENT when there is no such script. */
  getScript: (name: string) => Promise<string>;
  /** Returns the server's warning text, if any. Saving over the active script makes it live. */
  putScript: (name: string, content: string) => Promise<{ warnings?: string }>;
  /** Server-side syntax check; `supported: false` when the server has no CHECKSCRIPT. */
  checkScript: (
    content: string,
  ) => Promise<{ supported: boolean; ok: boolean; message: string; warnings?: string }>;
  deleteScript: (name: string) => Promise<void>;
  /** An empty name deactivates every script. */
  setActive: (name: string) => Promise<void>;
  /** Cuts the credentials this session sent out of server text that is returned whole. */
  scrub: (text: string) => string;
}

export interface SieveServiceOptions {
  /** Access token for OAuth accounts (OAUTHBEARER / XOAUTH2). */
  getAccessToken?: (oauth2: OAuth2Config) => Promise<string>;
}

interface SieveConn {
  socket: Socket;
  buf: Buffer;
  /** A socket error seen while no read was waiting; the next read rejects with it. */
  pendingError?: Error;
  detach: () => void;
}

interface ResponseBudget {
  bytes: number;
  error?: Error;
  rejectWait?: (err: Error) => void;
}

// ---------------------------------------------------------------------------
// Endpoint
// ---------------------------------------------------------------------------

function knownWithoutManageSieve(host: string): boolean {
  const h = host.toLowerCase().replace(/\.$/, '');
  return NO_MANAGESIEVE_DOMAINS.some((domain) => h === domain || h.endsWith(`.${domain}`));
}

export function resolveSieveEndpoint(account: AccountConfig): SieveEndpointResolution {
  const { sieve } = account;
  if (sieve && !sieve.enabled) {
    return {
      kind: 'disabled',
      reason: `Sieve is disabled for account "${account.name}" in config. ${SIEVE_NOT_SUPPORTED_HINT}`,
    };
  }
  if (!sieve && knownWithoutManageSieve(account.imap.host)) {
    return {
      kind: 'unsupported',
      reason:
        `Server-side rules (ManageSieve) are not supported by this provider (${account.imap.host}). ` +
        SIEVE_NOT_SUPPORTED_HINT,
    };
  }
  let security: SieveSecurity = 'starttls';
  if (sieve?.tls) security = 'tls';
  else if (sieve && !sieve.starttls) security = 'plain';
  return {
    kind: 'endpoint',
    endpoint: {
      host: sieve?.host ?? account.imap.host,
      port: sieve?.port ?? DEFAULT_SIEVE_PORT,
      security,
      configured: Boolean(sieve),
    },
  };
}

// ---------------------------------------------------------------------------
// Encoding helpers
// ---------------------------------------------------------------------------

export function encodePlainAuth(user: string, pass: string): string {
  return Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
}

export function encodeOAuthBearer(user: string, host: string, port: number, token: string): string {
  return Buffer.from(
    `n,a=${user},\x01host=${host}\x01port=${port}\x01auth=Bearer ${token}\x01\x01`,
    'utf8',
  ).toString('base64');
}

export function encodeXOAuth2(user: string, token: string): string {
  return Buffer.from(`user=${user}\x01auth=Bearer ${token}\x01\x01`, 'utf8').toString('base64');
}

function quoteSieve(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

export function assertSieveScriptName(name: string, allowEmpty = false): void {
  if (allowEmpty && name.length === 0) return;
  if (name.length === 0) {
    throw new Error('Script name must not be empty');
  }
  if (name.length > MAX_SIEVE_SCRIPT_NAME_CHARS) {
    throw new Error('Script name is too long');
  }
  /* eslint-disable no-control-regex */
  // biome-ignore lint/suspicious/noControlCharactersInRegex: intentional — reject control chars in script names
  if (/[\u0000-\u001F\u007F-\u009F\u2028\u2029]/.test(name)) {
    throw new Error('Script name must not contain control characters');
  }
  /* eslint-enable no-control-regex */
}

export function assertSieveScriptContent(content: string): void {
  if (Buffer.byteLength(content, 'utf8') > MAX_SIEVE_SCRIPT_BYTES) {
    throw new Error(`Script is too large (maximum ${MAX_SIEVE_SCRIPT_BYTES} bytes)`);
  }
}

// ---------------------------------------------------------------------------
// Response parsing
// ---------------------------------------------------------------------------

/** Tokenizes the text between literals of one response line. */
export function tokenizeResponseText(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (ch === ' ' || ch === '\t') {
      i += 1;
    } else if (ch === '"') {
      let value = '';
      i += 1;
      let closed = false;
      while (i < text.length) {
        const c = text[i] as string;
        if (c === '\\' && i + 1 < text.length) {
          value += text[i + 1];
          i += 2;
        } else if (c === '"') {
          closed = true;
          i += 1;
          break;
        } else {
          value += c;
          i += 1;
        }
      }
      if (!closed) throw new Error('ManageSieve response has an unterminated quoted string');
      tokens.push({ kind: 'string', value });
    } else if (ch === '(') {
      let depth = 0;
      let inQuote = false;
      const start = i;
      for (; i < text.length; i += 1) {
        const c = text[i];
        if (inQuote) {
          if (c === '\\') i += 1;
          else if (c === '"') inQuote = false;
        } else if (c === '"') inQuote = true;
        else if (c === '(') depth += 1;
        else if (c === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      if (depth !== 0) throw new Error('ManageSieve response has an unterminated response code');
      tokens.push({ kind: 'code', value: text.slice(start + 1, i).trim() });
      i += 1;
    } else {
      const start = i;
      while (i < text.length && !/[\s"()]/.test(text[i] as string)) i += 1;
      tokens.push({ kind: 'atom', value: text.slice(start, i) });
    }
  }
  return tokens;
}

export function parseCapabilities(lines: Token[][]): SieveCapabilities {
  const raw: Record<string, string> = {};
  lines.forEach((tokens) => {
    const [key, value] = tokens;
    if (key?.kind === 'string') raw[key.value.toUpperCase()] = value?.value ?? '';
  });
  const words = (value: string | undefined): string[] => (value ?? '').split(/\s+/).filter(Boolean);
  const maxRedirects = raw.MAXREDIRECTS ? Number(raw.MAXREDIRECTS) : undefined;
  return {
    implementation: raw.IMPLEMENTATION,
    sieveExtensions: words(raw.SIEVE),
    notifyMethods: words(raw.NOTIFY),
    sasl: words(raw.SASL).map((m) => m.toUpperCase()),
    starttls: raw.STARTTLS !== undefined,
    version: raw.VERSION,
    maxRedirects: Number.isFinite(maxRedirects) ? maxRedirects : undefined,
    owner: raw.OWNER,
  };
}

export function parseListScripts(lines: Token[][]): SieveScriptInfo[] {
  return lines.flatMap((tokens) => {
    const [name, flag] = tokens;
    if (name?.kind !== 'string') return [];
    return [{ name: name.value, active: flag?.kind === 'atom' && /^ACTIVE$/i.test(flag.value) }];
  });
}

// ---------------------------------------------------------------------------
// Socket reader (Mailoo)
// ---------------------------------------------------------------------------

function bindSocketWait(
  conn: SieveConn,
  budget: ResponseBudget,
  tryConsume: () => boolean,
  reject: (err: Error) => void,
): void {
  /* eslint-disable @typescript-eslint/no-use-before-define -- finish and the listeners close over each other */
  function finish(): void {
    conn.socket.off('data', onData);
    conn.socket.off('error', onError);
    conn.socket.off('end', onEnd);
    conn.socket.off('close', onEnd);
    budget.rejectWait = undefined;
  }
  function onData(chunk: Buffer): void {
    budget.bytes += chunk.length;
    if (budget.bytes > MAX_SIEVE_RESPONSE_BYTES) {
      onError(new Error(`ManageSieve response exceeds ${MAX_SIEVE_RESPONSE_BYTES} bytes`));
      conn.socket.destroy();
      return;
    }
    conn.buf = Buffer.concat([conn.buf, chunk]);
    if (tryConsume()) finish();
  }
  function onError(err: Error): void {
    finish();
    reject(err);
  }
  function onEnd(): void {
    finish();
    reject(new Error('ManageSieve connection closed before the response completed'));
  }
  /* eslint-enable @typescript-eslint/no-use-before-define */
  conn.socket.on('data', onData);
  conn.socket.once('error', onError);
  conn.socket.once('end', onEnd);
  conn.socket.once('close', onEnd);
  budget.rejectWait = onError;
  if (conn.socket.destroyed || conn.socket.readableEnded) onEnd();
}

function failFast(conn: SieveConn, budget: ResponseBudget): void {
  if (budget.error) throw budget.error;
  if (conn.pendingError) throw conn.pendingError;
}

async function readLine(conn: SieveConn, budget: ResponseBudget): Promise<string> {
  failFast(conn, budget);
  return new Promise((resolve, reject) => {
    const tryConsume = (): boolean => {
      const idx = conn.buf.indexOf(10);
      if (idx < 0) return false;
      const line = conn.buf.subarray(0, idx).toString('utf8').replace(/\r$/, '');
      conn.buf = conn.buf.subarray(idx + 1);
      resolve(line);
      return true;
    };
    if (tryConsume()) return;
    bindSocketWait(conn, budget, tryConsume, reject);
  });
}

async function readBytes(conn: SieveConn, n: number, budget: ResponseBudget): Promise<string> {
  failFast(conn, budget);
  return new Promise((resolve, reject) => {
    const tryConsume = (): boolean => {
      if (conn.buf.length < n) return false;
      const payload = conn.buf.subarray(0, n).toString('utf8');
      conn.buf = conn.buf.subarray(n);
      resolve(payload);
      return true;
    };
    if (tryConsume()) return;
    bindSocketWait(conn, budget, tryConsume, reject);
  });
}

/** One response line with its literals read in place: `NO {42}` + 42 bytes + the rest of the line. */
async function readLogicalLine(conn: SieveConn, budget: ResponseBudget): Promise<Token[]> {
  const tokens: Token[] = [];
  while (true) {
    // eslint-disable-next-line no-await-in-loop -- protocol lines and literals must be consumed in order
    const line = await readLine(conn, budget);
    const literal = /\{(\d+)\+?\}$/.exec(line);
    if (!literal) {
      tokens.push(...tokenizeResponseText(line));
      return tokens;
    }
    tokens.push(...tokenizeResponseText(line.slice(0, literal.index)));
    const length = Number(literal[1]);
    if (!Number.isSafeInteger(length) || length > MAX_SIEVE_SCRIPT_BYTES) {
      throw new Error(
        `ManageSieve literal exceeds ${MAX_SIEVE_SCRIPT_BYTES} bytes or has an invalid length`,
      );
    }
    // eslint-disable-next-line no-await-in-loop -- the literal follows its length declaration
    tokens.push({ kind: 'string', value: await readBytes(conn, length, budget) });
  }
}

function statusOf(tokens: Token[]): 'OK' | 'NO' | 'BYE' | undefined {
  const [first] = tokens;
  if (first?.kind !== 'atom') return undefined;
  const word = first.value.toUpperCase();
  return word === 'OK' || word === 'NO' || word === 'BYE' ? word : undefined;
}

async function readResponse(
  conn: SieveConn,
  options: { allowChallenge?: boolean } = {},
): Promise<SieveResponse> {
  const data: Token[][] = [];
  const budget: ResponseBudget = { bytes: conn.buf.length };
  if (budget.bytes > MAX_SIEVE_RESPONSE_BYTES) {
    throw new Error(`ManageSieve response exceeds ${MAX_SIEVE_RESPONSE_BYTES} bytes`);
  }
  const timer = setTimeout(() => {
    const error = new Error('ManageSieve response timeout');
    budget.error = error;
    budget.rejectWait?.(error);
    conn.socket.destroy();
  }, SIEVE_RESPONSE_TIMEOUT_MS);
  try {
    while (true) {
      // eslint-disable-next-line no-await-in-loop -- response lines are consumed in order
      const tokens = await readLogicalLine(conn, budget);
      const status = statusOf(tokens);
      if (status) {
        const rest = tokens.slice(1);
        const code = rest[0]?.kind === 'code' ? rest.shift() : undefined;
        const message = rest.find((t) => t.kind === 'string')?.value ?? '';
        return {
          status,
          code: code?.value.split(/\s+/)[0]?.toUpperCase(),
          message,
          data,
        };
      }
      if (options.allowChallenge) return { status: 'CONTINUE', message: '', data: [tokens] };
      data.push(tokens);
    }
  } finally {
    clearTimeout(timer);
  }
}

async function command(
  conn: SieveConn,
  name: string,
  wire: string | Buffer,
): Promise<SieveResponse> {
  conn.socket.write(wire);
  const response = await readResponse(conn);
  if (response.status !== 'OK') throw new SieveCommandError(name, response);
  return response;
}

function literalCommand(prefix: string, content: string): Buffer {
  const body = Buffer.from(content, 'utf8');
  return Buffer.concat([
    Buffer.from(`${prefix}{${body.length}+}\r\n`, 'utf8'),
    body,
    Buffer.from('\r\n', 'utf8'),
  ]);
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

function attach(socket: Socket): SieveConn {
  const conn: SieveConn = { socket, buf: Buffer.alloc(0), detach: () => {} };
  // Between commands no read is waiting; without this an error there would be unhandled.
  const onError = (err: Error): void => {
    conn.pendingError ??= err;
  };
  socket.on('error', onError);
  conn.detach = () => {
    socket.off('error', onError);
  };
  return conn;
}

async function connectTcp(host: string, port: number): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const socket = netConnect({ host, port });
    /* eslint-disable @typescript-eslint/no-use-before-define -- connection listeners share cleanup */
    const cleanup = (): void => {
      clearTimeout(timer);
      socket.off('connect', onConnect);
      socket.off('error', onError);
    };
    const timer = setTimeout(() => {
      cleanup();
      socket.destroy();
      reject(new Error(`ManageSieve connect timed out (${host}:${port})`));
    }, SIEVE_CONNECT_TIMEOUT_MS);
    function onConnect(): void {
      cleanup();
      resolve(socket);
    }
    function onError(err: Error): void {
      cleanup();
      socket.destroy();
      reject(err);
    }
    /* eslint-enable @typescript-eslint/no-use-before-define */
    socket.once('connect', onConnect);
    socket.once('error', onError);
  });
}

/** TLS over an existing socket (STARTTLS) or a new one (implicit TLS). Certificates are checked. */
async function handshakeTls(
  host: string,
  target: { socket: Socket } | { port: number },
): Promise<TLSSocket> {
  return new Promise((resolve, reject) => {
    /* eslint-disable @typescript-eslint/no-use-before-define -- handshake listeners share cleanup */
    const cleanup = (): void => {
      clearTimeout(timer);
      tlsSock.off('error', onError);
      tlsSock.off('end', onEnd);
      tlsSock.off('close', onEnd);
    };
    const tlsSock = tlsConnect(
      {
        ...('socket' in target ? { socket: target.socket } : { host, port: target.port }),
        // SNI takes a name, not an IP literal.
        servername: isIP(host) ? undefined : host,
        rejectUnauthorized: true,
      },
      () => {
        cleanup();
        resolve(tlsSock);
      },
    );
    function onError(err: Error): void {
      cleanup();
      tlsSock.destroy();
      reject(err);
    }
    function onTimeout(): void {
      onError(new Error('ManageSieve TLS handshake timeout'));
    }
    function onEnd(): void {
      onError(new Error('ManageSieve TLS connection closed during handshake'));
    }
    /* eslint-enable @typescript-eslint/no-use-before-define */
    const timer = setTimeout(onTimeout, SIEVE_TLS_HANDSHAKE_TIMEOUT_MS);
    tlsSock.once('error', onError);
    tlsSock.once('end', onEnd);
    tlsSock.once('close', onEnd);
  });
}

function encrypted(socket: Socket): boolean {
  return socket instanceof TLSSocket && socket.encrypted;
}

async function authenticate(
  conn: SieveConn,
  account: AccountConfig,
  endpoint: SieveEndpoint,
  caps: SieveCapabilities,
  options: SieveServiceOptions,
  sent: { secrets: (string | undefined)[] },
): Promise<void> {
  const offered = (mech: string): boolean => caps.sasl.includes(mech);
  let mechanism: string;
  let initial: string;
  if (account.oauth2) {
    if (!options.getAccessToken) {
      throw new Error('ManageSieve OAuth login is not available in this process');
    }
    const token = await options.getAccessToken(account.oauth2);
    sent.secrets.push(token);
    if (offered('OAUTHBEARER')) {
      mechanism = 'OAUTHBEARER';
      initial = encodeOAuthBearer(account.username, endpoint.host, endpoint.port, token);
    } else if (offered('XOAUTH2')) {
      mechanism = 'XOAUTH2';
      initial = encodeXOAuth2(account.username, token);
    } else {
      throw new Error(
        'This account uses OAuth, and the ManageSieve server offers neither OAUTHBEARER nor XOAUTH2',
      );
    }
  } else {
    const pass = account.password ?? '';
    if (!pass) throw new Error('ManageSieve needs the account password (or OAuth) to log in');
    if (caps.sasl.length > 0 && !offered('PLAIN')) {
      throw new Error(
        `The ManageSieve server does not offer SASL PLAIN (offers: ${caps.sasl.join(' ')})`,
      );
    }
    mechanism = 'PLAIN';
    initial = encodePlainAuth(account.username, pass);
  }
  sent.secrets.push(initial);
  conn.socket.write(`AUTHENTICATE "${mechanism}" "${initial}"\r\n`);
  let response = await readResponse(conn, { allowChallenge: true });
  if (response.status === 'CONTINUE') {
    // A challenge after an initial response is a failure report (RFC 7628 §3.2.3):
    // answer it as the mechanism requires, or cancel, and read the final NO.
    const reply = mechanism === 'OAUTHBEARER' ? '"AQ=="' : mechanism === 'XOAUTH2' ? '""' : '"*"';
    conn.socket.write(`${reply}\r\n`);
    response = await readResponse(conn);
  }
  if (response.status !== 'OK') throw new SieveCommandError('AUTHENTICATE', response);
}

async function openSession(
  account: AccountConfig,
  endpoint: SieveEndpoint,
  options: SieveServiceOptions,
  sent: { secrets: (string | undefined)[] },
  track: (conn: SieveConn) => void,
): Promise<{ conn: SieveConn; caps: SieveCapabilities }> {
  const { host, port, security } = endpoint;
  if (security === 'plain' && !isLoopbackHost(host)) {
    throw new Error(
      `Refusing to send credentials unencrypted to ${host}: set tls or starttls in the account's sieve block`,
    );
  }
  const first =
    security === 'tls' ? await handshakeTls(host, { port }) : await connectTcp(host, port);
  let conn = attach(first);
  track(conn);
  const greeting = await readResponse(conn);
  if (greeting.status !== 'OK') throw new SieveCommandError('Greeting', greeting);
  let caps = parseCapabilities(greeting.data);

  if (security === 'starttls') {
    if (!caps.starttls) {
      throw new Error(
        `ManageSieve server ${host}:${port} did not offer STARTTLS; refusing to log in unencrypted`,
      );
    }
    await command(conn, 'STARTTLS', 'STARTTLS\r\n');
    // Bytes that arrived before the handshake were not protected by it (STARTTLS injection).
    if (conn.buf.length > 0)
      throw new Error('ManageSieve server sent data before the TLS handshake');
    conn.detach();
    const tlsSock = await handshakeTls(host, { socket: conn.socket });
    conn = attach(tlsSock);
    track(conn);
    // RFC 5804 §2.2: the server re-sends its capabilities after the handshake.
    const postTls = await readResponse(conn);
    if (postTls.status !== 'OK') throw new SieveCommandError('STARTTLS', postTls);
    caps = parseCapabilities(postTls.data);
  }

  if (security !== 'plain' && !encrypted(conn.socket)) {
    throw new Error('ManageSieve connection is not encrypted; refusing to log in');
  }
  await authenticate(conn, account, endpoint, caps, options, sent);
  return { conn, caps };
}

function scrubber(secrets: readonly (string | undefined)[]): (text: string) => string {
  const cuts = secrets.filter((s): s is string => typeof s === 'string' && s.length >= 4);
  return (text) => cuts.reduce((out, secret) => out.split(secret).join(REDACTED), text);
}

function makeSession(
  conn: SieveConn,
  endpoint: SieveEndpoint,
  caps: SieveCapabilities,
  scrub: (text: string) => string,
): SieveSession {
  return {
    endpoint,
    capabilities: caps,
    scrub,
    listScripts: async () =>
      parseListScripts((await command(conn, 'LISTSCRIPTS', 'LISTSCRIPTS\r\n')).data),
    getScript: async (name) => {
      assertSieveScriptName(name);
      const resp = await command(conn, 'GETSCRIPT', `GETSCRIPT ${quoteSieve(name)}\r\n`);
      return resp.data.flat().find((t) => t.kind === 'string')?.value ?? '';
    },
    putScript: async (name, content) => {
      assertSieveScriptName(name);
      assertSieveScriptContent(content);
      const resp = await command(
        conn,
        'PUTSCRIPT',
        literalCommand(`PUTSCRIPT ${quoteSieve(name)} `, content),
      );
      return resp.code === 'WARNINGS' ? { warnings: resp.message } : {};
    },
    checkScript: async (content) => {
      assertSieveScriptContent(content);
      if (!caps.version) {
        return { supported: false, ok: true, message: 'The server does not support CHECKSCRIPT' };
      }
      conn.socket.write(literalCommand('CHECKSCRIPT ', content));
      const resp = await readResponse(conn);
      if (resp.status === 'BYE') throw new SieveCommandError('CHECKSCRIPT', resp);
      return {
        supported: true,
        ok: resp.status === 'OK',
        message: resp.message,
        warnings: resp.status === 'OK' && resp.code === 'WARNINGS' ? resp.message : undefined,
      };
    },
    deleteScript: async (name) => {
      assertSieveScriptName(name);
      await command(conn, 'DELETESCRIPT', `DELETESCRIPT ${quoteSieve(name)}\r\n`);
    },
    setActive: async (name) => {
      assertSieveScriptName(name, true);
      await command(conn, 'SETACTIVE', `SETACTIVE ${quoteSieve(name)}\r\n`);
    },
  };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class SieveUnavailableError extends Error {
  constructor(readonly resolution: Exclude<SieveEndpointResolution, { kind: 'endpoint' }>) {
    super(resolution.reason);
    this.name = 'SieveUnavailableError';
  }
}

export default class SieveService {
  constructor(private readonly options: SieveServiceOptions = {}) {}

  /**
   * Opens one authenticated connection, runs `action`, and closes it. Errors that
   * leave here are redacted (credentials cut, length capped); text an action
   * returns whole should go through `session.scrub`.
   */
  async withSession<T>(
    account: AccountConfig,
    action: (session: SieveSession) => Promise<T>,
  ): Promise<T> {
    const resolution = resolveSieveEndpoint(account);
    if (resolution.kind !== 'endpoint') throw new SieveUnavailableError(resolution);
    const { endpoint } = resolution;
    const base: SentCredentials = sentCredentials(account);
    const sent = { user: base.user, secrets: [...base.secrets] };
    const conns: SieveConn[] = [];
    try {
      const { conn, caps } = await openSession(account, endpoint, this.options, sent, (c) => {
        conns.push(c);
      });
      return await action(makeSession(conn, endpoint, caps, scrubber(sent.secrets)));
    } catch (err) {
      if (err instanceof SieveUnavailableError) throw err;
      throw redactedError(err, sent);
    } finally {
      conns.forEach((c) => {
        c.detach();
        c.socket.destroy();
      });
    }
  }

  /** Capabilities and scripts, or why server-side rules are unavailable. Never throws. */
  async status(account: AccountConfig): Promise<SieveStatus> {
    const resolution = resolveSieveEndpoint(account);
    if (resolution.kind !== 'endpoint') return { available: false, reason: resolution.reason };
    const { host, port, security } = resolution.endpoint;
    try {
      return await this.withSession(account, async (session) => {
        const scripts = await session.listScripts();
        return {
          available: true,
          host,
          port,
          security,
          capabilities: session.capabilities,
          scripts,
          active: scripts.find((s) => s.active)?.name ?? null,
        };
      });
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      return {
        available: false,
        host,
        port,
        security,
        reason:
          `ManageSieve is not reachable at ${host}:${port} (${why}). The provider may not offer ` +
          `server-side rules, or ManageSieve may use another host or port (set them in the ` +
          `account's sieve block). ${SIEVE_NOT_SUPPORTED_HINT}`,
      };
    }
  }
}
