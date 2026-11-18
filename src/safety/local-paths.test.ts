import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { xdg } from '../config/xdg.js';
import { assertSafeReadPath, assertSafeWritePath } from './local-paths.js';

describe('assertSafeWritePath', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'local-paths-'));
    await mkdir(path.join(home, 'Downloads'));
    await mkdir(path.join(home, 'Documents'));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const check = (p: string, extra = {}) => assertSafeWritePath(p, { home, ...extra });

  it('allows ordinary user folders, including ones that do not exist yet', async () => {
    await expect(check(path.join(home, 'Downloads', 'a.pdf'))).resolves.toBeUndefined();
    await expect(
      check(path.join(home, 'Documents', 'new', 'deep', 'a.pdf')),
    ).resolves.toBeUndefined();
  });

  it.each([
    '/etc/cron.d/x',
    '/usr/local/bin/x',
    '/System/x',
    '/Library/LaunchAgents/x.plist',
    '/private/etc/hosts',
  ])('refuses system location %s', async (p) => {
    await expect(check(p)).rejects.toThrow(/protected location/);
  });

  it.each(['/x.txt', '/tmp/x.txt', '/private/tmp/x.txt', '/Users/x.txt', '/var/x.txt'])(
    'refuses a file directly in a shared top-level directory: %s',
    async (p) => {
      await expect(check(p)).rejects.toThrow(/shared top-level/);
    },
  );

  it('refuses the home root itself', async () => {
    await expect(check(path.join(home, 'notes.txt'))).rejects.toThrow(/home directory root/);
  });

  it.each([
    '.ssh/authorized_keys',
    '.config/x',
    '.aws/credentials',
    '.zshrc/x',
    'Documents/.hidden/x',
  ])('refuses dot-directories: %s', async (rel) => {
    await expect(check(path.join(home, rel))).rejects.toThrow(/hidden directory/);
  });

  it('does not mind a dot-name on the file itself', async () => {
    await expect(check(path.join(home, 'Downloads', '.._x.ini'))).resolves.toBeUndefined();
  });

  it('refuses ~/Library but allows iCloud Drive', async () => {
    await expect(check(path.join(home, 'Library', 'LaunchAgents', 'x.plist'))).rejects.toThrow(
      /application data/,
    );
    await expect(
      check(path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'x.pdf')),
    ).resolves.toBeUndefined();
  });

  it("refuses this app's own config and data directories", async () => {
    await expect(check(path.join(xdg.config, 'config.toml'))).rejects.toThrow(/protected location/);
    await expect(check(path.join(xdg.data, 'x', 'y.bin'))).rejects.toThrow(/protected location/);
  });

  it('refuses a symlink that leads into a protected directory', async () => {
    await mkdir(path.join(home, '.ssh'));
    await symlink(path.join(home, '.ssh'), path.join(home, 'Downloads', 'link'));
    await expect(check(path.join(home, 'Downloads', 'link', 'authorized_keys'))).rejects.toThrow(
      /hidden directory/,
    );
  });

  it('refuses a symlink that leads to the home root', async () => {
    await symlink(home, path.join(home, 'Downloads', 'up'));
    await expect(check(path.join(home, 'Downloads', 'up', 'x.txt'))).rejects.toThrow(
      /home directory root/,
    );
  });

  it('refuses a dangling symlink and a symlinked file that leaves the destination', async () => {
    await symlink(path.join(home, 'Documents', 'gone'), path.join(home, 'Downloads', 'dangling'));
    await expect(check(path.join(home, 'Downloads', 'dangling'))).rejects.toThrow(/dangling/);

    await writeFile(path.join(home, 'Documents', 'target.txt'), 'x');
    await symlink(
      path.join(home, 'Documents', 'target.txt'),
      path.join(home, 'Downloads', 'f.txt'),
    );
    await expect(
      check(path.join(home, 'Downloads', 'f.txt'), { within: path.join(home, 'Downloads') }),
    ).rejects.toThrow(/leaves the destination/);
  });

  it('lets an allowed root hold its files, but not through a symlink out of it', async () => {
    const allowed = path.join(home, '.local', 'share', 'attachments');
    await mkdir(allowed, { recursive: true });
    await expect(
      check(path.join(allowed, 'a', 'x.pdf'), { allowRoots: [allowed] }),
    ).resolves.toBeUndefined();
    await symlink(path.join(home, 'Documents'), path.join(allowed, 'out'));
    await expect(
      check(path.join(allowed, 'out', 'x.pdf'), { allowRoots: [allowed] }),
    ).rejects.toThrow(/leaves the allowed directory/);
  });
});

