/**
 * Account management subcommands.
 *
 * - account list          — list all configured accounts
 * - account add           — interactive wizard to add a new account
 * - account edit [name]   — edit an existing account interactively
 * - account delete [name] — remove an account with confirmation
 */

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  password as p_password,
  spinner as p_spinner,
  select,
  text,
} from '@clack/prompts';
import { z } from 'zod';
import { forgetCachedAccount } from '../cache/store.js';
import {
  appendAccountToConfig,
  CONFIG_FILE,
  configExists,
  loadRawConfig,
  saveConfig,
} from '../config/loader.js';
import type { RawAccountConfig, RawAppConfig } from '../config/schema.js';
import { AccountConfigSchema, AppConfigFileSchema } from '../config/schema.js';
import { CACHE_DB } from '../config/xdg.js';
import ConnectionManager from '../connections/manager.js';
import {
  isKeychainSentinel,
  keychainAvailable,
  keychainDelete,
  keychainGet,
  keychainSentinelAccount,
  keychainSet,
  makeKeychainSentinel,
} from '../security/keychain.js';

import { DEFAULT_TOOL_GROUPS, normalizeToolGroups } from '../tools/toolsets.js';
import type { AccountConfig, ToolGroup } from '../types/index.js';
import ensureInteractive from './guard.js';
import { buildServerEntry, runInstall } from './install-commands.js';
import { detectProvider } from './providers.js';
import { afterToolChoice, TOOL_PICK_MESSAGE, toolGroupOptions } from './tools-commands.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class CancelledError extends Error {
  constructor() {
    super('Operation cancelled.');
  }
}

function assertNotCancel<T>(value: T): asserts value is Exclude<T, symbol> {
  if (isCancel(value)) {
    cancel('Operation cancelled.');
    throw new CancelledError();
  }
}

function formatSecurity(tls: boolean, starttls: boolean): string {
  if (tls) return 'TLS';
  if (starttls) return 'STARTTLS';
  return 'plain';
}

function getSmtpLabel(starttls: boolean, tls: boolean): string {
  if (starttls) return 'STARTTLS';
  if (tls) return 'TLS';
  return 'plain';
}

// ---------------------------------------------------------------------------
// Reusable prompts
// ---------------------------------------------------------------------------

export interface ServerSettings {
  imapHost: string;
  imapPort: number;
  imapTls: boolean;
  imapStarttls: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpTls: boolean;
  smtpStarttls: boolean;
  smtpPoolEnabled: boolean;
  smtpPoolMaxConnections: number;
  smtpPoolMaxMessages: number;
}

export function resolveImapSecurityDefault(defaults?: Partial<ServerSettings>): string {
  if (defaults?.imapStarttls) return 'starttls';
  if (defaults?.imapTls ?? true) return 'tls';
  return 'none';
}

export function resolveSmtpSecurityDefault(defaults?: Partial<ServerSettings>): string {
  if (defaults?.smtpStarttls) return 'starttls';
  if (defaults?.smtpTls ?? true) return 'tls';
  return 'none';
}

// ---------------------------------------------------------------------------
// Answer checks. Each runs at the prompt, so a typo is fixed on the spot
// instead of throwing away every answer at the end.
// ---------------------------------------------------------------------------

const EMAIL_FORMAT = z.string().email();

/** @internal Exported for testing. */
export function checkEmail(value?: string): string | undefined {
  return EMAIL_FORMAT.safeParse((value ?? '').trim()).success
    ? undefined
    : 'Type a full email address, like you@example.com';
}

/** @internal Exported for testing. Empty is fine: the shown default is used. */
export function checkPort(value?: string): string | undefined {
  const v = (value ?? '').trim();
  if (v === '') return undefined;
  if (!/^\d+$/.test(v)) return 'Type a number, like 993';
  const n = Number(v);
  return n >= 1 && n <= 65535 ? undefined : 'Type a number from 1 to 65535';
}

/** @internal Exported for testing. */
export function checkHost(value: string | undefined, what: string): string | undefined {
  const v = (value ?? '').trim();
  if (v === '')
    return `${what} is required, like ${what.startsWith('IMAP') ? 'imap' : 'smtp'}.example.com`;
  if (/\s/.test(v)) return `${what} cannot have spaces`;
  if (v.includes('://') || v.includes('/'))
    return `${what} is just the name, like mail.example.com`;
  return undefined;
}

