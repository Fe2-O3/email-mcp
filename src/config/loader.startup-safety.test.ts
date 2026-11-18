/**
 * Start-up must not fail open: a password that cannot be read never turns
 * into a login with the wrong text, one broken account never stops the
 * others, and read_only cannot be lost to a typo, a "1", or environment
 * variables that skip config.toml.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import ConnectionManager from '../connections/manager.js';
import { imapClientOptions } from '../utils/imap-client.js';
import { loadConfig } from './loader.js';

const keychain = vi.hoisted(() => ({ available: false, items: new Map<string, string>() }));

vi.mock('../security/keychain.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../security/keychain.js')>();
  return {
    ...actual,
    keychainAvailable: async () => keychain.available,
    keychainGet: async (name: string) => keychain.items.get(name) ?? null,
  };
});

vi.mock('../logging.js', () => ({ mcpLog: vi.fn().mockResolvedValue(undefined) }));

function account(name: string, credential: string): string {
  return `
[[accounts]]
name = "${name}"
email = "${name}@example.invalid"
${credential}

[accounts.imap]
host = "imap.example.invalid"

[accounts.smtp]
host = "smtp.example.invalid"
`;
}

const ENV_ACCOUNT = {
  MCP_EMAIL_ADDRESS: 'env@example.invalid',
  MCP_EMAIL_PASSWORD: 'env-password',
  MCP_EMAIL_IMAP_HOST: 'imap.env.invalid',
  MCP_EMAIL_SMTP_HOST: 'smtp.env.invalid',
};

describe('loadConfig start-up safety', () => {
  let dir: string;
  let file: string;
  let stderr: ReturnType<typeof vi.spyOn>;
  const saved = { ...process.env };

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-wizard-startup-'));
    file = path.join(dir, 'config.toml');
    for (const key of Object.keys(process.env)) {
      if (key.startsWith('MCP_EMAIL_')) delete process.env[key];
    }
    keychain.available = false;
    keychain.items.clear();
    stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(async () => {
    stderr.mockRestore();
    process.env = { ...saved };
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function write(text: string): Promise<void> {
    await fs.writeFile(file, text, { mode: 0o600 });
  }

  function printed(): string {
    return stderr.mock.calls.map((call: unknown[]) => String(call[0])).join('\n');
  }

  describe('a Keychain password that cannot be read', () => {
    it('is never used as the password, when the Keychain is unavailable', async () => {
      await write(account('work', 'password = "use_keychain:work"'));

      const config = await loadConfig(file);

      expect(config.accounts[0].password).toBeUndefined();
      expect(config.accounts[0].credentialError).toMatch(/Keychain/);
    });

    it('is never used as the password, when the item is missing', async () => {
      keychain.available = true;
      await write(account('work', 'password = "use_keychain:work"'));

      const config = await loadConfig(file);

      expect(config.accounts[0].password).toBeUndefined();
      expect(config.accounts[0].credentialError).toMatch(/keychain migrate/);
    });

    it('stops every connection before a login is sent', async () => {
      await write(account('work', 'password = "use_keychain:work"'));
      const config = await loadConfig(file);
      const [work] = config.accounts;

      expect(() => imapClientOptions(work, { user: work.username, pass: work.password })).toThrow(
        /cannot log in/,
      );
      const manager = new ConnectionManager(config.accounts);
      await expect(manager.getImapClient('work')).rejects.toThrow(/cannot log in/);
      await expect(manager.getSmtpTransport('work')).rejects.toThrow(/cannot log in/);
    });

    it('still resolves an item that is there', async () => {
      keychain.available = true;
      keychain.items.set('work', 'from-the-keychain');
      await write(account('work', 'password = "use_keychain:work"'));

      const config = await loadConfig(file);

      expect(config.accounts[0].password).toBe('from-the-keychain');
      expect(config.accounts[0].credentialError).toBeUndefined();
    });
  });

  it('marks only the account whose password_command failed', async () => {
    await write(
      account('broken', 'password_command = "exit 3"') +
        account('fine', 'password_command = "echo from-the-command"'),
    );

    const config = await loadConfig(file);
    const [broken, fine] = config.accounts;

    expect(broken.credentialError).toMatch(/password_command/);
    expect(broken.password).toBeUndefined();
    expect(fine.password).toBe('from-the-command');
    expect(fine.credentialError).toBeUndefined();
    expect(printed()).toMatch(/"broken"/);
  });

  describe('read_only', () => {
    it('keeps the [settings] of config.toml when the account comes from the environment', async () => {
      Object.assign(process.env, ENV_ACCOUNT);
      await write(
        `[settings]\nread_only = true\ntoolset = "core"\n${account('file', 'password = "x"')}`,
      );

      const config = await loadConfig(file);

      expect(config.accounts.map((a) => a.email)).toEqual(['env@example.invalid']);
      expect(config.settings.readOnly).toBe(true);
      expect(config.settings.toolset).toBe('core');
      expect(printed()).toMatch(/environment.*config\.toml|config\.toml.*environment/);
    });

    it('stays on when either the environment or config.toml turns it on', async () => {
      Object.assign(process.env, ENV_ACCOUNT, { MCP_EMAIL_READ_ONLY: 'true' });
      await write('[settings]\nread_only = false\n');

      expect((await loadConfig(file)).settings.readOnly).toBe(true);
    });

    it.each(['1', 'TRUE', 'True', 'yes'])('reads MCP_EMAIL_READ_ONLY=%s as on', async (value) => {
      Object.assign(process.env, ENV_ACCOUNT, { MCP_EMAIL_READ_ONLY: value });

      expect((await loadConfig(path.join(dir, 'missing.toml'))).settings.readOnly).toBe(true);
    });

    it.each(['0', 'false', 'no', ''])('reads MCP_EMAIL_READ_ONLY=%j as off', async (value) => {
      Object.assign(process.env, ENV_ACCOUNT, { MCP_EMAIL_READ_ONLY: value });

      expect((await loadConfig(path.join(dir, 'missing.toml'))).settings.readOnly).toBe(false);
    });

    it('refuses a value it cannot read instead of guessing', async () => {
      Object.assign(process.env, ENV_ACCOUNT, { MCP_EMAIL_READ_ONLY: 'enabled' });

      await expect(loadConfig(path.join(dir, 'missing.toml'))).rejects.toThrow(
        /MCP_EMAIL_READ_ONLY/,
      );
    });

    it('warns at start about a misspelt key', async () => {
      await write(`[settings]\nread_onyl = true\n${account('work', 'password = "x"')}`);

      await loadConfig(file);

      expect(printed()).toMatch(/settings\.read_onyl/);
      expect(printed()).toMatch(/read_only/);
    });
  });
});
