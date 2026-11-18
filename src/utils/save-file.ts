/**
 * Writing a file the model asked for, where the request may have been steered by
 * the content of an email (prompt injection). The rules keep the blast radius to
 * "a new file appeared": the path must be absolute (`~` allowed), an existing
 * directory or a trailing separator receives a generated name, and an existing
 * file is never replaced.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, sep } from 'node:path';

/** Reduce an untrusted name (from an email) to a safe single path segment. */
export function safeFileName(name: string, fallback: string): string {
  const base = [...basename(name.replace(/\\/g, '/'))]
    .map((ch) => (ch.charCodeAt(0) < 0x20 || '<>:"|?*'.includes(ch) ? '_' : ch))
    .join('')
    .trim();
  return base && base !== '.' && base !== '..' ? base : fallback;
}

export async function saveNewFile(
  savePath: string,
  generatedName: string,
  data: Buffer,
): Promise<string> {
  const expanded = savePath.startsWith('~')
    ? join(process.env.HOME ?? '', savePath.slice(1))
    : savePath;
  if (!isAbsolute(expanded)) {
    throw new Error('savePath must be an absolute path (or start with ~)');
  }
  const info = await stat(expanded).catch(() => undefined);
  const target =
    info?.isDirectory() || expanded.endsWith(sep) || expanded.endsWith('/')
      ? join(expanded, generatedName)
      : expanded;
  await mkdir(dirname(target), { recursive: true });
  try {
    // 'wx' fails instead of replacing a file that is already there.
    await writeFile(target, data, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Refusing to overwrite existing file: ${target}`);
    }
    throw err;
  }
  return target;
}
