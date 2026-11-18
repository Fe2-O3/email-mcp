/**
 * Writing config.toml safely, and reading it without leaking it.
 * Everything here uses a temp folder; nothing touches the real config.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { appendAccountToConfig, loadConfig, loadRawConfig, saveConfig } from './loader.js';
import type { RawAccountConfig } from './schema.js';

const BASE = `# my comments stay
future_key = "from a newer version"

[[accounts]]
name = "one"
email = "one@example.com"
password = "pw-one"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

let dir: string;
let file: string;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'save-config-'));
  file = path.join(dir, 'config.toml');
  for (const key of Object.keys(process.env).filter((k) => k.startsWith('MCP_EMAIL_'))) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(async () => {
  Object.assign(process.env, savedEnv);
  vi.restoreAllMocks();
  await fs.rm(dir, { recursive: true, force: true });
});

const second: RawAccountConfig = {
  name: 'two',
  email: 'two@example.com',
  password: 'pw-two',
  imap: { host: 'imap.example.org', port: 993, tls: true, starttls: false, verify_ssl: true },
  smtp: {
    host: 'smtp.example.org',
    port: 465,
    tls: true,
    starttls: false,
    verify_ssl: true,
    pool: { enabled: true, max_connections: 1, max_messages: 100 },
  },
};

describe('saveConfig', () => {
  it('writes through a temp file, keeps the old file as .bak, and leaves no temp file', async () => {
    await fs.writeFile(file, BASE, { mode: 0o644 });
    const raw = await loadRawConfig(file);
    await saveConfig(raw, file);
    expect(await fs.readFile(`${file}.bak`, 'utf-8')).toBe(BASE);
    const names = await fs.readdir(dir);
    expect(names.sort()).toEqual(['config.toml', 'config.toml.bak']);
    expect((await fs.stat(file)).mode & 0o777).toBe(0o600);
    expect((await fs.stat(`${file}.bak`)).mode & 0o777).toBe(0o600);
  });

  it('a failed write leaves the existing file as it was', async () => {
    await fs.writeFile(file, BASE);
    const rename = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'));
    const raw = await loadRawConfig(file);
    await expect(saveConfig(raw, file)).rejects.toThrow('disk full');
    rename.mockRestore();
    expect(await fs.readFile(file, 'utf-8')).toBe(BASE);
    expect((await fs.readdir(dir)).filter((n) => n.includes('.tmp-'))).toEqual([]);
  });
});

describe('appendAccountToConfig', () => {
  it('adds the account and keeps comments and unknown keys as written', async () => {
    await fs.writeFile(file, BASE);
    await appendAccountToConfig(second, file);
    const text = await fs.readFile(file, 'utf-8');
    expect(text.startsWith(BASE.trimEnd())).toBe(true);
    expect(text).toContain('# my comments stay');
    expect(text).toContain('future_key = "from a newer version"');
    const raw = await loadRawConfig(file);
    expect(raw.accounts.map((a) => a.name)).toEqual(['one', 'two']);
  });

  it('refuses a result that fails the schema and leaves the file untouched', async () => {
    await fs.writeFile(file, BASE);
    const plain = {
      ...second,
      imap: { ...second.imap, host: 'imap.remote.example', tls: false, starttls: false },
    };
    await expect(appendAccountToConfig(plain, file)).rejects.toThrow();
    expect(await fs.readFile(file, 'utf-8')).toBe(BASE);
  });
});

describe('reading config.toml', () => {
  it('a syntax error shows line and column only, never the nearby text', async () => {
    await fs.writeFile(file, 'a = 1\npassword = "hunter2-SECRET"\nb = = 2\n');
    const err = await loadConfig(file).catch((e: unknown) => e as Error);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain('line 3, column 5');
    expect((err as Error).message).not.toContain('hunter2');
    expect((err as Error).message).not.toContain('SECRET');
  });

  it('warns once on stderr when the file is readable by others', async () => {
    await fs.writeFile(file, BASE, { mode: 0o644 });
    await fs.chmod(file, 0o644);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await loadConfig(file);
    const lines = err.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('chmod 600'));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('644');
  });

  it('stays quiet for an owner-only file', async () => {
    await fs.writeFile(file, BASE);
    await fs.chmod(file, 0o600);
    const err = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    await loadConfig(file);
    expect(err.mock.calls.filter((c) => String(c[0]).includes('chmod'))).toEqual([]);
  });
});
