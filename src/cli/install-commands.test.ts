import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { McpClient, Transport } from './install-commands.js';
import {
  buildServerEntry,
  getClients,
  removeCodexEntry,
  setCodexEntry,
} from './install-commands.js';

const TRANSPORTS: Transport[] = ['npx', 'pnpm', 'global', 'node'];

describe('buildServerEntry', () => {
  it('npx launches this fork package, not upstream', () => {
    expect(buildServerEntry('npx')).toEqual({
      command: 'npx',
      args: ['-y', 'imap-wizard', 'stdio'],
    });
  });

  it('pnpm dlx launches this fork package', () => {
    expect(buildServerEntry('pnpm')).toEqual({
      command: 'pnpm',
      args: ['dlx', 'imap-wizard', 'stdio'],
    });
  });

  it('global uses the imap-wizard command', () => {
    expect(buildServerEntry('global')).toEqual({ command: 'imap-wizard', args: ['stdio'] });
  });

  it('no transport ever references the upstream package', () => {
    for (const transport of TRANSPORTS) {
      expect(JSON.stringify(buildServerEntry(transport))).not.toContain('codefuturist');
    }
  });

  it('node transport runs the current script with stdio', () => {
    const entry = buildServerEntry('node');
    expect(entry.command).toBe(process.execPath);
    expect(entry.args.at(-1)).toBe('stdio');
  });
});

// ---------------------------------------------------------------------------
// New clients. Everything runs against a temp HOME, never the real one.
// ---------------------------------------------------------------------------

const ENV_KEYS = ['HOME', 'USERPROFILE', 'APPDATA', 'XDG_CONFIG_HOME', 'CODEX_HOME', 'PATH'];
const saved: Record<string, string | undefined> = {};
let home: string;
let binDir: string;

function client(id: string): McpClient {
  const found = getClients().find((c) => c.id === id);
  if (!found) throw new Error(`no client ${id}`);
  return found;
}

const entry = buildServerEntry('npx');

beforeEach(() => {
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'iw-install-'));
  binDir = path.join(home, 'bin');
  fs.mkdirSync(binDir);
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.APPDATA = path.join(home, 'AppData');
  process.env.XDG_CONFIG_HOME = path.join(home, '.config');
  process.env.CODEX_HOME = path.join(home, '.codex');
  process.env.PATH = binDir; // no real `claude` can be found
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fs.rmSync(home, { recursive: true, force: true });
});

function writeFile(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

describe('VS Code', () => {
  const file = () => client('vscode').location;

  it('uses the user-level mcp.json for this platform', () => {
    const expected = {
      darwin: path.join(home, 'Library', 'Application Support', 'Code', 'User', 'mcp.json'),
      linux: path.join(home, '.config', 'Code', 'User', 'mcp.json'),
      win32: path.join(home, 'AppData', 'Code', 'User', 'mcp.json'),
    }[os.platform() as string];
    if (expected) expect(file()).toBe(expected);
  });

  it('is detected when the User folder exists, not before', async () => {
    expect(await client('vscode').detect()).toBe(false);
    fs.mkdirSync(path.dirname(file()), { recursive: true });
    expect(await client('vscode').detect()).toBe(true);
  });

  it('writes a servers entry with type stdio', async () => {
    await client('vscode').write(entry);
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).toEqual({
      servers: { email: { type: 'stdio', command: 'npx', args: ['-y', 'imap-wizard', 'stdio'] } },
    });
    expect((await client('vscode').status()).state).toBe('registered');
  });

  it('updates an existing entry and keeps every other server and key', async () => {
    writeFile(
      file(),
      JSON.stringify({
        inputs: [{ id: 'x' }],
        servers: { other: { type: 'http', url: 'http://x' }, email: { command: 'old', args: [] } },
      }),
    );
    await client('vscode').write(buildServerEntry('global'));
    const cfg = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    expect(cfg.inputs).toEqual([{ id: 'x' }]);
    expect(cfg.servers.other).toEqual({ type: 'http', url: 'http://x' });
    expect(cfg.servers.email).toEqual({ type: 'stdio', command: 'imap-wizard', args: ['stdio'] });
    expect(fs.existsSync(`${file()}.imap-wizard.bak`)).toBe(true);
  });

  it('removes only the email entry', async () => {
    writeFile(file(), JSON.stringify({ servers: { other: { command: 'a' }, email: entry } }));
    await client('vscode').remove();
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).toEqual({
      servers: { other: { command: 'a' } },
    });
    expect((await client('vscode').status()).state).toBe('unregistered');
  });
});

