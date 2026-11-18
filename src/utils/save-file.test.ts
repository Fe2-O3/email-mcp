/**
 * A save path can be chosen by a model that was steered by an email. Saving must
 * never replace an existing file, must refuse relative paths, and must not let an
 * attachment's name climb out of the chosen directory.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { safeFileName, saveNewFile } from './save-file.js';

describe('saveNewFile', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'save-file-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('writes a new file at an absolute path', async () => {
    const target = await saveNewFile(join(dir, 'a.txt'), 'x.bin', Buffer.from('hi'));
    expect(target).toBe(join(dir, 'a.txt'));
    expect(await readFile(target, 'utf-8')).toBe('hi');
  });

  it('refuses to overwrite an existing file and leaves it intact', async () => {
    const existing = join(dir, 'zshrc');
    await writeFile(existing, 'original');
    await expect(saveNewFile(existing, 'x.bin', Buffer.from('evil'))).rejects.toThrow(
      /Refusing to overwrite/,
    );
    expect(await readFile(existing, 'utf-8')).toBe('original');
  });

  it('refuses a relative path', async () => {
    await expect(saveNewFile('report.pdf', 'x.bin', Buffer.from('x'))).rejects.toThrow(/absolute/);
  });

  it('puts the generated name inside an existing directory', async () => {
    const target = await saveNewFile(dir, 'report.pdf', Buffer.from('x'));
    expect(target).toBe(join(dir, 'report.pdf'));
  });
});

describe('safeFileName', () => {
  it.each([
    ['../../.zshrc', '.zshrc'],
    ['/etc/passwd', 'passwd'],
    ['..\\..\\evil.exe', 'evil.exe'],
    ['report.pdf', 'report.pdf'],
  ])('reduces %s to %s', (input, expected) => {
    expect(safeFileName(input, 'fallback.bin')).toBe(expected);
  });

  it.each(['', '..', '.', '/'])('falls back for %j', (input) => {
    expect(safeFileName(input, 'fallback.bin')).toBe('fallback.bin');
  });
});

describe('saveNewFile path guard', () => {
  it('refuses a protected location before creating anything', async () => {
    await expect(
      saveNewFile('/etc/imap-wizard-test/x.bin', 'x.bin', Buffer.from('x')),
    ).rejects.toThrow(/protected location/);
    await expect(saveNewFile('~/.ssh/authorized_keys', 'x.bin', Buffer.from('x'))).rejects.toThrow(
      /protected location/,
    );
  });
});
