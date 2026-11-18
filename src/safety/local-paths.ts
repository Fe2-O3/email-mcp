// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * Where this server may write a file whose path a model chose, possibly after being steered by
 * the text of an email. The write is refused in places that would let a new file change how the
 * machine behaves: system directories, the root of a shared directory (/tmp, /Users, ...), the
 * home directory itself, dot-directories (~/.ssh, ~/.config, ~/.aws, ...), application-data
 * trees (~/Library) and this app's own config/data/state/cache directories.
 *
 * Symlinks are resolved first: a path that looks like ~/Downloads/x but leads into one of those
 * places is judged by where it really ends up.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { xdg } from '../config/xdg.js';

/** `/` and shared top-level directories. A file placed directly in one would sit among other users' files. */
const BROAD_ROOT_NAMES = [
  'Users',
  'home',
  'private',
  'var',
  'tmp',
  'opt',
  'usr',
  'etc',
  'proc',
  'sys',
  'dev',
  'boot',
  'root',
  'Volumes',
  'mnt',
  'media',
];

/** Nothing below these may be written. */
const SYSTEM_PREFIXES = [
  '/etc',
  '/private/etc',
  '/proc',
  '/sys',
  '/dev',
  '/boot',
  '/usr',
  '/bin',
  '/sbin',
  '/lib',
  '/lib64',
  '/System',
  '/Library',
  '/Applications',
];

const APP_DATA_TREES = new Set(['Library', 'AppData', 'snap']);

export interface LocalPathOptions {
  /** The user's home directory. Defaults to `os.homedir()`. */
  home?: string;
  /** Directories this call may write under even though they are hidden or app-owned (still never system paths). */
  allowRoots?: readonly string[];
  /** The file must really (after symlinks) end up inside this directory. */
  within?: string;
  /** Directories that are off limits in addition to the app's own. */
  extraDeniedRoots?: readonly string[];
}

const fold = (p: string): string => (process.platform === 'linux' ? p : p.toLowerCase());

function isInside(candidate: string, root: string, allowRoot = true): boolean {
  const rel = path.relative(fold(root), fold(candidate));
  if (rel === '') return allowRoot;
  return rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}

/**
 * Resolve symlinks in the part of `target` that exists and append the part that does not.
 * A dangling symlink is refused because writing through it creates a file somewhere unseen.
 */
async function resolveThroughSymlinks(target: string): Promise<string> {
  try {
    return await fs.realpath(target);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const link = await fs.lstat(target).catch(() => undefined);
  if (link) throw new Error(`Refusing to write through a dangling symlink: ${target}`);
  const parent = path.dirname(target);
  if (parent === target) return target;
  return path.join(await resolveThroughSymlinks(parent), path.basename(target));
}

async function realOrSelf(p: string): Promise<string> {
  try {
    return await fs.realpath(p);
  } catch {
    return p;
  }
}

async function broadRoots(): Promise<Set<string>> {
  const root = path.parse(path.resolve('/')).root;
  const names = [root, ...BROAD_ROOT_NAMES.map((n) => path.resolve(root, n))];
  const all = new Set<string>();
  await Promise.all(
    names.map(async (n) => {
      all.add(fold(n));
      all.add(fold(await realOrSelf(n)));
    }),
  );
  return all;
}

function hasHiddenSegment(p: string): boolean {
  return p.split(/[/\\]/).some((part) => part.startsWith('.') && part !== '.' && part !== '..');
}

function inAppDataTree(p: string, home: string): boolean {
  const rel = path.relative(fold(home), fold(p));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return false;
  const [top, second] = rel.split(path.sep);
  if (!top || ![...APP_DATA_TREES].some((t) => t.toLowerCase() === top)) return false;
  // iCloud Drive and cloud-provider folders live under ~/Library but are user document space.
  return !(top === 'library' && (second === 'mobile documents' || second === 'cloudstorage'));
}

/**
 * Throw unless a new file may be written at `target`.
 * Call it with the final path (after any generated file name is joined on).
 */
export async function assertSafeWritePath(
  target: string,
  options: LocalPathOptions = {},
): Promise<void> {
  const home = path.resolve(options.home ?? os.homedir());
  const lexical = path.resolve(target);
  const real = await resolveThroughSymlinks(lexical);
  const realHome = await realOrSelf(home);
  const allow = await Promise.all(
    (options.allowRoots ?? []).map(async (r) => ({
      lexical: path.resolve(r),
      real: await realOrSelf(path.resolve(r)),
    })),
  );
  const broad = await broadRoots();

  const fail = (reason: string): never => {
    throw new Error(`Refusing to write to a protected location (${reason}): ${target}`);
  };

  for (const candidate of lexical === real ? [real] : [lexical, real]) {
    if (SYSTEM_PREFIXES.some((p) => isInside(candidate, p))) fail('system directory');
    // A file directly inside "/", "/tmp", "/Users", ... or the target being one of them.
    if (broad.has(fold(candidate)) || broad.has(fold(path.dirname(candidate)))) {
      fail('shared top-level directory');
    }
    if (isInside(candidate, home) || isInside(candidate, realHome)) {
      const parent = path.dirname(candidate);
      if (fold(parent) === fold(home) || fold(parent) === fold(realHome) || candidate === home) {
        fail('home directory root');
      }
    }
  }

  if (options.within && !isInside(real, await realOrSelf(path.resolve(options.within)))) {
    fail('symlink leaves the destination directory');
  }

  // A symlink may not carry an allowed directory's files somewhere else.
  const allowed = allow.find((a) => isInside(lexical, a.lexical));
  if (allowed) {
    if (!isInside(real, allowed.real)) fail('symlink leaves the allowed directory');
    return;
  }

  const denied = [
    xdg.config,
    xdg.data,
    xdg.state,
    xdg.cache,
    ...(options.extraDeniedRoots ?? []),
  ].map((d) => path.resolve(d));
  const deniedReal = await Promise.all(denied.map(realOrSelf));

  for (const candidate of lexical === real ? [real] : [lexical, real]) {
    if (
      denied.some((d) => isInside(candidate, d)) ||
      deniedReal.some((d) => isInside(candidate, d))
    ) {
      fail('application config or data directory');
    }
    // Only directories count: a file called ".._x" in ~/Downloads is just a name.
    if (hasHiddenSegment(path.dirname(candidate))) fail('hidden directory');
    if (inAppDataTree(candidate, home) || inAppDataTree(candidate, realHome)) {
      fail('application data directory');
    }
  }
}