function portOr(value: string, fallback: number): number {
  const v = value.trim();
  return v === '' ? fallback : Number(v);
}

async function promptServerSettings(defaults?: Partial<ServerSettings>): Promise<ServerSettings> {
  const imapHost = await text({
    message: 'IMAP host',
    placeholder: 'imap.example.com',
    defaultValue: defaults?.imapHost,
    initialValue: defaults?.imapHost,
    validate: (v) => checkHost(v, 'IMAP host'),
  });
  assertNotCancel(imapHost);

  const imapPortStr = await text({
    message: 'IMAP port',
    placeholder: '993',
    defaultValue: String(defaults?.imapPort ?? 993),
    initialValue: defaults?.imapPort ? String(defaults.imapPort) : undefined,
    validate: checkPort,
  });
  assertNotCancel(imapPortStr);

  const imapSecurity = await select({
    message: 'IMAP security',
    initialValue: resolveImapSecurityDefault(defaults),
    options: [
      { value: 'tls', label: 'TLS (port 993)' },
      { value: 'starttls', label: 'STARTTLS (port 143)' },
      { value: 'none', label: 'None (not recommended)' },
    ],
  });
  assertNotCancel(imapSecurity);

  const smtpHost = await text({
    message: 'SMTP host',
    placeholder: 'smtp.example.com',
    defaultValue: defaults?.smtpHost,
    initialValue: defaults?.smtpHost,
    validate: (v) => checkHost(v, 'SMTP host'),
  });
  assertNotCancel(smtpHost);

  const smtpPortStr = await text({
    message: 'SMTP port',
    placeholder: '465',
    defaultValue: String(defaults?.smtpPort ?? 465),
    initialValue: defaults?.smtpPort ? String(defaults.smtpPort) : undefined,
    validate: checkPort,
  });
  assertNotCancel(smtpPortStr);

  const smtpSecurity = await select({
    message: 'SMTP security',
    initialValue: resolveSmtpSecurityDefault(defaults),
    options: [
      { value: 'tls', label: 'TLS (port 465)' },
      { value: 'starttls', label: 'STARTTLS (port 587)' },
      { value: 'none', label: 'None (not recommended)' },
    ],
  });
  assertNotCancel(smtpSecurity);

  // Sending reuses one connection for up to 100 messages. This suits every
  // mailbox we know of, so the wizard does not ask. Power users can change
  // [accounts.smtp.pool] in the config file; an edit keeps what is there.
  const smtpPoolEnabled = defaults?.smtpPoolEnabled ?? true;
  const smtpPoolMaxConnections = defaults?.smtpPoolMaxConnections ?? 1;
  const smtpPoolMaxMessages = defaults?.smtpPoolMaxMessages ?? 100;

  return {
    imapHost: imapHost.trim(),
    imapPort: portOr(imapPortStr ?? '', defaults?.imapPort ?? 993),
    imapTls: imapSecurity === 'tls',
    imapStarttls: imapSecurity === 'starttls',
    smtpHost: smtpHost.trim(),
    smtpPort: portOr(smtpPortStr ?? '', defaults?.smtpPort ?? 465),
    smtpTls: smtpSecurity === 'tls',
    smtpStarttls: smtpSecurity === 'starttls',
    smtpPoolEnabled,
    smtpPoolMaxConnections,
    smtpPoolMaxMessages,
  };
}

/**
 * Prompt for account identity (name, email, full name).
 */
async function promptAccountIdentity(defaults?: {
  name?: string;
  email?: string;
  fullName?: string;
}): Promise<{ name: string; email: string; fullName: string }> {
  const name = await text({
    message: 'Account name',
    placeholder: 'personal',
    defaultValue: defaults?.name,
    initialValue: defaults?.name,
    validate: (v) => (!v || v.length === 0 ? 'Account name is required' : undefined),
  });
  assertNotCancel(name);

  const email = await text({
    message: 'Email address',
    placeholder: 'you@example.com',
    defaultValue: defaults?.email,
    initialValue: defaults?.email,
    validate: checkEmail,
  });
  assertNotCancel(email);

  const fullName = await text({
    message: 'Full name (optional)',
    placeholder: 'Your Name',
    defaultValue: defaults?.fullName,
    initialValue: defaults?.fullName,
  });
  assertNotCancel(fullName);

  return { name: name.trim(), email: email.trim(), fullName: fullName.trim() };
}

