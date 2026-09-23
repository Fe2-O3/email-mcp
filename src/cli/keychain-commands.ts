/**
 * Keychain management subcommands.
 *
 * - keychain migrate    — move all plain-text passwords to macOS Keychain
 * - keychain status     — show which accounts use keychain vs plain text
 * - keychain remove     — delete a password from keychain
 */

import { cancel, confirm, intro, isCancel, log, outro, spinner } from '@clack/prompts';

import { loadRawConfig, saveConfig } from '../config/loader.js';
import {
  isKeychainSentinel,
  keychainAvailable,
  keychainDelete,
  keychainGet,
  keychainSet,
  makeKeychainSentinel,
} from '../security/keychain.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class CancelledError extends Error {
  constructor() {
    super('Operation cancelled.');
  }
}

function assertNotCancel<T>(value: T | symbol): asserts value is T {
  if (isCancel(value)) {
    cancel('Operation cancelled.');
    throw new CancelledError();
  }
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/**
 * Show which accounts use keychain vs plain text passwords.
 */
async function keychainStatus(): Promise<void> {
  if (!(await keychainAvailable())) {
    console.error('macOS Keychain is not available on this system.');
    return;
  }

  const config = await loadRawConfig();
  const { accounts } = config;

  if (accounts.length === 0) {
    console.log('No accounts configured.');
    return;
  }

  console.log(`\n  ${'Name'.padEnd(16)} ${'Email'.padEnd(30)} Password Storage`);
  console.log(`  ${'─'.repeat(16)} ${'─'.repeat(30)} ${'─'.repeat(20)}`);

  for (const acct of accounts) {
    let storage: string;
    if (isKeychainSentinel(acct.password)) {
      const pwd = acct.password;
      if (pwd === undefined) continue; // unreachable: sentinel check fails on undefined
      const keychainName = pwd.slice('use_keychain:'.length);
      // Verify it actually exists in keychain
      const found = await keychainGet(keychainName);
      storage = found ? 'Keychain (OK)' : 'Keychain (MISSING)';
    } else if (acct.password) {
      storage = 'Plain text (insecure)';
    } else if (acct.oauth2) {
      storage = 'OAuth2 (no password)';
    } else {
      storage = 'No password set';
    }
    console.log(`  ${acct.name.padEnd(16)} ${acct.email.padEnd(30)} ${storage}`);
  }

  const plainCount = accounts.filter(
    (a) => a.password && !isKeychainSentinel(a.password) && !a.oauth2,
  ).length;
  if (plainCount > 0) {
    console.log(
      `\n  ${plainCount} account(s) have plain text passwords. Run 'email-mcp keychain migrate' to secure them.`,
    );
  }
  console.log();
}

/**
 * Migrate all plain-text passwords to macOS Keychain.
 */
async function keychainMigrate(): Promise<void> {
  intro('email-mcp > Keychain Migration');

  if (!(await keychainAvailable())) {
    log.error('macOS Keychain is not available on this system.');
    log.info('Passwords will remain in the config file.');
    cancel('Keychain not available.');
    return;
  }

  const config = await loadRawConfig();
  const { accounts } = config;

  // Find accounts that need migration
  const needsMigration = accounts.filter(
    (a) => a.password && !isKeychainSentinel(a.password) && !a.oauth2,
  );

  if (needsMigration.length === 0) {
    log.success('All passwords are already stored in Keychain (or use OAuth2).');
    outro('Nothing to migrate.');
    return;
  }

  console.log(`\n  The following accounts have plain text passwords:`);
  for (const acct of needsMigration) {
    console.log(`    - ${acct.name} (${acct.email})`);
  }
  console.log();

  const proceed = await confirm({
    message: `Migrate ${needsMigration.length} password(s) to macOS Keychain?`,
    initialValue: true,
  });
  assertNotCancel(proceed);

  const spin = spinner();
  spin.start('Migrating passwords to Keychain...');

  let migrated = 0;
  let failed = 0;

  for (const acct of needsMigration) {
    try {
      const pwd = acct.password;
      if (!pwd || isKeychainSentinel(pwd)) continue;
      await keychainSet(acct.name, pwd);
      acct.password = makeKeychainSentinel(acct.name);
      migrated++;
    } catch (err) {
      log.error(`Failed to migrate "${acct.name}": ${err}`);
      failed++;
    }
  }

  if (migrated > 0) {
    // Save the updated config with sentinel values
    await saveConfig(config);
    spin.stop(`Migrated ${migrated} password(s) to Keychain.`);
  } else {
    spin.stop('No passwords were migrated.');
  }

  if (failed > 0) {
    log.warning(`${failed} password(s) failed to migrate.`);
  }

  outro('Done!');
}

/**
 * Remove a password from Keychain.
 */
async function keychainRemove(accountName?: string): Promise<void> {
  intro('email-mcp > Remove Keychain Entry');

  if (!(await keychainAvailable())) {
    log.error('macOS Keychain is not available on this system.');
    cancel('Keychain not available.');
    return;
  }

  const config = await loadRawConfig();

  let target: string;
  if (accountName) {
    target = accountName;
  } else {
    // Show accounts with keychain passwords
    const keychainAccounts = config.accounts.filter((a) => isKeychainSentinel(a.password));
    if (keychainAccounts.length === 0) {
      log.info('No accounts have Keychain passwords.');
      outro('Nothing to remove.');
      return;
    }

    const { select: pSelect } = await import('@clack/prompts');
    const chosen = await pSelect({
      message: 'Which account password do you want to remove from Keychain?',
      options: keychainAccounts.map((a) => ({
        value: a.name,
        label: a.name,
        hint: a.email,
      })),
    });
    assertNotCancel(chosen);
    target = chosen;
  }

  // Find the keychain account name
  const acct = config.accounts.find((a) => a.name === target);
  if (!acct || !isKeychainSentinel(acct.password)) {
    log.error(`Account "${target}" does not use Keychain.`);
    cancel('Nothing to remove.');
    return;
  }

  const confirmed = await confirm({
    message: `Remove Keychain password for "${target}"? The config will keep the sentinel value (connection will fail until re-added).`,
    initialValue: false,
  });
  assertNotCancel(confirmed);

  await keychainDelete(target);
  log.success(`Removed Keychain password for "${target}".`);
  outro('Done!');
}

// ---------------------------------------------------------------------------
// Usage + dispatch
// ---------------------------------------------------------------------------

function printKeychainUsage(): void {
  console.log(`Usage: email-mcp keychain <subcommand>

Subcommands:
  status            Show which accounts use Keychain vs plain text
  migrate           Move all plain-text passwords to macOS Keychain
  remove [name]     Remove a password from Keychain

Examples:
  email-mcp keychain status
  email-mcp keychain migrate
  email-mcp keychain remove personal
`);
}

export default async function runKeychainCommand(subcommand?: string, arg?: string): Promise<void> {
  try {
    switch (subcommand) {
      case 'status':
      case 'ls':
        await keychainStatus();
        return;
      case 'migrate':
      case 'mv':
        await keychainMigrate();
        return;
      case 'remove':
      case 'rm':
      case 'delete':
        await keychainRemove(arg);
        return;
      default:
        printKeychainUsage();
    }
  } catch (err) {
    if (err instanceof CancelledError) return;
    throw err;
  }
}
