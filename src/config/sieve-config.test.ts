import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { parse as parseTOML } from 'smol-toml';

import { generateTemplate, loadConfig, readAllowedPrograms } from './loader.js';
import { AccountConfigSchema, AppConfigFileSchema } from './schema.js';
import { findUnknownKeys } from './validate.js';

const base = {
  name: 'a',
  email: 'a@example.com',
  password: 'x',
  imap: { host: 'imap.example.com' },
  smtp: { host: 'smtp.example.com' },
};

describe('account sieve block', () => {
  it('is optional (auto-detect)', () => {
    expect(AccountConfigSchema.parse(base).sieve).toBeUndefined();
  });

  it('defaults to enabled with STARTTLS', () => {
    expect(AccountConfigSchema.parse({ ...base, sieve: {} }).sieve).toEqual({
      enabled: true,
      tls: false,
      starttls: true,
    });
  });

  it('refuses an unencrypted login to a remote host', () => {
    const result = AccountConfigSchema.safeParse({
      ...base,
      sieve: { tls: false, starttls: false },
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/ManageSieve.*unencrypted/);
  });

  it('allows an unencrypted login only to a loopback host', () => {
    expect(
      AccountConfigSchema.safeParse({
        ...base,
        sieve: { host: '127.0.0.1', tls: false, starttls: false },
      }).success,
    ).toBe(true);
  });

  it('does not complain about a disabled block', () => {
    expect(
      AccountConfigSchema.safeParse({
        ...base,
        sieve: { enabled: false, tls: false, starttls: false },
      }).success,
    ).toBe(true);
  });
});

describe('global sieve.allowed_redirects', () => {
  it('defaults to an empty list', () => {
    expect(AppConfigFileSchema.parse({ accounts: [base] }).sieve).toEqual({
      allowed_redirects: [],
      allowed_programs: [],
    });
  });

  it('accepts addresses and domains', () => {
    const parsed = AppConfigFileSchema.parse({
      sieve: { allowed_redirects: ['me@example.org', 'example.net', '@example.com'] },
      accounts: [base],
    });
    expect(parsed.sieve.allowed_redirects).toHaveLength(3);
  });

  it('refuses wildcards and junk with the offending entry named', () => {
    const result = AppConfigFileSchema.safeParse({
      sieve: { allowed_redirects: ['*'] },
      accounts: [base],
    });
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.error?.issues)).toMatch(/wildcards/);
  });

  it('is a known key for config validate, and a typo is not', () => {
    expect(
      findUnknownKeys({
        sieve: { allowed_redirects: [] },
        accounts: [{ ...base, sieve: { host: 'h', port: 4190, tls: false, starttls: true } }],
      }),
    ).toEqual([]);
    expect(findUnknownKeys({ sieve: { allowed_redirect: [] }, accounts: [] })).toEqual([
      { path: 'sieve.allowed_redirect', suggestion: 'allowed_redirects' },
    ]);
  });
});

describe('loading sieve settings', () => {
  let tmpDir: string;
  const saved: Record<string, string | undefined> = {};
  const envKeys = [
    'MCP_EMAIL_ADDRESS',
    'MCP_EMAIL_PASSWORD',
    'MCP_EMAIL_IMAP_HOST',
    'MCP_EMAIL_SMTP_HOST',
    'MCP_EMAIL_SIEVE_ALLOWED_REDIRECTS',
    'MCP_EMAIL_SIEVE_ALLOWED_PROGRAMS',
    'MCP_EMAIL_SIEVE_ENABLED',
    'MCP_EMAIL_SIEVE_HOST',
    'MCP_EMAIL_SIEVE_PORT',
    'MCP_EMAIL_SIEVE_TLS',
    'MCP_EMAIL_SIEVE_STARTTLS',
  ];

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sieve-config-'));
    Object.keys(process.env)
      .filter((k) => k.startsWith('MCP_EMAIL_'))
      .concat(envKeys)
      .forEach((key) => {
        saved[key] = process.env[key];
        delete process.env[key];
      });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
    Object.entries(saved).forEach(([key, value]) => {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    });
  });

  it('reads the filter program allowlist from config.toml, fresh each time', async () => {
    const file = path.join(tmpDir, 'config.toml');
    const body = `
[[accounts]]
name = "a"
email = "a@example.com"
password = "x"
[accounts.imap]
host = "imap.example.com"
[accounts.smtp]
host = "smtp.example.com"
`;
    await fs.writeFile(file, `[sieve]\nallowed_programs = ["prog"]\n${body}`);
    expect((await loadConfig(file)).sieve?.allowedPrograms).toEqual(['prog']);
    expect(await readAllowedPrograms(file)).toEqual(['prog']);
    await fs.writeFile(file, body);
    expect(await readAllowedPrograms(file)).toEqual([]);
    expect(await readAllowedPrograms(path.join(tmpDir, 'missing.toml'))).toEqual([]);
  });

  it('normalizes the TOML blocks', async () => {
    const file = path.join(tmpDir, 'config.toml');
    await fs.writeFile(
      file,
      `[sieve]
allowed_redirects = ["me@example.org"]

[[accounts]]
name = "a"
email = "a@example.com"
password = "x"
[accounts.imap]
host = "imap.example.com"
[accounts.smtp]
host = "smtp.example.com"
[accounts.sieve]
host = "sieve.example.com"
port = 5190
tls = true
`,
    );
    const config = await loadConfig(file);
    expect(config.sieve).toEqual({ allowedRedirects: ['me@example.org'], allowedPrograms: [] });
    expect(config.accounts[0]?.sieve).toEqual({
      enabled: true,
      host: 'sieve.example.com',
      port: 5190,
      tls: true,
      starttls: true,
    });
  });

  it('reads the environment variables', async () => {
    process.env.MCP_EMAIL_ADDRESS = 'env@example.com';
    process.env.MCP_EMAIL_PASSWORD = 'pw';
    process.env.MCP_EMAIL_IMAP_HOST = 'imap.env.com';
    process.env.MCP_EMAIL_SMTP_HOST = 'smtp.env.com';

    const missing = path.join(tmpDir, 'none.toml');
    const plain = await loadConfig(missing);
    expect(plain.sieve).toEqual({ allowedRedirects: [], allowedPrograms: [] });
    expect(plain.accounts[0]?.sieve).toBeUndefined();

    process.env.MCP_EMAIL_SIEVE_ALLOWED_REDIRECTS = 'me@example.org, example.net';
    process.env.MCP_EMAIL_SIEVE_HOST = 'sieve.env.com';
    process.env.MCP_EMAIL_SIEVE_PORT = '4190';
    const configured = await loadConfig(missing);
    expect(configured.sieve?.allowedRedirects).toEqual(['me@example.org', 'example.net']);
    expect(configured.accounts[0]?.sieve).toEqual({
      enabled: true,
      host: 'sieve.env.com',
      port: 4190,
      tls: false,
      starttls: true,
    });
  });

  it('keeps the template parseable with every sieve line uncommented', () => {
    const uncommented = generateTemplate()
      .split('\n')
      .map((line) =>
        /^# (\[sieve\]|allowed_redirects|\[accounts\.sieve\]|enabled = true|host = "imap|port = 4190|tls = false {2}|starttls = true )/.test(
          line,
        )
          ? line.slice(2)
          : line,
      )
      .join('\n');
    const parsed = AppConfigFileSchema.parse(parseTOML(uncommented));
    expect(parsed.sieve.allowed_redirects).toEqual(['me@example.org', 'example.net']);
    expect(parsed.accounts[0]?.sieve).toMatchObject({ enabled: true, port: 4190 });
  });
});