/**
 * Prompt for credentials (username, password).
 */
async function promptCredentials(defaults?: {
  username?: string;
  email?: string;
}): Promise<{ username: string; password: string }> {
  const username = await text({
    message: 'Username',
    placeholder: defaults?.email ?? 'you@example.com',
    defaultValue: defaults?.username ?? defaults?.email,
    initialValue: defaults?.username ?? defaults?.email,
  });
  assertNotCancel(username);

  const password = await p_password({
    message: 'Password / App Password',
    validate: (v) => (!v || v.length === 0 ? 'Password is required' : undefined),
  });
  assertNotCancel(password);

  return { username, password };
}

/**
 * Auto-detect provider settings from email domain.
 * Returns server settings or prompts for manual entry.
 */
async function resolveServerSettings(
  email: string,
  defaults?: Partial<ServerSettings>,
): Promise<ServerSettings> {
  const provider = detectProvider(email);

  if (provider) {
    log.success(`Auto-detected: ${provider.name}`);
    log.info(
      `  IMAP: ${provider.imap.host}:${provider.imap.port} (${formatSecurity(provider.imap.tls, provider.imap.starttls)})`,
    );
    const smtpLabel = getSmtpLabel(provider.smtp.starttls, provider.smtp.tls);
    log.info(`  SMTP: ${provider.smtp.host}:${provider.smtp.port} (${smtpLabel})`);

    if (provider.notes) {
      log.warning(`  Note: ${provider.notes}`);
    }

    const useDetected = await confirm({
      message: 'Use detected settings?',
      initialValue: true,
    });
    assertNotCancel(useDetected);

    if (useDetected) {
      return {
        imapHost: provider.imap.host,
        imapPort: provider.imap.port,
        imapTls: provider.imap.tls,
        imapStarttls: provider.imap.starttls,
        smtpHost: provider.smtp.host,
        smtpPort: provider.smtp.port,
        smtpTls: provider.smtp.tls,
        smtpStarttls: provider.smtp.starttls,
        smtpPoolEnabled: true,
        smtpPoolMaxConnections: 1,
        smtpPoolMaxMessages: 100,
      };
    }
  } else {
    log.info('Provider not auto-detected. Please enter server settings manually.');
  }

  return promptServerSettings(defaults);
}

/**
 * Build a normalized AccountConfig for connection testing.
 * @internal Exported for testing.
 */
export function buildTestAccount(
  identity: { name: string; email: string; fullName: string },
  creds: { username: string; password: string },
  server: ServerSettings,
): AccountConfig {
  return {
    name: identity.name,
    email: identity.email,
    fullName: identity.fullName || undefined,
    username: creds.username || identity.email,
    password: creds.password,
    imap: {
      host: server.imapHost,
      port: server.imapPort,
      tls: server.imapTls,
      starttls: server.imapStarttls,
      verifySsl: true,
    },
    smtp: {
      host: server.smtpHost,
      port: server.smtpPort,
      tls: server.smtpTls,
      starttls: server.smtpStarttls,
      verifySsl: true,
      pool: {
        enabled: server.smtpPoolEnabled,
        maxConnections: server.smtpPoolMaxConnections,
        maxMessages: server.smtpPoolMaxMessages,
      },
    },
  };
}

/**
 * Check a built account against the config schema before anything is sent to
 * a server, so an unencrypted choice to a remote host is refused up front
 * instead of after the password has crossed the network in the clear.
 * Prints each problem and returns false when the account is not acceptable.
 */
function accountPassesSchema(account: RawAccountConfig): boolean {
  const result = AccountConfigSchema.safeParse(account);
  if (result.success) return true;
  for (const issue of result.error.issues) {
    log.error(issue.message);
  }
  return false;
}

/**
 * Test IMAP and SMTP connections. Returns true if both succeed or user opts to proceed.
 */
