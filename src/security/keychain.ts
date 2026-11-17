/**
 * Cross-platform secure password storage.
 *
 * macOS: uses the `security` CLI (built into macOS) to store/retrieve/delete
 * passwords in the login Keychain. No native dependencies required.
 *
 * Linux: uses `secret-tool` (libsecret / GNOME Keyring) to store/retrieve/
 * delete passwords. Install with your package manager, e.g.
 * `apt install libsecret-tools` or `dnf install libsecret`.
 *
 * Passwords are stored under service "email-mcp" with the account name
 * as the account label.
 *
 * On unsupported platforms all operations report "not available" and the
 * caller falls back to plain-text config or `password_command`.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// Stays 'email-mcp' on purpose (also the secret-tool label): renaming would
// hide existing users' stored passwords. The public command is 'imap-wizard'.
const SERVICE = 'email-mcp';
const KEYCHAIN_SENTINEL = 'use_keychain:';

// ---------------------------------------------------------------------------
// Platform detection
// ---------------------------------------------------------------------------

function isMacOS(): boolean {
  return process.platform === 'darwin';
}

function isLinux(): boolean {
  return process.platform === 'linux';
}

// ---------------------------------------------------------------------------
// Tool availability
// ---------------------------------------------------------------------------

async function commandExists(cmd: string): Promise<boolean> {
  try {
    await execFileAsync('which', [cmd]);
    return true;
  } catch {
    return false;
  }
}

async function macKeychainAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('security', ['help']);
    return stdout.includes('keychain') || stdout.includes('generic-password');
  } catch {
    return false;
  }
}

async function linuxSecretToolAvailable(): Promise<boolean> {
  return commandExists('secret-tool');
}

export async function keychainAvailable(): Promise<boolean> {
  if (isMacOS()) return macKeychainAvailable();
  if (isLinux()) return linuxSecretToolAvailable();
  return false;
}

// ---------------------------------------------------------------------------
// Core operations — macOS (security CLI)
// ---------------------------------------------------------------------------

async function macSet(accountName: string, password: string): Promise<void> {
  try {
    await execFileAsync('security', ['delete-generic-password', '-s', SERVICE, '-a', accountName]);
  } catch {
    // Entry may not exist
  }
  await execFileAsync('security', [
    'add-generic-password',
    '-s',
    SERVICE,
    '-a',
    accountName,
    '-w',
    password,
    '-U',
    '-T',
    '/usr/bin/security',
  ]);
}

async function macGet(accountName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-generic-password',
      '-s',
      SERVICE,
      '-a',
      accountName,
      '-w',
    ]);
    return stdout.trim();
  } catch {
    return null;
  }
}

async function macDelete(accountName: string): Promise<void> {
  try {
    await execFileAsync('security', ['delete-generic-password', '-s', SERVICE, '-a', accountName]);
  } catch {
    // Entry may not exist
  }
}

// ---------------------------------------------------------------------------
// Core operations — Linux (secret-tool / libsecret)
// ---------------------------------------------------------------------------

async function linuxSet(accountName: string, password: string): Promise<void> {
  // secret-tool reads the secret from stdin.
  const { spawn } = await import('node:child_process');
  await new Promise<void>((resolve, reject) => {
    const proc = spawn(
      'secret-tool',
      ['store', '--label=email-mcp', 'service', SERVICE, 'account', accountName],
      {
        stdio: ['pipe', 'ignore', 'pipe'],
      },
    );
    let stderr = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`secret-tool store failed (exit ${code}): ${stderr}`));
    });
    proc.stdin?.write(password);
    proc.stdin?.end();
  });
}

async function linuxGet(accountName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('secret-tool', [
      'lookup',
      'service',
      SERVICE,
      'account',
      accountName,
    ]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

async function linuxDelete(accountName: string): Promise<void> {
  try {
    await execFileAsync('secret-tool', ['clear', 'service', SERVICE, 'account', accountName]);
  } catch {
    // Entry may not exist
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function keychainSet(accountName: string, password: string): Promise<void> {
  if (isMacOS()) return macSet(accountName, password);
  if (isLinux()) return linuxSet(accountName, password);
  throw new Error('Keychain is not available on this platform.');
}

export async function keychainGet(accountName: string): Promise<string | null> {
  if (isMacOS()) return macGet(accountName);
  if (isLinux()) return linuxGet(accountName);
  return null;
}

export async function keychainDelete(accountName: string): Promise<void> {
  if (isMacOS()) return macDelete(accountName);
  if (isLinux()) return linuxDelete(accountName);
}

// ---------------------------------------------------------------------------
// Sentinel value helpers
// ---------------------------------------------------------------------------

export function isKeychainSentinel(password: string | undefined): boolean {
  return password?.startsWith(KEYCHAIN_SENTINEL) ?? false;
}

export function keychainSentinelAccount(password: string): string {
  return password.slice(KEYCHAIN_SENTINEL.length);
}

export function makeKeychainSentinel(accountName: string): string {
  return KEYCHAIN_SENTINEL + accountName;
}

// ---------------------------------------------------------------------------
// Batch migration
// ---------------------------------------------------------------------------

export async function migratePasswordsToKeychain(
  accounts: Array<{ name: string; password?: string }>,
): Promise<{ migrated: string[]; skipped: string[] }> {
  const migrated: string[] = [];
  const skipped: string[] = [];

  for (const account of accounts) {
    if (!account.password || isKeychainSentinel(account.password)) {
      skipped.push(account.name);
      continue;
    }

    try {
      await keychainSet(account.name, account.password);
      account.password = makeKeychainSentinel(account.name);
      migrated.push(account.name);
    } catch (err) {
      console.error(`Failed to migrate "${account.name}" to keychain: ${err}`);
      skipped.push(account.name);
    }
  }

  return { migrated, skipped };
}
