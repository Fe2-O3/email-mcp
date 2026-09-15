/**
 * macOS Keychain wrapper for secure password storage.
 *
 * Uses the `security` CLI (built into macOS) to store/retrieve/delete
 * passwords. No native dependencies required.
 *
 * Passwords are stored under service "email-mcp" with the account name
 * as the account label.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

const SERVICE = 'email-mcp';
const KEYCHAIN_SENTINEL = 'use_keychain:';

// ---------------------------------------------------------------------------
// Core keychain operations
// ---------------------------------------------------------------------------

/**
 * Store a password in macOS Keychain.
 * Overwrites any existing entry for the same service + account.
 */
export async function keychainSet(accountName: string, password: string): Promise<void> {
  // Delete any existing entry first (add-generic-password fails if it exists)
  try {
    await execFileAsync('security', ['delete-generic-password', '-s', SERVICE, '-a', accountName]);
  } catch {
    // Entry may not exist — that is fine
  }

  // -U updates if item already exists.
  // -T adds the security CLI as trusted so reading doesn't pop a dialog.
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

/**
 * Retrieve a password from macOS Keychain.
 * Returns null if the entry does not exist.
 */
export async function keychainGet(accountName: string): Promise<string | null> {
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

/**
 * Delete a password from macOS Keychain.
 * Succeeds silently if the entry does not exist.
 */
export async function keychainDelete(accountName: string): Promise<void> {
  try {
    await execFileAsync('security', ['delete-generic-password', '-s', SERVICE, '-a', accountName]);
  } catch {
    // Entry may not exist — that is fine
  }
}

/**
 * Check if macOS Keychain is available on this system.
 */
export async function keychainAvailable(): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('security', ['help']);
    return stdout.includes('keychain') || stdout.includes('generic-password');
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Sentinel value helpers
// ---------------------------------------------------------------------------

/** Returns true if the password field is a keychain sentinel. */
export function isKeychainSentinel(password: string | undefined): boolean {
  return password?.startsWith(KEYCHAIN_SENTINEL) ?? false;
}

/** Extract the keychain account name from a sentinel value. */
export function keychainSentinelAccount(password: string): string {
  return password.slice(KEYCHAIN_SENTINEL.length);
}

/** Create a sentinel value for a keychain-stored account. */
export function makeKeychainSentinel(accountName: string): string {
  return KEYCHAIN_SENTINEL + accountName;
}

// ---------------------------------------------------------------------------
// Batch migration
// ---------------------------------------------------------------------------

/**
 * Migrate all plain-text passwords from a config to keychain.
 * Returns the updated config with sentinel values in place of passwords.
 */
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