async function testConnections(account: AccountConfig): Promise<boolean> {
  const spinner = p_spinner();

  spinner.start('Testing IMAP connection…');
  const imapResult = await ConnectionManager.testImap(account);
  if (imapResult.success) {
    spinner.stop(
      `IMAP ✓ ${account.imap.host}:${account.imap.port} — ${imapResult.details?.messages} messages, ${imapResult.details?.folders} folders`,
    );
  } else {
    spinner.stop(`IMAP ✗ ${imapResult.error}`);
  }

  spinner.start('Testing SMTP connection…');
  const smtpResult = await ConnectionManager.testSmtp(account);
  if (smtpResult.success) {
    spinner.stop(`SMTP ✓ ${account.smtp.host}:${account.smtp.port} — authenticated`);
  } else {
    spinner.stop(`SMTP ✗ ${smtpResult.error}`);
  }

  if (!imapResult.success || !smtpResult.success) {
    const proceed = await confirm({
      message: 'Some connections failed. Save config anyway?',
      initialValue: false,
    });
    if (isCancel(proceed) || !proceed) {
      cancel('Cancelled. Please check your credentials and server settings.');
      return false;
    }
  }

  return true;
}

/**
 * Build a RawAccountConfig from collected data.
 * @internal Exported for testing.
 */
export function buildRawAccount(
  identity: { name: string; email: string; fullName: string },
  creds: { username: string; password: string },
  server: ServerSettings,
): RawAccountConfig {
  return {
    name: identity.name,
    email: identity.email,
    full_name: identity.fullName || undefined,
    username: creds.username || identity.email,
    password: creds.password,
    imap: {
      host: server.imapHost,
      port: server.imapPort,
      tls: server.imapTls,
      starttls: server.imapStarttls,
      verify_ssl: true,
    },
    smtp: {
      host: server.smtpHost,
      port: server.smtpPort,
      tls: server.smtpTls,
      starttls: server.smtpStarttls,
      verify_ssl: true,
      pool: {
        enabled: server.smtpPoolEnabled,
        max_connections: server.smtpPoolMaxConnections,
        max_messages: server.smtpPoolMaxMessages,
      },
    },
  };
}

/**
 * Apply an edit to an existing account: start from what is already in the
 * file and change only the fields the wizard asks about. Everything else
 * (oauth2, password_command, sieve, max_attachment_mb, verify_ssl, pool
 * settings the wizard does not show) is kept as it was.
 * @internal Exported for testing.
 */
