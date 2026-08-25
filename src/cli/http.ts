/**
 * Streamable HTTP transport entry point ("Method 2", MCP spec 2026-07-28).
 *
 * Serves the same server graph as stdio over HTTP using the SDK v2 node
 * adapter's `NodeStreamableHTTPServerTransport` in stateless mode. Security:
 *   • DNS-rebinding protection via `Host` header validation.
 *   • Bearer-token auth (env `EMAIL_MCP_HTTP_TOKEN` or `--token`).
 *   • Refuses to bind a non-loopback interface without a token (use
 *     `--insecure` to override, e.g. when TLS + auth is terminated upstream).
 *
 * Run:  email-mcp http --port 8080            → http://127.0.0.1:8080/mcp
 *       email-mcp http --host 0.0.0.0 --port 8080 --token "$SECRET"
 */

import { randomBytes, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  createServer as createHttpServer,
  type IncomingMessage,
  type ServerResponse,
} from 'node:http';
import path from 'node:path';
import {
  hostHeaderValidation,
  NodeStreamableHTTPServerTransport,
} from '@modelcontextprotocol/node';
import { buildServer, buildServices, startBackgroundServices } from '../app.js';
import { xdg } from '../config/xdg.js';

interface HttpOptions {
  host: string;
  port: number;
  path: string;
  token?: string;
  allowedHosts: string[]; // empty ⇒ validation disabled (wildcard)
  insecure: boolean;
  noToken: boolean;
}

const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost', '[::1]']);

const HTTP_TOKEN_FILE = path.join(xdg.config, 'http-token');

/**
 * Upper bound on one request body. Matches the SDK's own 10 MB message cap:
 * anything larger cannot be a valid MCP message, and without this the
 * transport buffers whatever arrives with no ceiling at all.
 */
const MAX_REQUEST_BODY_BYTES = 10 * 1024 * 1024;

function isLoopback(host: string): boolean {
  return LOOPBACK.has(host);
}

/** Parse `http` subcommand flags, falling back to env vars then defaults. */
function parseOptions(argv: string[]): HttpOptions {
  const env = process.env;
  const opts: HttpOptions = {
    host: env.EMAIL_MCP_HTTP_HOST ?? '127.0.0.1',
    port: Number(env.EMAIL_MCP_HTTP_PORT ?? '8080'),
    path: env.EMAIL_MCP_HTTP_PATH ?? '/mcp',
    token: env.EMAIL_MCP_HTTP_TOKEN,
    allowedHosts: (env.EMAIL_MCP_HTTP_ALLOWED_HOSTS ?? '')
      .split(',')
      .map((h) => h.trim())
      .filter(Boolean),
    insecure: false,
    noToken: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const value = argv[i + 1] ?? '';
    switch (arg) {
      case '--host':
        opts.host = value;
        i += 1;
        break;
      case '--port':
        opts.port = Number(value);
        i += 1;
        break;
      case '--path':
        opts.path = value;
        i += 1;
        break;
      case '--token':
        opts.token = value;
        i += 1;
        break;
      case '--allowed-hosts':
        opts.allowedHosts = value
          .split(',')
          .map((h) => h.trim())
          .filter(Boolean);
        i += 1;
        break;
      case '--insecure':
        opts.insecure = true;
        break;
      case '--no-token':
        opts.noToken = true;
        break;
      default:
        // Ignore unknown flags (keeps forward-compatibility).
        break;
    }
  }

  if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
    throw new Error(`Invalid --port: ${opts.port}`);
  }
  return opts;
}

