/**
 * config.toml holds plaintext IMAP and SMTP passwords and OAuth refresh
 * tokens. Written under a default umask it lands at 0644, readable by every
 * account on the machine — including any other service, and anything that
 * later ends up in a backup or a container image layer.
 *
 * The assertion is on the actual mode bits after a real write, because this is
 * a property of the file on disk. A test that only checked the options object
 * passed to writeFile would pass while the file stayed world-readable, which
 * is exactly what happened here: `mode` on writeFile applies only when the
 * file is created, so an existing 0644 config kept its permissions.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { saveConfig, warnOnLooseConfigPermissions } from './loader.js';

const isWindows = process.platform === 'win32';

let dir: string;
let configPath: string;

const config = {
  accounts: [
    {
      name: 'test',
      email: 'user@example.invalid',
      password: 'not-a-real-password',
      imap: { host: 'imap.example.invalid' },
      smtp: { host: 'smtp.example.invalid' },
    },
  ],
};

async function modeOf(file: string): Promise<number> {
  const stats = await fs.stat(file);
  // eslint-disable-next-line no-bitwise
  return stats.mode & 0o777;
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imap-wizard-perm-'));
  configPath = path.join(dir, 'nested', 'config.toml');
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe.skipIf(isWindows)('config file permissions', () => {
  it('writes a new config readable only by its owner', async () => {
    await saveConfig(config as never, configPath);

    expect(await modeOf(configPath)).toBe(0o600);
  });

  it('creates the containing directory as 0700', async () => {
    await saveConfig(config as never, configPath);

    expect(await modeOf(path.dirname(configPath))).toBe(0o700);
  });

  it('tightens an existing world-readable config rather than leaving it', async () => {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, 'stale = true\n', { mode: 0o644 });
    expect(await modeOf(configPath)).toBe(0o644);

    await saveConfig(config as never, configPath);

    // writeFile's `mode` is ignored for an existing file, so without the
    // explicit chmod this stays 0644 and the whole fix is cosmetic.
    expect(await modeOf(configPath)).toBe(0o600);
  });

  it('warns about a loose config it did not write, naming the fix', async () => {
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    await fs.writeFile(configPath, 'stale = true\n', { mode: 0o644 });

    const warning = await warnOnLooseConfigPermissions(configPath);

    expect(warning).toContain('644');
    expect(warning).toContain('chmod 600');
  });

  it('stays quiet about a correctly restricted config', async () => {
    await saveConfig(config as never, configPath);

    expect(await warnOnLooseConfigPermissions(configPath)).toBeNull();
  });

  it('stays quiet when there is no config at all', async () => {
    expect(await warnOnLooseConfigPermissions(path.join(dir, 'absent.toml'))).toBeNull();
  });
});