describe('OpenCode', () => {
  const file = () => path.join(home, '.config', 'opencode', 'opencode.json');

  it('respects XDG_CONFIG_HOME', () => {
    process.env.XDG_CONFIG_HOME = path.join(home, 'xdg');
    expect(client('opencode').location).toBe(path.join(home, 'xdg', 'opencode', 'opencode.json'));
  });

  it('writes the local command array', async () => {
    await client('opencode').write(entry);
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).toEqual({
      mcp: {
        email: {
          type: 'local',
          command: ['npx', '-y', 'imap-wizard', 'stdio'],
          enabled: true,
        },
      },
    });
  });

  it('updates in place, keeping a hand-set timeout and other content', async () => {
    writeFile(
      file(),
      JSON.stringify({
        theme: 'dark',
        mcp: {
          other: { type: 'local', command: ['x'] },
          email: { type: 'local', command: ['old'], enabled: false, timeout: 180000 },
        },
      }),
    );
    await client('opencode').write(buildServerEntry('global'));
    const cfg = JSON.parse(fs.readFileSync(file(), 'utf-8'));
    expect(cfg.theme).toBe('dark');
    expect(cfg.mcp.other).toEqual({ type: 'local', command: ['x'] });
    expect(cfg.mcp.email).toEqual({
      type: 'local',
      command: ['imap-wizard', 'stdio'],
      enabled: true,
      timeout: 180000,
    });
    expect((await client('opencode').status()).command).toBe('imap-wizard stdio');
  });

  it('removes only the email entry', async () => {
    writeFile(
      file(),
      JSON.stringify({ theme: 'dark', mcp: { other: { command: ['x'] }, email: {} } }),
    );
    await client('opencode').remove();
    expect(JSON.parse(fs.readFileSync(file(), 'utf-8'))).toEqual({
      theme: 'dark',
      mcp: { other: { command: ['x'] } },
    });
  });
});