/** Constant-time bearer-token check. */
function tokenMatches(header: string | undefined, token: string): boolean {
  const prefix = 'Bearer ';
  if (!header?.startsWith(prefix)) return false;
  const provided = Buffer.from(header.slice(prefix.length));
  const expected = Buffer.from(token);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export default async function runHttp(argv: string[]): Promise<void> {
  const opts = parseOptions(argv);

  // Token handling: generate on first run unless explicitly opted out.
  if (opts.noToken) {
    process.stderr.write(
      '[email-mcp] WARNING: running without authentication (--no-token). ' +
        'Any local process can access all 49 tools.\n',
    );
    opts.token = undefined;
  } else if (!opts.token) {
    try {
      const existing = await fs.readFile(HTTP_TOKEN_FILE, 'utf-8');
      const trimmed = existing.trim();
      if (trimmed) {
        opts.token = trimmed;
      } else {
        throw new Error('empty token file');
      }
    } catch {
      // No token yet — generate, persist 0o600, print once.
      const generated = randomBytes(32).toString('base64url');
      await fs.mkdir(path.dirname(HTTP_TOKEN_FILE), { recursive: true, mode: 0o700 });
      await fs.writeFile(HTTP_TOKEN_FILE, `${generated}\n`, { encoding: 'utf-8', mode: 0o600 });
      await fs.chmod(HTTP_TOKEN_FILE, 0o600);
      process.stderr.write(
        `[email-mcp] Generated HTTP token (printed once): ${generated}\n` +
          `  Stored at ${HTTP_TOKEN_FILE} (mode 0o600). Use --token or EMAIL_MCP_HTTP_TOKEN to override.\n`,
      );
      opts.token = generated;
    }
  }

  // Safety: never expose a networked email server without authentication.
  if (!isLoopback(opts.host) && !opts.token && !opts.insecure) {
    throw new Error(
      `Refusing to bind ${opts.host} without authentication.\n` +
        `Set a token (EMAIL_MCP_HTTP_TOKEN or --token) so requests must present ` +
        `"Authorization: Bearer <token>", or pass --insecure if auth/TLS is ` +
        `terminated by an upstream proxy.`,
    );
  }

  const services = await buildServices();
  const server = buildServer(services);

  // Stateless Streamable HTTP (no session IDs) — matches the 2026-07-28 model.
  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const background = startBackgroundServices(services, server.server);

  // DNS-rebinding protection. Default to loopback names plus the bind host; a
  // reverse-proxy deployment sets EMAIL_MCP_HTTP_ALLOWED_HOSTS to its public
  // domain (or `*` to disable this check when the proxy already enforces Host).
  const wildcard = opts.allowedHosts.includes('*');
  const hostAllowlist =
    opts.allowedHosts.length > 0
      ? opts.allowedHosts
      : [
          'localhost',
          '127.0.0.1',
          '[::1]',
          ...(isLoopback(opts.host) || opts.host === '0.0.0.0' ? [] : [opts.host]),
        ];
  const validateHost = wildcard ? null : hostHeaderValidation(hostAllowlist);

  const httpServer = createHttpServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', `http://${req.headers.host ?? opts.host}`);

      // Unauthenticated, unrestricted health probe (for load balancers).
      if (req.method === 'GET' && url.pathname === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }

      if (url.pathname !== opts.path) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not_found' }));
        return;
      }

      // DNS-rebinding guard answers with 403 itself when it returns false.
      if (validateHost && !validateHost(req, res)) return;

      if (!opts.noToken && !tokenMatches(req.headers.authorization, opts.token ?? '')) {
        res.writeHead(401, {
          'content-type': 'application/json',
          'www-authenticate': 'Bearer',
        });
        res.end(JSON.stringify({ error: 'unauthorized' }));
        return;
      }

      // Refuse oversized bodies before the transport reads a byte. The
      // transport buffers request bodies without its own cap, so this is the
      // only bound on what one connection can make the process hold.
      // Chunked requests have no content-length, so also count as we stream.
      let received = 0;
      const onData = (chunk: Buffer): void => {
        received += chunk.length;
        if (received > MAX_REQUEST_BODY_BYTES) {
          if (!res.headersSent) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'payload_too_large' }));
          }
          req.destroy();
        }
      };
      req.on('data', onData);

      const contentLength = Number(req.headers['content-length'] ?? 0);
      if (contentLength > MAX_REQUEST_BODY_BYTES) {
        req.off('data', onData);
        res.writeHead(413, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'payload_too_large' }));
        return;
      }

      try {
        await transport.handleRequest(req, res);
      } finally {
        req.off('data', onData);
      }
    })().catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[email-mcp] http request error: ${message}\n`);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
      }
      res.end(JSON.stringify({ error: 'internal_error' }));
    });
  });

  const shutdown = async (): Promise<void> => {
    try {
      await background.stop();
      await new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
      });
      await services.connections.closeAll();
      await server.close();
    } catch (err) {
      // A signal handler may not discard its promise: an escaped rejection
      // here would kill the process mid-shutdown instead of finishing it.
      process.stderr.write(
        `[email-mcp] http shutdown error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  // The request path is fully guarded, but any other rejected promise in the
  // service graph would otherwise take the whole server down (Node's default
  // for unhandled rejections is a fatal throw). Log, keep serving.
  process.on('unhandledRejection', (reason) => {
    process.stderr.write(
      `[email-mcp] unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}\n`,
    );
  });
  process.on('uncaughtException', (err) => {
    process.stderr.write(`[email-mcp] uncaught exception: ${err.message}\n`);
  });

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      process.stderr.write(
        `email-mcp — port ${opts.port} is already in use; choose another with --port\n`,
      );
    } else {
      process.stderr.write(`email-mcp — HTTP server error: ${err.message}\n`);
    }
    // eslint-disable-next-line n/no-process-exit
    process.exit(1);
  });

  await new Promise<void>((resolve) => {
    httpServer.listen(opts.port, opts.host, () => {
      const auth = opts.token ? 'bearer-token auth ON' : 'NO AUTH (loopback only)';
      const hostCheck = wildcard ? 'Host check OFF' : `Host allowlist: ${hostAllowlist.join(', ')}`;
      process.stderr.write(
        `email-mcp — Streamable HTTP on http://${opts.host}:${opts.port}${opts.path} — ${auth}; ${hostCheck}\n`,
      );
      resolve();
    });
  });
}