describe('assertSafeReadPath', () => {
  let home: string;

  beforeEach(async () => {
    home = await mkdtemp(path.join(tmpdir(), 'local-paths-read-'));
    await mkdir(path.join(home, 'Documents'));
    await mkdir(path.join(home, '.ssh'));
    await writeFile(path.join(home, 'Documents', 'report.pdf'), 'pdf');
    await writeFile(path.join(home, '.ssh', 'id_rsa'), 'SECRET');
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const check = (p: string, extra = {}) => assertSafeReadPath(p, { home, ...extra });

  it('allows an ordinary file and returns its real path', async () => {
    const real = await check(path.join(home, 'Documents', 'report.pdf'));
    expect(real.endsWith(path.join('Documents', 'report.pdf'))).toBe(true);
  });

  it('allows a file outside the home folder, such as one in the temp folder', async () => {
    await expect(check(path.join(tmpdir(), '..', path.basename(tmpdir())))).rejects.toThrow(
      /regular file/,
    );
    const f = path.join(await mkdtemp(path.join(tmpdir(), 'plain-')), 'a.txt');
    await writeFile(f, 'x');
    await expect(check(f)).resolves.toBeTruthy();
  });

  it.each(['relative/file.txt', '~/Documents/report.pdf', 'file:///etc/passwd', '', 'a.txt'])(
    'refuses a path that is not absolute: %j',
    async (p) => {
      await expect(check(p)).rejects.toThrow(/absolute|empty/);
    },
  );

  it('refuses a path with a NUL character', async () => {
    await expect(check(`${home}/Documents/a\0b`)).rejects.toThrow(/NUL/);
  });

  it.each([
    '/etc/passwd',
    '/private/etc/hosts',
    '/System/Library/x',
    '/usr/bin/env',
    '/proc/self/environ',
  ])('refuses system location %s', async (p) => {
    await expect(check(p)).rejects.toThrow(/protected location|not found/);
  });

  it('refuses /etc/hosts specifically with the system-directory reason', async () => {
    await expect(check('/etc/hosts')).rejects.toThrow(/system directory/);
  });

  it.each(['.ssh/id_rsa', '.aws/credentials', '.gnupg/key', '.config/x', '.cache/x', '.env'])(
    'refuses hidden file or directory %s',
    async (rel) => {
      const full = path.join(home, rel);
      await mkdir(path.dirname(full), { recursive: true });
      await writeFile(full, 'x');
      await expect(check(full)).rejects.toThrow(/hidden file or directory/);
    },
  );

  it('refuses a hidden file in an ordinary folder', async () => {
    await writeFile(path.join(home, 'Documents', '.netrc'), 'x');
    await expect(check(path.join(home, 'Documents', '.netrc'))).rejects.toThrow(/hidden/);
  });

  it('refuses ~/Library, keychains included, but allows iCloud Drive', async () => {
    const keychain = path.join(home, 'Library', 'Keychains', 'login.keychain-db');
    await mkdir(path.dirname(keychain), { recursive: true });
    await writeFile(keychain, 'x');
    await expect(check(keychain)).rejects.toThrow(/application data/);
    const icloud = path.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'x.pdf');
    await mkdir(path.dirname(icloud), { recursive: true });
    await writeFile(icloud, 'x');
    await expect(check(icloud)).resolves.toBeTruthy();
  });

  it("refuses this app's own config, data, state and cache directories", async () => {
    const dirs = await Promise.all(
      ['config', 'data', 'state', 'cache'].map(async (n) => {
        const d = path.join(home, 'app', n);
        await mkdir(d, { recursive: true });
        await writeFile(path.join(d, 'config.toml'), 'password = "x"');
        return d;
      }),
    );
    for (const d of dirs) {
      await expect(check(path.join(d, 'config.toml'), { extraDeniedRoots: dirs })).rejects.toThrow(
        /application config or data/,
      );
    }
    // And the real ones, wherever XDG puts them.
    await expect(check(path.join(xdg.config, 'config.toml'))).rejects.toThrow(
      /protected location|not found/,
    );
  });

  it('refuses a symlink in an ordinary folder that leads into ~/.ssh', async () => {
    const link = path.join(home, 'Documents', 'innocent.txt');
    await symlink(path.join(home, '.ssh', 'id_rsa'), link);
    await expect(check(link)).rejects.toThrow(/hidden file or directory/);
  });

  it('refuses a symlinked folder that leads into ~/.ssh', async () => {
    await symlink(path.join(home, '.ssh'), path.join(home, 'Documents', 'keys'));
    await expect(check(path.join(home, 'Documents', 'keys', 'id_rsa'))).rejects.toThrow(/hidden/);
  });

  it('refuses a symlink that leads to a system file', async () => {
    const link = path.join(home, 'Documents', 'hosts');
    await symlink('/etc/hosts', link);
    await expect(check(link)).rejects.toThrow(/system directory/);
  });

  it('refuses a directory and a missing file', async () => {
    await expect(check(path.join(home, 'Documents'))).rejects.toThrow(/regular file/);
    await expect(check(path.join(home, 'Documents', 'nope.pdf'))).rejects.toThrow(/not found/);
  });
});