describe('Codex', () => {
  const file = () => path.join(home, '.codex', 'config.toml');
  const SAMPLE = `# my codex config
model = "gpt-5"   # keep me

[mcp_servers.other]
command = "other"  # stays
args = ["a"]

[mcp_servers.email]
command = "old"
args = ["x", "y"]

# next section
[profiles.fast]
model = "mini"
`;

  it('respects CODEX_HOME', () => {
    process.env.CODEX_HOME = path.join(home, 'elsewhere');
    expect(client('codex').location).toBe(path.join(home, 'elsewhere', 'config.toml'));
  });

  it('creates the file with the table when none exists', async () => {
    await client('codex').write(entry);
    expect(fs.readFileSync(file(), 'utf-8')).toBe(
      '[mcp_servers.email]\ncommand = "npx"\nargs = ["-y", "imap-wizard", "stdio"]\n',
    );
    expect((await client('codex').status()).state).toBe('registered');
  });

  it('appends to an existing file and keeps comments and other content', async () => {
    writeFile(file(), '# top comment\nmodel = "gpt-5" # inline\n');
    await client('codex').write(entry);
    const text = fs.readFileSync(file(), 'utf-8');
    expect(text.startsWith('# top comment\nmodel = "gpt-5" # inline\n')).toBe(true);
    expect(text).toContain('[mcp_servers.email]\ncommand = "npx"');
  });

  it('replaces only the email table and keeps all comments', async () => {
    writeFile(file(), SAMPLE);
    await client('codex').write(entry);
    const text = fs.readFileSync(file(), 'utf-8');
    expect(text).toBe(`# my codex config
model = "gpt-5"   # keep me

[mcp_servers.other]
command = "other"  # stays
args = ["a"]

[mcp_servers.email]
command = "npx"
args = ["-y", "imap-wizard", "stdio"]

# next section
[profiles.fast]
model = "mini"
`);
    expect(fs.existsSync(`${file()}.imap-wizard.bak`)).toBe(true);
  });

  it('removes only the email table and keeps comments', async () => {
    writeFile(file(), SAMPLE);
    await client('codex').remove();
    expect(fs.readFileSync(file(), 'utf-8')).toBe(`# my codex config
model = "gpt-5"   # keep me

[mcp_servers.other]
command = "other"  # stays
args = ["a"]

# next section
[profiles.fast]
model = "mini"
`);
    expect((await client('codex').status()).state).toBe('unregistered');
  });

  it('reads the launch command back in status', async () => {
    writeFile(file(), SAMPLE);
    expect((await client('codex').status()).command).toBe('old x y');
  });

  it('refuses to edit a file that is not valid TOML', () => {
    expect(() => setCodexEntry('this is = = broken', entry)).toThrow();
    expect(() => removeCodexEntry('this is = = broken')).toThrow();
  });

  it('refuses when the entry is defined in a form it cannot edit', () => {
    expect(() => setCodexEntry('mcp_servers = { email = { command = "a" } }\n', entry)).toThrow(
      /by hand/,
    );
  });
});

describe.skipIf(os.platform() === 'win32')('Claude Code', () => {
  function fakeClaude(exitFor: string): string {
    const log = path.join(home, 'claude-calls.log');
    const script = `#!/bin/sh
echo "$@" >> "${log}"
case "$1 $2" in
  "mcp get") exit ${exitFor === 'get-ok' ? 0 : 1} ;;
esac
exit 0
`;
    const bin = path.join(binDir, 'claude');
    fs.writeFileSync(bin, script, { mode: 0o755 });
    return log;
  }
  const calls = (log: string) => fs.readFileSync(log, 'utf-8').trim().split('\n');

  it('is detected only when a claude executable is on PATH', async () => {
    expect(await client('claude-code').detect()).toBe(false);
    expect((await client('claude-code').status()).state).toBe('missing');
    fakeClaude('get-ok');
    expect(await client('claude-code').detect()).toBe(true);
  });

  it('adds through the claude CLI at user scope and touches no files', async () => {
    const log = fakeClaude('get-no');
    await client('claude-code').write(entry);
    expect(calls(log)).toEqual([
      'mcp remove --scope user email',
      'mcp add --scope user email -- npx -y imap-wizard stdio',
    ]);
    expect(fs.existsSync(path.join(home, '.claude.json'))).toBe(false);
  });

  it('reports status from `claude mcp get email` exit code', async () => {
    fakeClaude('get-ok');
    expect((await client('claude-code').status()).state).toBe('registered');
    fakeClaude('get-no');
    expect((await client('claude-code').status()).state).toBe('unregistered');
  });

  it('removes through the claude CLI', async () => {
    const log = fakeClaude('get-ok');
    await client('claude-code').remove();
    expect(calls(log)).toEqual(['mcp remove --scope user email']);
  });

  it('fails loud when claude add exits non-zero', async () => {
    const log = path.join(home, 'l');
    fs.writeFileSync(
      path.join(binDir, 'claude'),
      `#!/bin/sh\necho "$@" >> "${log}"\n[ "$2" = add ] && exit 1\nexit 0\n`,
      {
        mode: 0o755,
      },
    );
    await expect(client('claude-code').write(entry)).rejects.toThrow(/mcp add failed/);
  });

  it('the fake claude really runs (sanity)', () => {
    fakeClaude('get-ok');
    expect(execFileSync(path.join(binDir, 'claude'), ['mcp', 'get', 'email']).length).toBe(0);
  });
});
