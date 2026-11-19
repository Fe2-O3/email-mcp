/**
 * CLI commands that change config.toml or the Keychain must never destroy
 * what they were not asked to touch. Prompts are scripted; the config lives in
 * a temp folder (XDG_* is set before any module reads it).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'cli-safety-'));
  for (const key of ['CONFIG', 'DATA', 'STATE', 'CACHE']) {
    process.env[`XDG_${key}_HOME`] = nodePath.join(root, key.toLowerCase());
  }
  return { root, configFile: nodePath.join(root, 'config', 'email-mcp', 'config.toml') };
});

const answers: unknown[] = [];
const next = (): unknown => (answers.length > 0 ? answers.shift() : '');
const prompts = vi.hoisted(() => ({
  text: vi.fn(),
  password: vi.fn(),
  select: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  log: { error: vi.fn(), info: vi.fn(), warning: vi.fn(), success: vi.fn(), warn: vi.fn() },
}));

vi.mock('@clack/prompts', () => ({
  intro: vi.fn(),
  outro: vi.fn(),
  note: vi.fn(),
  isCancel: () => false,
  spinner: () => ({ start: vi.fn(), stop: vi.fn() }),
  text: prompts.text,
  password: prompts.password,
  select: prompts.select,
  confirm: prompts.confirm,
  cancel: prompts.cancel,
  log: prompts.log,
}));
vi.mock('./guard.js', () => ({ default: vi.fn() }));

// The real installer would read this machine's Claude/Cursor settings.
const runInstall = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('./install-commands.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./install-commands.js')>()),
  runInstall,
}));

const keychain = vi.hoisted(() => ({
  keychainAvailable: vi.fn(async () => true),
  keychainSet: vi.fn(async () => undefined),
  keychainGet: vi.fn(async () => 'real-secret' as string | null),
  keychainDelete: vi.fn(async () => undefined),
}));
vi.mock('../security/keychain.js', () => ({
  ...keychain,
  isKeychainSentinel: (p?: string) => typeof p === 'string' && p.startsWith('use_keychain:'),
  keychainSentinelAccount: (p: string) => p.slice('use_keychain:'.length),
  makeKeychainSentinel: (n: string) => `use_keychain:${n}`,
}));

const testImap = vi.hoisted(() => vi.fn(async () => ({ success: true, details: {} })));
vi.mock('../connections/manager.js', () => ({
  default: { testImap, testSmtp: vi.fn(async () => ({ success: true })) },
}));

import runAccountCommand from './account-commands.js';
import runKeychainCommand from './keychain-commands.js';

const RICH = `# keep this comment
[[accounts]]
name = "work"
email = "me@example.com"
password = "use_keychain:work"
max_attachment_mb = 40

[accounts.imap]
host = "imap.example.com"
verify_ssl = false

[accounts.smtp]
host = "smtp.example.com"

[accounts.sieve]
enabled = true
host = "imap.example.com"
port = 4190
tls = false
starttls = true
`;

beforeEach(async () => {
  vi.clearAllMocks();
  answers.length = 0;
  prompts.text.mockImplementation(async () => next());
  prompts.password.mockImplementation(async () => next());
  prompts.select.mockImplementation(async () => next());
  prompts.confirm.mockImplementation(async () => next());
  keychain.keychainAvailable.mockResolvedValue(true);
  keychain.keychainGet.mockResolvedValue('real-secret');
  await fs.rm(path.dirname(env.configFile), { recursive: true, force: true });
  await fs.mkdir(path.dirname(env.configFile), { recursive: true });
});

afterAll(async () => {
  await fs.rm(env.root, { recursive: true, force: true });
});

const MANUAL_ANSWERS = [
  'second',
  'second@example.org',
  '',
  'imap.example.org',
  '993',
  'tls',
  'smtp.example.org',
  '465',
  'tls',
  'second@example.org',
  'pw',
];

describe('account add', () => {
  it('stops on an unreadable config and leaves the file byte for byte unchanged', async () => {
    const broken = 'password = "hunter2-SECRET"\n[[accounts\nname = 1\n';
    await fs.writeFile(env.configFile, broken);
    await runAccountCommand('add');
    expect(await fs.readFile(env.configFile, 'utf-8')).toBe(broken);
    expect(prompts.text).not.toHaveBeenCalled();
    const shown = JSON.stringify(prompts.log.error.mock.calls);
    expect(shown).not.toContain('hunter2');
  });

  it('adds to a good config without losing a comment', async () => {
    await fs.writeFile(env.configFile, RICH);
    // name, email, full name, imap host/port, imap sec, smtp host/port, sec,
    // username, password, connect now (no)
    answers.push(...MANUAL_ANSWERS, false);
    keychain.keychainAvailable.mockResolvedValue(false);
    await runAccountCommand('add');
    const text = await fs.readFile(env.configFile, 'utf-8');
    expect(text).toContain('# keep this comment');
    expect(text).toContain('name = "second"');
    expect(text).toContain('max_attachment_mb = 40');
  });

  it('never asks about the SMTP pool and saves the safe defaults', async () => {
    await fs.writeFile(env.configFile, RICH);
    answers.push(...MANUAL_ANSWERS, false);
    keychain.keychainAvailable.mockResolvedValue(false);
    await runAccountCommand('add');
    const asked = JSON.stringify([
      ...prompts.text.mock.calls,
      ...prompts.confirm.mock.calls,
    ]).toLowerCase();
    expect(asked).not.toContain('pool');
    const text = await fs.readFile(env.configFile, 'utf-8');
    expect(text).toMatch(/max_connections = 1\b/);
    expect(text).toMatch(/max_messages = 100\b/);
  });

  it('offers to connect the AI app at the end and runs the installer on yes', async () => {
    await fs.writeFile(env.configFile, RICH);
    answers.push(...MANUAL_ANSWERS, true);
    keychain.keychainAvailable.mockResolvedValue(false);
    await runAccountCommand('add');
    expect(runInstall).toHaveBeenCalledTimes(1);
  });

  it('on no, skips the installer and shows the npx commands, not a bare imap-wizard', async () => {
    await fs.writeFile(env.configFile, RICH);
    answers.push(...MANUAL_ANSWERS, false);
    keychain.keychainAvailable.mockResolvedValue(false);
    await runAccountCommand('add');
    expect(runInstall).not.toHaveBeenCalled();
    const { note } = await import('@clack/prompts');
    const shown = JSON.stringify(vi.mocked(note).mock.calls);
    expect(shown).toContain('npx -y imap-wizard install');
    expect(shown).toContain('\\"command\\": \\"npx\\"');
  });

  it('"None" security to a remote host never tests the login in the clear', async () => {
    answers.push(
      'plain',
      'plain@example.org',
      '',
      'imap.example.org',
      '143',
      'none',
      'smtp.example.org',
      '465',
      'tls',
      'plain@example.org',
      'pw',
      false, // fix the server settings now? no
    );
    await runAccountCommand('add');
    expect(testImap).not.toHaveBeenCalled();
    await expect(fs.access(env.configFile)).rejects.toThrow();
  });

  it('a refused setting can be fixed on the spot, keeping the other answers', async () => {
    await fs.writeFile(env.configFile, RICH);
    answers.push(
      'fixme',
      'fixme@example.org',
      '',
      'imap.example.org',
      '143',
      'none', // refused: no encryption to a remote server
      'smtp.example.org',
      '465',
      'tls',
      'fixme@example.org',
      'pw',
      true, // fix the server settings now? yes
      'imap.example.org',
      '993',
      'tls',
      'smtp.example.org',
      '465',
      'tls',
      false, // connect the AI app now? no
    );
    keychain.keychainAvailable.mockResolvedValue(false);
    await runAccountCommand('add');
    expect(testImap).toHaveBeenCalledTimes(1);
    const text = await fs.readFile(env.configFile, 'utf-8');
    expect(text).toContain('name = "fixme"');
    expect(text).toMatch(/port = 993/);
  });
});

describe('account edit', () => {
  it('editing identity with the test declined never writes the placeholder to the Keychain and keeps other settings', async () => {
    await fs.writeFile(env.configFile, RICH);
    // field = identity; name, email, full name; test connections = no
    answers.push('identity', 'work', 'me@example.com', 'Me', false);
    await runAccountCommand('edit');
    expect(keychain.keychainSet).not.toHaveBeenCalled();
    const text = await fs.readFile(env.configFile, 'utf-8');
    expect(text).toContain('password = "use_keychain:work"');
    expect(text).toContain('max_attachment_mb = 40');
    expect(text).toContain('verify_ssl = false');
    expect(text).toContain('[accounts.sieve]');
    expect(text).toContain('port = 4190');
    expect(text).toContain('full_name = "Me"');
  });

  it('a rename copies the real secret to the new name, then removes the old item', async () => {
    await fs.writeFile(env.configFile, RICH);
    answers.push('identity', 'work2', 'me@example.com', '', false);
    await runAccountCommand('edit');
    expect(keychain.keychainSet).toHaveBeenCalledTimes(1);
    expect(keychain.keychainSet).toHaveBeenCalledWith('work2', 'real-secret');
    expect(keychain.keychainDelete).toHaveBeenCalledWith('work');
    expect(await fs.readFile(env.configFile, 'utf-8')).toContain('use_keychain:work2');
  });

  it('a rename whose Keychain item is missing keeps the old pointer and copies nothing', async () => {
    await fs.writeFile(env.configFile, RICH);
    keychain.keychainGet.mockResolvedValue(null);
    answers.push('identity', 'work2', 'me@example.com', '', false);
    await runAccountCommand('edit');
    expect(keychain.keychainSet).not.toHaveBeenCalled();
    expect(keychain.keychainDelete).not.toHaveBeenCalled();
    expect(await fs.readFile(env.configFile, 'utf-8')).toContain('use_keychain:work"');
  });
});

describe('keychain remove and migrate', () => {
  it('remove does nothing when the answer is No', async () => {
    await fs.writeFile(env.configFile, RICH);
    answers.push(false);
    await runKeychainCommand('remove', 'work');
    expect(keychain.keychainDelete).not.toHaveBeenCalled();
  });

  it('remove deletes when the answer is Yes', async () => {
    await fs.writeFile(env.configFile, RICH);
    answers.push(true);
    await runKeychainCommand('remove', 'work');
    expect(keychain.keychainDelete).toHaveBeenCalledWith('work');
  });

  it('migrate does nothing when the answer is No', async () => {
    await fs.writeFile(env.configFile, RICH.replace('use_keychain:work', 'plainpw'));
    const before = await fs.readFile(env.configFile, 'utf-8');
    answers.push(false);
    await runKeychainCommand('migrate');
    expect(keychain.keychainSet).not.toHaveBeenCalled();
    expect(await fs.readFile(env.configFile, 'utf-8')).toBe(before);
  });
});

describe('scheduler install and uninstall helpers', () => {
  it('uninstall removes only the scheduler line; quoted cron lines stay byte-identical', async () => {
    const { removeSchedulerCron } = await import('./scheduler.js');
    const keep = `0 9 * * * /bin/echo 'good morning' >> /tmp/x\n0 1 * * * echo 'a;b' \\n\n`;
    const crontab = `${keep}* * * * * /usr/bin/node /x/main.js scheduler check # email-mcp scheduler\n`;
    expect(removeSchedulerCron(crontab)).toBe(keep);
  });

  it('uninstall hands the crontab to crontab on stdin, not through a shell echo', async () => {
    vi.resetModules();
    const execFileSync = vi.fn();
    const execSync = vi.fn(
      (_cmd: string) => `0 9 * * * echo 'hi'\n* * * * * x # email-mcp scheduler\n`,
    );
    vi.doMock('node:child_process', async (importOriginal) => ({
      ...(await importOriginal<typeof import('node:child_process')>()),
      execFileSync,
      execSync,
    }));
    vi.spyOn(os, 'platform').mockReturnValue('linux');
    const { default: run } = await import('./scheduler.js');
    await run('uninstall');
    expect(execFileSync).toHaveBeenCalledWith('crontab', ['-'], {
      input: `0 9 * * * echo 'hi'\n`,
      stdio: 'pipe',
    });
    expect(execSync.mock.calls.some((c) => String(c[0]).includes('| crontab'))).toBe(false);
    vi.doUnmock('node:child_process');
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('quotes paths for cron and escapes them for the launchd plist', async () => {
    const { shellQuote, xmlEscape } = await import('./scheduler.js');
    expect(shellQuote("/Users/a b/it's/main.js")).toBe(`'/Users/a b/it'\\''s/main.js'`);
    expect(xmlEscape('/a&b/<c>')).toBe('/a&amp;b/&lt;c&gt;');
  });
});
