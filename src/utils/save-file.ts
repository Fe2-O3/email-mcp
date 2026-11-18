/**
 * Writing a file the model asked for, where the request may have been steered by
 * the content of an email (prompt injection). The rules keep the blast radius to
 * "a new file appeared": the path must be absolute (`~` allowed), an existing
 * directory or a trailing separator receives a generated name, and an existing
 * file is never replaced. See `assertSafeWritePath` for the places that are off limits.
 */

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, sep } from 'node:path';

import { assertSafeWritePath } from '../safety/local-paths.js';

/** Reduce an untrusted name (from an email) to a safe single path segment. */
export function safeFileName(name: string, fallback: string): string {
  const base = [...basename(name.replace(/\\/g, '/'))]
    .map((ch) => (ch.charCodeAt(0) < 0x20 || '<>:"|?*'.includes(ch) ? '_' : ch))
    .join('')
    .trim();
  return base && base !== '.' && base !== '..' ? base : fallback;
}

/** File types that run, or change how a program behaves, when opened or used. */
const RUN_ON_OPEN_EXTENSIONS = new Set(['.command', '.terminal', '.app', '.scpt', '.sh', '.plist']);

/**
 * Why a file name may not be written, or undefined when it is fine. A dot-name
 * (.npmrc, .pre-commit-config.yaml, .envrc) changes how tools behave in the
 * folder it lands in, and the types above run when opened. A mail's sender
 * chooses the bytes, so neither is written.
 */
export function refusedFileName(target: string): string | undefined {
  const name = basename(target);
  if (name.startsWith('.')) {
    return `Refusing to save "${name}": file names that start with a dot change how programs behave and are not written. Choose a name without the leading dot.`;
  }
  const ext = extname(name).toLowerCase();
  if (RUN_ON_OPEN_EXTENSIONS.has(ext)) {
    return `Refusing to save "${name}": ${ext} files run when opened and are not written. Choose a different file type.`;
  }
  return undefined;
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
  const refused = refusedFileName(target);
  if (refused) throw new Error(refused);
  // Judge the final path before anything is created, so a refusal leaves no directories behind.
  await assertSafeWritePath(target);
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