export function buildEditedAccount(
  current: RawAccountConfig,
  identity: { name: string; email: string; fullName: string },
  creds: { username: string; password: string },
  server: ServerSettings,
  passwordChanged: boolean,
): RawAccountConfig {
  const edited: RawAccountConfig = {
    ...current,
    name: identity.name,
    email: identity.email,
    full_name: identity.fullName || undefined,
    username: creds.username || identity.email,
    imap: {
      ...current.imap,
      host: server.imapHost,
      port: server.imapPort,
      tls: server.imapTls,
      starttls: server.imapStarttls,
    },
    smtp: {
      ...current.smtp,
      host: server.smtpHost,
      port: server.smtpPort,
      tls: server.smtpTls,
      starttls: server.smtpStarttls,
      pool: {
        enabled: server.smtpPoolEnabled,
        max_connections: server.smtpPoolMaxConnections,
        max_messages: server.smtpPoolMaxMessages,
      },
    },
  };
  if (passwordChanged) edited.password = creds.password;
  return edited;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

/**
 * List all configured accounts in a formatted table.
 */
async function listAccounts(): Promise<void> {
  const exists = await configExists();
  if (!exists) {
    console.error(`No config file found at: ${CONFIG_FILE}`);
    console.error("Run 'imap-wizard account add' to create one.");
    return;
  }

  const config = await loadRawConfig();
  const { accounts } = config;

  if (accounts.length === 0) {
    console.log('No accounts configured.');
    return;
  }

  console.log(`\n  ${'Name'.padEnd(16)} ${'Email'.padEnd(30)} ${'IMAP'.padEnd(28)} SMTP`);
  console.log(`  ${'─'.repeat(16)} ${'─'.repeat(30)} ${'─'.repeat(28)} ${'─'.repeat(28)}`);

  accounts.forEach((acct) => {
    const imapInfo = `${acct.imap.host}:${acct.imap.port} (${formatSecurity(acct.imap.tls, acct.imap.starttls)})`;
    const smtpInfo = `${acct.smtp.host}:${acct.smtp.port} (${formatSecurity(acct.smtp.tls, acct.smtp.starttls)})`;
    console.log(
      `  ${acct.name.padEnd(16)} ${acct.email.padEnd(30)} ${imapInfo.padEnd(28)} ${smtpInfo}`,
    );
  });

  console.log(`\n  ${accounts.length} account(s) configured.\n`);
}

/**
 * Interactive wizard to add a new email account.
 */
async function addAccount(): Promise<void> {
  ensureInteractive();
  intro('imap-wizard › Add Account');

  let existingConfig: RawAppConfig | undefined;
  const exists = await configExists();
  if (exists) {
    try {
      existingConfig = await loadRawConfig();
    } catch (err) {
      // Never write over a file we could not read: it may hold every other
      // account. The message carries the position only, not the file's text.
      log.error(`Could not read your existing config at ${CONFIG_FILE}:`);
      log.error(err instanceof Error ? err.message : String(err));
      cancel('Nothing was changed. Fix the file (or move it aside) and run this again.');
      return;
    }
  }

  // 1. Identity
  const identity = await promptAccountIdentity();

  // Check for duplicate names
  if (existingConfig?.accounts.some((a) => a.name === identity.name)) {
    log.error(`Account "${identity.name}" already exists. Use 'account edit' to modify it.`);
    cancel('Duplicate account name.');
    return;
  }

  // 2. Server settings (auto-detect or manual)
  let server = await resolveServerSettings(identity.email);

  // 3. Credentials
  const creds = await promptCredentials({ email: identity.email });

  // 4. Check the choices, then test connections
  let newAccount = buildRawAccount(identity, creds, server);
  // A problem the prompts could not catch (for example no encryption to a
  // remote server): fix the server settings now, keeping every other answer.
  while (!accountPassesSchema(newAccount)) {
    const retry = await confirm({
      message: 'Fix the server settings now? Your other answers are kept.',
      initialValue: true,
    });
    if (isCancel(retry) || !retry) {
      cancel('Nothing was tested or saved.');
      return;
    }
    server = await promptServerSettings(server);
    newAccount = buildRawAccount(identity, creds, server);
  }
  const testAccount = buildTestAccount(identity, creds, server);
  const ok = await testConnections(testAccount);
  if (!ok) return;

  // 5. On a first setup, ask what the AI may do. Later changes: `imap-wizard tools`.
  let toolGroups: ToolGroup[] | undefined;
  if (!existingConfig) {
    const picked = await multiselect<ToolGroup>({
      message: TOOL_PICK_MESSAGE,
      options: toolGroupOptions(),
      initialValues: [...DEFAULT_TOOL_GROUPS],
      required: false,
    });
    if (isCancel(picked)) {
      cancel('Setup cancelled. Nothing was saved.');
      return;
    }
    toolGroups = normalizeToolGroups(picked);
  }

  // 6. Save

  // Store password in keychain if available (more secure than plain text)
  if (await keychainAvailable()) {
    try {
      await keychainSet(identity.name, creds.password);
      newAccount.password = makeKeychainSentinel(identity.name);
      log.info('Password stored in secure keychain.');
    } catch (err) {
      log.warning(`Could not store password in Keychain: ${err}`);
      log.info('Password saved in config file (less secure).');
    }
  }

  const config: RawAppConfig = existingConfig
    ? {
        ...existingConfig,
        accounts: [...existingConfig.accounts, newAccount],
      }
    : {
        settings: {
          rate_limit: 10,
          send: { max_attachment_mb: 25 },
          idle_exit: 0,
          read_only: false,
          toolset: 'full',
          ...(toolGroups ? { tools: toolGroups } : {}),
          cache: {
            enabled: true,
            mailboxes: ['INBOX'],
            window_days: 90,
            read_through: false,
            offline_reads: true,
            body_max_mb: 200,
            body_messages: 500,
            max_size_mb: 500,
            sync_interval: 300,
          },
          watcher: {
            enabled: false,
            folders: ['INBOX'],
            idle_timeout: 1740,
          },
          verification: {
            // The "sign-in code catcher" box. Off unless ticked.
            enabled: toolGroups?.includes('codes') ?? false,
            include_magic_links: false,
          },
          hooks: {
            on_new_email: 'notify',
            preset: 'priority-focus',
            auto_label: false,
            auto_flag: false,
            batch_delay: 5,
            rules: [],
            alerts: {
              desktop: false,
              sound: false,
              urgency_threshold: 'high',
              webhook_url: '',
              webhook_events: ['urgent', 'high'],
            },
            auto_calendar: false,
            calendar_name: '',
            calendar_alarm_minutes: 15,
            calendar_confirm: true,
          },
        },
        sieve: { allowed_redirects: [], allowed_programs: [] },
        accounts: [newAccount],
      };

  AppConfigFileSchema.parse(config);
  if (existingConfig) {
    // Append, so comments and settings already in the file are kept as written.
    await appendAccountToConfig(newAccount);
  } else {
    await saveConfig(config);
  }
  log.success(`Account "${identity.name}" added. Config saved to ${CONFIG_FILE}`);
  if (toolGroups) await afterToolChoice(toolGroups);

  // Finish the job: hook the server up to the user's AI app, or say how.
  const connectNow = await confirm({
    message: 'Connect it to your AI app now (Claude, Cursor, VS Code, Codex and more)?',
    initialValue: true,
  });
  if (!isCancel(connectNow) && connectNow) {
    await runInstall();
    return;
  }
  note(
    [
      'Run this when you are ready:  npx -y imap-wizard install',
      'Claude Code:  claude mcp add email -- npx -y imap-wizard stdio',
      '',
      'Or add this to your app config by hand:',
      JSON.stringify({ mcpServers: { email: buildServerEntry('npx') } }, null, 2),
    ].join('\n'),
    'Connect your AI app',
  );
  outro('Done!');
}

/**
 * Interactive editor for an existing account.
 * Shows a field selector so users can pick exactly what to change.
 */
async function editAccount(nameArg?: string): Promise<void> {
  ensureInteractive();
  intro('imap-wizard › Edit Account');

  const exists = await configExists();
  if (!exists) {
    log.error(`No config file found at: ${CONFIG_FILE}`);
    cancel("Run 'imap-wizard account add' first.");
    return;
  }

  const config = await loadRawConfig();
  const { accounts } = config;

  // Resolve which account to edit
  let accountIndex: number;
  if (nameArg) {
    accountIndex = accounts.findIndex((a) => a.name === nameArg);
    if (accountIndex === -1) {
      log.error(`Account "${nameArg}" not found.`);
      log.info(`Available accounts: ${accounts.map((a) => a.name).join(', ')}`);
      cancel('Account not found.');
      return;
    }
  } else if (accounts.length === 1) {
    accountIndex = 0;
    log.info(`Editing account "${accounts[0].name}".`);
  } else {
    const chosen = await select({
      message: 'Which account do you want to edit?',
      options: accounts.map((a, i) => ({
        value: i,
        label: a.name,
        hint: a.email,
      })),
    });
    assertNotCancel(chosen);
    accountIndex = chosen;
  }

  const current = accounts[accountIndex];

  // Field selector — let user choose what to edit
  const fields = await select({
    message: `Editing "${current.name}" — what would you like to change?`,
    options: [
      {
        value: 'identity',
        label: 'Name, email, or display name',
        hint: `${current.name} <${current.email}>`,
      },
      {
        value: 'servers',
        label: 'Server settings (IMAP/SMTP)',
        hint: `${current.imap.host}, ${current.smtp.host}`,
      },
      {
        value: 'credentials',
        label: 'Username or password',
        hint: current.username ?? current.email,
      },
      {
        value: 'all',
        label: 'Everything',
        hint: 'Re-configure from scratch',
      },
    ],
  });
  assertNotCancel(fields);

  let identity = {
    name: current.name,
    email: current.email,
    fullName: current.full_name ?? '',
  };
  let server: ServerSettings = {
    imapHost: current.imap.host,
    imapPort: current.imap.port,
    imapTls: current.imap.tls,
    imapStarttls: current.imap.starttls,
    smtpHost: current.smtp.host,
    smtpPort: current.smtp.port,
    smtpTls: current.smtp.tls,
    smtpStarttls: current.smtp.starttls,
    smtpPoolEnabled: current.smtp.pool?.enabled ?? true,
    smtpPoolMaxConnections: current.smtp.pool?.max_connections ?? 1,
    smtpPoolMaxMessages: current.smtp.pool?.max_messages ?? 100,
  };
  let creds = {
    username: current.username ?? current.email,
    password: current.password ?? '',
  };

  if (fields === 'identity' || fields === 'all') {
    identity = await promptAccountIdentity(identity);
    // If name changed, check for duplicates
    if (identity.name !== current.name) {
      if (accounts.some((a, i) => i !== accountIndex && a.name === identity.name)) {
        log.error(`Account "${identity.name}" already exists.`);
        cancel('Duplicate account name.');
        return;
      }
    }
  }

  if (fields === 'servers' || fields === 'all') {
    if (fields === 'all') {
      server = await resolveServerSettings(identity.email, server);
    } else {
      server = await promptServerSettings(server);
    }
  }

  if (fields === 'credentials' || fields === 'all') {
    creds = await promptCredentials({
      username: creds.username,
      email: identity.email,
    });
  }

  const passwordChanged = fields === 'credentials' || fields === 'all';
  const updatedAccount = buildEditedAccount(current, identity, creds, server, passwordChanged);
  if (!accountPassesSchema(updatedAccount)) {
    cancel('Nothing was tested or saved. Fix the item above and try again.');
    return;
  }

  // Test connections. The password to test with is the one just typed, or the
  // stored one; a Keychain placeholder is never used as a password.
  const shouldTest = await confirm({
    message: 'Test connections with updated settings?',
    initialValue: true,
  });
  assertNotCancel(shouldTest);

  if (shouldTest) {
    let testPassword: string | undefined = creds.password;
    if (!passwordChanged && isKeychainSentinel(current.password)) {
      const stored = (await keychainAvailable())
        ? await keychainGet(keychainSentinelAccount(current.password as string))
        : null;
      testPassword = stored ?? undefined;
    }
    if (!passwordChanged && (current.password_command || current.oauth2)) {
      testPassword = undefined;
    }
    if (testPassword === undefined || testPassword === '') {
      log.info('Skipping the connection test: no password is available to test with here.');
    } else {
      const ok = await testConnections(
        buildTestAccount(identity, { ...creds, password: testPassword }, server),
      );
      if (!ok) return;
    }
  }

  // Password storage
  const renamed = identity.name !== current.name;
  if (passwordChanged) {
    // A new password was typed: store it (Keychain when available).
    if ((await keychainAvailable()) && creds.password) {
      try {
        await keychainSet(identity.name, creds.password);
        updatedAccount.password = makeKeychainSentinel(identity.name);
        log.info('Password stored in secure keychain.');
        if (renamed && isKeychainSentinel(current.password)) {
          await keychainDelete(keychainSentinelAccount(current.password as string));
        }
      } catch (err) {
        log.warning(`Could not store password in Keychain: ${err}`);
        log.info('Password saved in config file (less secure).');
      }
    }
  } else if (isKeychainSentinel(current.password)) {
    // The password stays where it is. Only a rename moves the Keychain item,
    // and only after the secret has been read and copied to the new name.
    const oldName = keychainSentinelAccount(current.password as string);
    if (renamed && (await keychainAvailable())) {
      try {
        const secret = await keychainGet(oldName);
        if (secret) {
          await keychainSet(identity.name, secret);
          updatedAccount.password = makeKeychainSentinel(identity.name);
          await keychainDelete(oldName);
        } else {
          log.warning(`Keychain item "${oldName}" was not found; the config still points at it.`);
        }
      } catch (err) {
        log.warning(`Could not move the Keychain item: ${err}`);
      }
    }
  } else if ((await keychainAvailable()) && current.password) {
    // A plain-text password in the file moves to the Keychain, as before.
    try {
      await keychainSet(identity.name, current.password);
      updatedAccount.password = makeKeychainSentinel(identity.name);
      log.info('Password stored in secure keychain.');
    } catch (err) {
      log.warning(`Could not store password in Keychain: ${err}`);
      log.info('Password saved in config file (less secure).');
    }
  }

  const updatedAccounts = [...accounts];
  updatedAccounts[accountIndex] = updatedAccount;

  const updatedConfig: RawAppConfig = {
    ...config,
    accounts: updatedAccounts,
  };

  AppConfigFileSchema.parse(updatedConfig);
  await saveConfig(updatedConfig);
  log.success(`Account "${identity.name}" updated. Config saved to ${CONFIG_FILE}`);
  outro('Done!');
}

/**
 * Delete an account with confirmation.
 * Refuses to delete the last remaining account.
 */
async function deleteAccount(nameArg?: string): Promise<void> {
  ensureInteractive();
  intro('imap-wizard › Delete Account');

  const exists = await configExists();
  if (!exists) {
    log.error(`No config file found at: ${CONFIG_FILE}`);
    cancel('Nothing to delete.');
    return;
  }

  const config = await loadRawConfig();
  const { accounts } = config;

  if (accounts.length === 0) {
    log.info('No accounts configured.');
    cancel('Nothing to delete.');
    return;
  }

  if (accounts.length === 1) {
    log.error('Cannot delete the last account. At least one account must remain.');
    log.info("Use 'imap-wizard account edit' to modify it instead.");
    cancel('Operation refused.');
    return;
  }

  // Resolve which account to delete
  let accountIndex: number;
  if (nameArg) {
    accountIndex = accounts.findIndex((a) => a.name === nameArg);
    if (accountIndex === -1) {
      log.error(`Account "${nameArg}" not found.`);
      log.info(`Available accounts: ${accounts.map((a) => a.name).join(', ')}`);
      cancel('Account not found.');
      return;
    }
  } else {
    const chosen = await select({
      message: 'Which account do you want to delete?',
      options: accounts.map((a, i) => ({
        value: i,
        label: a.name,
        hint: a.email,
      })),
    });
    assertNotCancel(chosen);
    accountIndex = chosen;
  }

  const target = accounts[accountIndex];

  // Require explicit confirmation
  const confirmed = await confirm({
    message: `Delete account "${target.name}" (${target.email})? This cannot be undone.`,
    initialValue: false,
  });

  if (isCancel(confirmed) || !confirmed) {
    cancel('Deletion cancelled.');
    return;
  }

  // Remove from keychain if it was stored there
  if ((await keychainAvailable()) && isKeychainSentinel(target.password)) {
    await keychainDelete(target.name);
    log.info(`Removed Keychain password for "${target.name}".`);
  }

  const updatedAccounts = accounts.filter((_, i) => i !== accountIndex);
  const updatedConfig: RawAppConfig = {
    ...config,
    accounts: updatedAccounts,
  };

  AppConfigFileSchema.parse(updatedConfig);
  await saveConfig(updatedConfig);
  // Its mirrored mail would otherwise stay on disk, and would be served again
  // to a new account given the same name.
  if (forgetCachedAccount(CACHE_DB, target.name)) {
    log.info(`Removed the cached mail of "${target.name}".`);
  }
  log.success(`Account "${target.name}" deleted. Config saved to ${CONFIG_FILE}`);
  outro('Done!');
}

// ---------------------------------------------------------------------------
// Usage + dispatch
// ---------------------------------------------------------------------------

function printAccountUsage(): void {
  console.log(`Usage: imap-wizard account <subcommand>

Subcommands:
  list              List all configured accounts
  add               Add a new email account interactively
  edit [name]       Edit an existing account
  delete [name]     Remove an account

Examples:
  imap-wizard account list
  imap-wizard account add
  imap-wizard account edit personal
  imap-wizard account delete work
`);
}

export default async function runAccountCommand(subcommand?: string, arg?: string): Promise<void> {
  try {
    switch (subcommand) {
      case 'list':
      case 'ls':
        await listAccounts();
        return;
      case 'add':
      case 'new':
        await addAccount();
        return;
      case 'edit':
        await editAccount(arg);
        return;
      case 'delete':
      case 'rm':
      case 'remove':
        await deleteAccount(arg);
        return;
      default:
        printAccountUsage();
    }
  } catch (err) {
    if (err instanceof CancelledError) return;
    throw err;
  }
}
