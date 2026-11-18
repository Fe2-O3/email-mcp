/**
 * Configuration loader.
 *
 * Precedence: environment variables → TOML config file → defaults.
 * Passwords marked with `use_keychain:<name>` are resolved from the OS keychain.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { parse as parseTOML, stringify as stringifyTOML } from 'smol-toml';
import {
  isKeychainSentinel,
  keychainAvailable,
  keychainGet,
  keychainSentinelAccount,
} from '../security/keychain.js';
import type { AccountConfig, AppConfig, HookRule, OAuth2Config } from '../types/index.js';
import resolvePasswordCommand from './password-command.js';
import type { RawAccountConfig, RawAppConfig } from './schema.js';
import { AppConfigFileSchema } from './schema.js';
import { findUnknownKeys, imapTlsConflictWarning } from './validate.js';
import { CONFIG_FILE, xdg } from './xdg.js';

// ---------------------------------------------------------------------------
// Environment variable loader (single-account quick setup)
// ---------------------------------------------------------------------------

const ENV_TRUE = new Set(['true', '1', 'yes', 'on']);
const ENV_FALSE = new Set(['false', '0', 'no', 'off']);

/**
 * A yes/no environment variable, read strictly. Anything other than the usual
 * spellings is refused: read as "off", a mistyped MCP_EMAIL_READ_ONLY=enabled
 * would quietly run a read-write server.
 */
function envBool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = raw.trim().toLowerCase();
  if (ENV_TRUE.has(value)) return true;
  if (ENV_FALSE.has(value)) return false;
  throw new Error(
    `${name}=${JSON.stringify(raw)} is not a yes/no value. Use true or false (1 or 0 also work).`,
  );
}

function loadFromEnv(): RawAppConfig | null {
  const email = process.env.MCP_EMAIL_ADDRESS;
  const password = process.env.MCP_EMAIL_PASSWORD;
  const passwordCommand = process.env.MCP_EMAIL_PASSWORD_COMMAND;
  const imapHost = process.env.MCP_EMAIL_IMAP_HOST;
  const smtpHost = process.env.MCP_EMAIL_SMTP_HOST;

  if (!email || !imapHost || !smtpHost) {
    return null;
  }

  // Need a password, a password command, or OAuth2 env vars
  const oauth2Provider = process.env.MCP_EMAIL_OAUTH2_PROVIDER;
  if (!password && !passwordCommand && !oauth2Provider) {
    return null;
  }

  const oauth2 = oauth2Provider
    ? {
        provider: oauth2Provider as 'google' | 'microsoft' | 'custom',
        client_id: process.env.MCP_EMAIL_OAUTH2_CLIENT_ID ?? '',
        client_secret: process.env.MCP_EMAIL_OAUTH2_CLIENT_SECRET ?? '',
        refresh_token: process.env.MCP_EMAIL_OAUTH2_REFRESH_TOKEN ?? '',
      }
    : undefined;

  return {
    sieve: {
      allowed_redirects: (process.env.MCP_EMAIL_SIEVE_ALLOWED_REDIRECTS ?? '')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
      allowed_programs: (process.env.MCP_EMAIL_SIEVE_ALLOWED_PROGRAMS ?? '')
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean),
    },
    settings: {
      rate_limit: parseInt(process.env.MCP_EMAIL_RATE_LIMIT ?? '10', 10),
      send: {
        max_attachment_mb: parseInt(process.env.MCP_EMAIL_SEND_MAX_ATTACHMENT_MB ?? '25', 10),
      },
      idle_exit: parseInt(process.env.MCP_EMAIL_IDLE_EXIT ?? '0', 10),
      read_only: envBool('MCP_EMAIL_READ_ONLY', false),
      toolset: (process.env.MCP_EMAIL_TOOLSET ?? 'full') as 'full' | 'core' | 'minimal',
      cache: {
        // Opt-out rather than opt-in: the mirror is a pure win for reads and
        // degrades to live behaviour if anything goes wrong.
        enabled: envBool('MCP_EMAIL_CACHE_ENABLED', true),
        mailboxes: (process.env.MCP_EMAIL_CACHE_MAILBOXES ?? 'INBOX')
          .split(',')
          .map((m) => m.trim())
          .filter(Boolean),
        window_days: parseInt(process.env.MCP_EMAIL_CACHE_WINDOW_DAYS ?? '90', 10),
        read_through: envBool('MCP_EMAIL_CACHE_READ_THROUGH', false),
        offline_reads: envBool('MCP_EMAIL_CACHE_OFFLINE_READS', true),
        body_max_mb: parseInt(process.env.MCP_EMAIL_CACHE_BODY_MAX_MB ?? '200', 10),
        body_messages: parseInt(process.env.MCP_EMAIL_CACHE_BODY_MESSAGES ?? '500', 10),
        max_size_mb: parseInt(process.env.MCP_EMAIL_CACHE_MAX_SIZE_MB ?? '500', 10),
        sync_interval: parseInt(process.env.MCP_EMAIL_CACHE_SYNC_INTERVAL ?? '300', 10),
      },
      watcher: {
        enabled: envBool('MCP_EMAIL_WATCHER_ENABLED', false),
        folders: (process.env.MCP_EMAIL_WATCHER_FOLDERS ?? 'INBOX')
          .split(',')
          .map((f) => f.trim())
          .filter(Boolean),
        idle_timeout: parseInt(process.env.MCP_EMAIL_WATCHER_IDLE_TIMEOUT ?? '1740', 10),
      },
      verification: {
        enabled: envBool('MCP_EMAIL_VERIFICATION_ENABLED', false),
        include_magic_links: envBool('MCP_EMAIL_VERIFICATION_MAGIC_LINKS', false),
      },
      hooks: {
        on_new_email:
          (process.env.MCP_EMAIL_HOOK_ON_NEW_EMAIL as 'triage' | 'notify' | 'none') ?? 'notify',
        preset:
          (process.env.MCP_EMAIL_HOOK_PRESET as
            | 'inbox-zero'
            | 'gtd'
            | 'priority-focus'
            | 'notification-only'
            | 'custom') ?? 'priority-focus',
        auto_label: envBool('MCP_EMAIL_HOOK_AUTO_LABEL', false),
        auto_flag: envBool('MCP_EMAIL_HOOK_AUTO_FLAG', false),
        batch_delay: parseInt(process.env.MCP_EMAIL_HOOK_BATCH_DELAY ?? '5', 10),
        custom_instructions: process.env.MCP_EMAIL_HOOK_CUSTOM_INSTRUCTIONS,
        rules: [],
        alerts: {
          desktop: envBool('MCP_EMAIL_ALERT_DESKTOP', false),
          sound: envBool('MCP_EMAIL_ALERT_SOUND', false),
          urgency_threshold:
            (process.env.MCP_EMAIL_ALERT_URGENCY_THRESHOLD as
              | 'urgent'
              | 'high'
              | 'normal'
              | 'low') ?? 'high',
          webhook_url: process.env.MCP_EMAIL_ALERT_WEBHOOK_URL ?? '',
          webhook_events: ['urgent', 'high'],
        },
        auto_calendar: envBool('MCP_EMAIL_HOOK_AUTO_CALENDAR', false),
        calendar_name: process.env.MCP_EMAIL_HOOK_CALENDAR_NAME ?? '',
        calendar_alarm_minutes: parseInt(
          process.env.MCP_EMAIL_HOOK_CALENDAR_ALARM_MINUTES ?? '15',
          10,
        ),
        calendar_confirm: envBool('MCP_EMAIL_HOOK_CALENDAR_CONFIRM', true),
      },
    },
    accounts: [
      {
        name: process.env.MCP_EMAIL_ACCOUNT_NAME ?? 'default',
        email,
        full_name: process.env.MCP_EMAIL_FULL_NAME,
        username: process.env.MCP_EMAIL_USERNAME,
        password,
        password_command: passwordCommand,
        oauth2,
        imap: {
          host: imapHost,
          port: parseInt(process.env.MCP_EMAIL_IMAP_PORT ?? '993', 10),
          tls: envBool('MCP_EMAIL_IMAP_TLS', true),
          starttls: envBool('MCP_EMAIL_IMAP_STARTTLS', false),
          verify_ssl: envBool('MCP_EMAIL_IMAP_VERIFY_SSL', true),
        },
        smtp: {
          host: smtpHost,
          port: parseInt(process.env.MCP_EMAIL_SMTP_PORT ?? '465', 10),
          tls: envBool('MCP_EMAIL_SMTP_TLS', true),
          starttls: envBool('MCP_EMAIL_SMTP_STARTTLS', false),
          verify_ssl: envBool('MCP_EMAIL_SMTP_VERIFY_SSL', true),
          pool: {
            enabled: envBool('MCP_EMAIL_SMTP_POOL_ENABLED', true),
            max_connections: parseInt(process.env.MCP_EMAIL_SMTP_POOL_MAX_CONNECTIONS ?? '1', 10),
            max_messages: parseInt(process.env.MCP_EMAIL_SMTP_POOL_MAX_MESSAGES ?? '100', 10),
          },
        },
        sieve: sieveFromEnv(),
      },
    ],
  };
}

/** An account `sieve` block only when one of its variables is set; otherwise auto-detect. */
function sieveFromEnv(): RawAccountConfig['sieve'] {
  const { env } = process;
  const keys = ['ENABLED', 'HOST', 'PORT', 'TLS', 'STARTTLS'];
  if (!keys.some((key) => env[`MCP_EMAIL_SIEVE_${key}`] !== undefined)) return undefined;
  return {
    enabled: env.MCP_EMAIL_SIEVE_ENABLED !== 'false',
    host: env.MCP_EMAIL_SIEVE_HOST || undefined,
    port: env.MCP_EMAIL_SIEVE_PORT ? parseInt(env.MCP_EMAIL_SIEVE_PORT, 10) : undefined,
    tls: env.MCP_EMAIL_SIEVE_TLS === 'true',
    starttls: env.MCP_EMAIL_SIEVE_STARTTLS !== 'false',
  };
}

// ---------------------------------------------------------------------------
// TOML file loader
// ---------------------------------------------------------------------------

/**
 * One line for a TOML syntax error: the position only. smol-toml's own message
 * quotes the lines around the error, which can include a plaintext password.
 */
export function describeTomlError(err: unknown): string {
  const { line, column } = (err ?? {}) as { line?: unknown; column?: unknown };
  if (typeof line === 'number' && typeof column === 'number') {
    return `TOML syntax error at line ${line}, column ${column}.`;
  }
  return 'TOML syntax error.';
}

function isTomlError(err: unknown): boolean {
  const e = err as { line?: unknown; column?: unknown; codeblock?: unknown } | null;
  return typeof e?.line === 'number' && typeof e?.column === 'number' && 'codeblock' in (e ?? {});
}

async function loadFromFile(filePath: string = CONFIG_FILE): Promise<RawAppConfig | null> {
  try {
    const content = await fs.readFile(filePath, 'utf-8');
    const parsed = parseTOML(content);
    return parsed as unknown as RawAppConfig;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    const reason = isTomlError(err) ? describeTomlError(err) : (err as Error).message;
    throw new Error(`Configuration file at ${filePath} is invalid: ${reason}`);
  }
}

// ---------------------------------------------------------------------------
// Normalize raw config → typed AppConfig
// ---------------------------------------------------------------------------

function normalizeOAuth2(raw: NonNullable<RawAccountConfig['oauth2']>): OAuth2Config {
  return {
    provider: raw.provider,
    clientId: raw.client_id,
    clientSecret: raw.client_secret,
    refreshToken: raw.refresh_token,
    tokenUrl: raw.token_url,
    authUrl: raw.auth_url,
    scopes: raw.scopes,
  };
}

async function normalizeAccount(raw: RawAccountConfig): Promise<AccountConfig> {
  // password_command wins over an inline password: the explicit, more secure
  // field must not be silently defeated by a plaintext line left behind
  // during migration.
  let password = raw.password;
  let credentialError: string | undefined;
  if (raw.password_command) {
    try {
      password = await resolvePasswordCommand(raw.password_command, raw.name);
    } catch (err) {
      // One locked vault must not stop every other account from starting.
      password = undefined;
      credentialError = `its password_command failed: ${err instanceof Error ? err.message : String(err)}`;
      console.error(`Warning: account "${raw.name}" cannot log in: ${credentialError}`);
    }
  }

  return {
    name: raw.name,
    ...(credentialError ? { credentialError } : {}),
    email: raw.email,
    fullName: raw.full_name,
    username: raw.username ?? raw.email,
    password,
    passwordCommand: raw.password_command,
    maxAttachmentMb: raw.max_attachment_mb,
    oauth2: raw.oauth2 ? normalizeOAuth2(raw.oauth2) : undefined,
    imap: {
      host: raw.imap.host,
      port: raw.imap.port,
      tls: raw.imap.tls,
      // Implicit TLS and STARTTLS cannot both apply to one connection; tls wins.
      starttls: raw.imap.starttls && !raw.imap.tls,
      verifySsl: raw.imap.verify_ssl,
    },
    smtp: {
      host: raw.smtp.host,
      port: raw.smtp.port,
      tls: raw.smtp.tls,
      starttls: raw.smtp.starttls,
      verifySsl: raw.smtp.verify_ssl,
      pool: {
        enabled: raw.smtp.pool.enabled,
        maxConnections: raw.smtp.pool.max_connections,
        maxMessages: raw.smtp.pool.max_messages,
      },
    },
    sieve: raw.sieve
      ? {
          enabled: raw.sieve.enabled,
          host: raw.sieve.host,
          port: raw.sieve.port,
          tls: raw.sieve.tls,
          starttls: raw.sieve.starttls,
        }
      : undefined,
  };
}

/** One at a time, so password manager prompts do not pile up on screen at once. */
async function normalizeAccounts(raw: RawAccountConfig[]): Promise<AccountConfig[]> {
  const accounts: AccountConfig[] = [];
  for (const account of raw) {
    accounts.push(await normalizeAccount(account));
  }
  return accounts;
}

function normalizeHookRule(raw: {
  name: string;
  match: Record<string, string | undefined>;
  actions: Record<string, unknown>;
}): HookRule {
  return {
    name: raw.name,
    match: {
      from: raw.match.from,
      to: raw.match.to,
      subject: raw.match.subject,
    },
    actions: {
      labels: Array.isArray(raw.actions.labels) ? (raw.actions.labels as string[]) : undefined,
      flag: typeof raw.actions.flag === 'boolean' ? raw.actions.flag : undefined,
      markRead: typeof raw.actions.mark_read === 'boolean' ? raw.actions.mark_read : undefined,
      alert: typeof raw.actions.alert === 'boolean' ? raw.actions.alert : undefined,
      addToCalendar:
        typeof raw.actions.add_to_calendar === 'boolean' ? raw.actions.add_to_calendar : undefined,
    },
  };
}

async function normalizeConfig(raw: RawAppConfig): Promise<AppConfig> {
  for (const account of raw.accounts) {
    if (account.imap.tls && account.imap.starttls) {
      console.error(`Warning: ${imapTlsConflictWarning(account.name)}`);
    }
  }
  return {
    settings: {
      rateLimit: raw.settings.rate_limit,
      send: {
        maxAttachmentMb: raw.settings.send.max_attachment_mb,
      },
      idleExit: raw.settings.idle_exit,
      readOnly: raw.settings.read_only,
      toolset: raw.settings.toolset,
      cache: {
        enabled: raw.settings.cache.enabled,
        mailboxes: raw.settings.cache.mailboxes,
        windowDays: raw.settings.cache.window_days,
        readThrough: raw.settings.cache.read_through,
        offlineReads: raw.settings.cache.offline_reads,
        bodyMaxMb: raw.settings.cache.body_max_mb,
        bodyMessages: raw.settings.cache.body_messages,
        maxSizeMb: raw.settings.cache.max_size_mb,
        syncInterval: raw.settings.cache.sync_interval,
      },
      watcher: {
        enabled: raw.settings.watcher.enabled,
        folders: raw.settings.watcher.folders,
        idleTimeout: raw.settings.watcher.idle_timeout,
      },
      verification: {
        enabled: raw.settings.verification.enabled,
        includeMagicLinks: raw.settings.verification.include_magic_links,
      },
      hooks: {
        onNewEmail: raw.settings.hooks.on_new_email,
        preset: raw.settings.hooks.preset,
        autoLabel: raw.settings.hooks.auto_label,
        autoFlag: raw.settings.hooks.auto_flag,
        batchDelay: raw.settings.hooks.batch_delay,
        customInstructions: raw.settings.hooks.custom_instructions,
        systemPrompt: raw.settings.hooks.system_prompt,
        rules: (raw.settings.hooks.rules ?? []).map(normalizeHookRule),
        alerts: {
          desktop: raw.settings.hooks.alerts?.desktop ?? false,
          sound: raw.settings.hooks.alerts?.sound ?? false,
          urgencyThreshold: raw.settings.hooks.alerts?.urgency_threshold ?? 'high',
          webhookUrl: raw.settings.hooks.alerts?.webhook_url ?? '',
          webhookEvents: raw.settings.hooks.alerts?.webhook_events ?? ['urgent', 'high'],
        },
        autoCalendar: raw.settings.hooks.auto_calendar ?? false,
        calendarName: raw.settings.hooks.calendar_name ?? '',
        calendarAlarmMinutes: raw.settings.hooks.calendar_alarm_minutes ?? 15,
        calendarConfirm: raw.settings.hooks.calendar_confirm ?? true,
      },
    },
    sieve: {
      allowedRedirects: [...(raw.sieve?.allowed_redirects ?? [])],
      allowedPrograms: [...(raw.sieve?.allowed_programs ?? [])],
    },
    accounts: await normalizeAccounts(raw.accounts),
  };
}

// ---------------------------------------------------------------------------
// Keychain password resolution
// ---------------------------------------------------------------------------

/**
 * Walk through accounts and resolve any keychain sentinel passwords.
 * A sentinel looks like `use_keychain:<account-name>`.
 * The actual password is fetched from macOS Keychain at runtime.
 */
async function resolveKeychainPasswords(accounts: AccountConfig[]): Promise<void> {
  const stored = accounts.filter((account) => isKeychainSentinel(account.password));
  if (stored.length === 0) return;
  const available = await keychainAvailable();

  for (const account of stored) {
    const keychainAccount = keychainSentinelAccount(account.password as string);
    let resolved: string | null = null;
    if (available) {
      try {
        resolved = await keychainGet(keychainAccount);
      } catch {
        resolved = null;
      }
    }
    if (resolved) {
      account.password = resolved;
      continue;
    }
    // Never log in with the placeholder text: the server would count each try
    // as a wrong password, and some lock the account after a few.
    account.password = undefined;
    account.credentialError = available
      ? `its password is stored in the Keychain as "${keychainAccount}" but was not found there. Run 'imap-wizard keychain migrate' to fix.`
      : `its password is stored in the Keychain as "${keychainAccount}", and no Keychain can be read on this system.`;
    console.error(`Warning: account "${account.name}" cannot log in: ${account.credentialError}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Unknown keys are ignored when the config loads, so a typo such as
 * `read_onyl = true` would quietly drop the setting. Say so at every start.
 */
function warnUnknownKeys(raw: unknown, filePath: string): void {
  for (const { path: key, suggestion } of findUnknownKeys(raw)) {
    console.error(
      `Warning: ${filePath} has an unknown key "${key}", which is ignored${
        suggestion ? ` (did you mean "${suggestion}"?)` : ''
      }.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Load raw (snake_case) config from TOML file without normalization.
 * Useful for read-modify-write operations in CLI commands.
 * Throws if no config file exists or validation fails.
 */
export async function loadRawConfig(configPath?: string): Promise<RawAppConfig> {
  const filePath = configPath ?? CONFIG_FILE;
  const fileConfig = await loadFromFile(filePath);
  if (!fileConfig) {
    throw new Error(`No config file found at: ${filePath}`);
  }
  return AppConfigFileSchema.parse(fileConfig);
}

/**
 * Load and validate configuration from env vars or TOML file.
 * Throws on validation errors.
 */
export async function loadConfig(configPath?: string): Promise<AppConfig> {
  const filePath = configPath ?? CONFIG_FILE;

  // 1. Try environment variables first
  const envConfig = loadFromEnv();
  if (envConfig) {
    // The account comes from the environment, but config.toml still decides the
    // settings: its read_only, toolset and limits must not be lost because an
    // MCP client config also set the account variables.
    let merged = envConfig;
    const fileConfig = await loadFromFile(filePath);
    if (fileConfig && isPlainObject((fileConfig as { settings?: unknown }).settings)) {
      const loose = await warnOnLooseConfigPermissions(filePath);
      if (loose) console.error(`Warning: ${loose}`);
      warnUnknownKeys({ settings: fileConfig.settings }, filePath);
      merged = { ...envConfig, settings: fileConfig.settings };
      console.error(
        `Note: the account comes from the MCP_EMAIL_* environment variables; settings come from ${filePath}.`,
      );
    }
    const validated = AppConfigFileSchema.parse(merged);
    // Read-only from either place wins: it only ever takes power away.
    if (envConfig.settings.read_only) validated.settings.read_only = true;
    const config = await normalizeConfig(validated);
    await resolveKeychainPasswords(config.accounts);
    return config;
  }

  // 2. Fall back to TOML config file
  const fileConfig = await loadFromFile(filePath);
  if (fileConfig) {
    const loose = await warnOnLooseConfigPermissions(filePath);
    if (loose) console.error(`Warning: ${loose}`);
    warnUnknownKeys(fileConfig, filePath);
    const validated = AppConfigFileSchema.parse(fileConfig);
    const config = await normalizeConfig(validated);
    await resolveKeychainPasswords(config.accounts);
    return config;
  }

  throw new Error(
    `No configuration found.\n\n` +
      `Set environment variables (MCP_EMAIL_ADDRESS, MCP_EMAIL_PASSWORD, etc.)\n` +
      `or create a config file at: ${configPath ?? CONFIG_FILE}\n\n` +
      `Run 'imap-wizard setup' for interactive configuration.`,
  );
}

/**
 * The forwarding allowlist (`[sieve] allowed_redirects`), read fresh from the
 * environment or config.toml. Only a person edits it, so a change must apply
 * to a running process: a forward or a Sieve scan reads it here every time
 * instead of trusting the copy loaded at start-up. Anything that cannot be
 * read with certainty gives an empty list, which allows nothing.
 */
export async function readAllowedRedirects(configPath?: string): Promise<string[]> {
  return readSieveList('allowed_redirects', configPath);
}

/**
 * The Sieve `filter` program allowlist (`[sieve] allowed_programs`), read fresh
 * like the redirect list. An unreadable file gives an empty list: `filter` is refused.
 */
export async function readAllowedPrograms(configPath?: string): Promise<string[]> {
  return readSieveList('allowed_programs', configPath);
}

async function readSieveList(
  key: 'allowed_redirects' | 'allowed_programs',
  configPath?: string,
): Promise<string[]> {
  try {
    const fromEnv = loadFromEnv();
    const raw = fromEnv ?? (await loadFromFile(configPath));
    const list = (raw as { sieve?: Record<string, unknown> } | null)?.sieve?.[key];
    return Array.isArray(list) ? list.filter((a): a is string => typeof a === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * Write a config file safely: to a temp file in the same folder, then rename,
 * so a crash mid-write can never leave a half-written or empty config. The
 * file being replaced is kept as `<file>.bak` (same folder, same 0600 mode),
 * so one bad edit never costs the only copy.
 */
async function writeConfigText(filePath: string, text: string): Promise<void> {
  const dir = path.dirname(filePath);
  // This file holds plaintext IMAP/SMTP passwords and OAuth refresh tokens.
  // Default umask gives it 0644, readable by every account on the machine.
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, text, { encoding: 'utf-8', mode: 0o600 });
    try {
      await fs.copyFile(filePath, `${filePath}.bak`);
      await fs.chmod(`${filePath}.bak`, 0o600);
    } catch {
      // No existing file to keep (first write), or it is unreadable.
    }
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
  // `mode` on writeFile only applies when the file is created, so make the
  // final file owner-only whatever it was before.
  await fs.chmod(filePath, 0o600);
}

/**
 * Save configuration to a TOML file. This regenerates the whole file, so
 * comments and keys this version does not know are not carried over; the
 * previous file is kept as `<file>.bak`.
 */
export async function saveConfig(
  config: RawAppConfig,
  filePath: string = CONFIG_FILE,
): Promise<void> {
  await writeConfigText(filePath, stringifyTOML(config as Record<string, unknown>));
}

/**
 * Add one account to an existing config file by appending its TOML text, so
 * every comment, unknown key and setting already in the file stays exactly
 * as it was. The result is parsed and schema-checked before it replaces the
 * file; on any failure the file is untouched.
 */
export async function appendAccountToConfig(
  account: RawAccountConfig,
  filePath: string = CONFIG_FILE,
): Promise<RawAppConfig> {
  const existing = await fs.readFile(filePath, 'utf-8');
  const addition = stringifyTOML({ accounts: [account] } as Record<string, unknown>);
  const next = `${existing.replace(/\s+$/, '')}\n\n${addition}`;
  const checked = AppConfigFileSchema.parse(parseTOML(next));
  await writeConfigText(filePath, next);
  return checked;
}

/**
 * Warn when an existing config is readable by anyone but its owner.
 *
 * Tightening it automatically would be the wrong call: the file may be
 * deliberately group-readable for a service account, and silently changing
 * permissions under someone is worse than telling them.
 *
 * No-ops on Windows, where POSIX mode bits do not mean this.
 */
export async function warnOnLooseConfigPermissions(
  filePath: string = CONFIG_FILE,
): Promise<string | null> {
  if (process.platform === 'win32') return null;
  try {
    const stats = await fs.stat(filePath);
    // eslint-disable-next-line no-bitwise
    const looseBits = stats.mode & 0o077;
    if (looseBits === 0) return null;
    // eslint-disable-next-line no-bitwise
    const mode = (stats.mode & 0o777).toString(8).padStart(3, '0');
    return (
      `Config at ${filePath} is mode ${mode} and holds plaintext credentials. ` +
      `Restrict it with: chmod 600 ${filePath}`
    );
  } catch {
    return null;
  }
}

/**
 * Generate a template TOML config string.
 */
export function generateTemplate(): string {
  return `# IMAP Wizard configuration
# Location: ${CONFIG_FILE}

[settings]
rate_limit = 10  # max emails per minute per account
idle_exit = 0  # seconds without MCP requests before the stdio server exits (0 = never)
read_only = false  # set to true to disable all write operations
toolset = "full"  # "full" (all tools), "core" (everyday mail work) or "minimal" (triage and read)

[settings.send]
max_attachment_mb = 25  # base64-encoded attachment total per message, MB

# Local mirror — keeps a SQLite copy of mail under $XDG_CACHE_HOME/email-mcp
# so reads are fast and still work while briefly offline. On by default; the
# mirror is regenerable, so deleting it is always safe.
# [settings.cache]
# enabled = true          # set false to always read live from IMAP
# mailboxes = ["INBOX"]   # synced in the background; others cache on read
# window_days = 90        # how far back to mirror (0 = no limit)
# body_messages = 500     # backfill bodies for the newest N messages (0 = off)
# read_through = false    # serve repeat get_email reads from the local body cache
# offline_reads = true    # with read_through on, serve cached bodies when the server is unreachable
# body_max_mb = 200       # LRU budget for cached bodies, inside max_size_mb
# max_size_mb = 500       # backstop on mirror size
# sync_interval = 300     # seconds between background reconciles

# [settings.watcher]
# enabled = false        # enable IMAP IDLE real-time monitoring
# folders = ["INBOX"]    # folders to watch per account
# idle_timeout = 1740    # seconds (29 min, IMAP max is 30)

# On-demand OTP lookup. Disabled by default; no background inbox scanning.
# [settings.verification]
# enabled = false
# include_magic_links = false  # also return sign-in links when explicitly requested

# [settings.hooks]
# on_new_email = "notify"  # "triage" (AI) | "notify" (log) | "none"
# preset = "priority-focus" # "inbox-zero" | "gtd" | "priority-focus" | "notification-only" | "custom"
# auto_label = false       # auto-apply AI-suggested labels
# auto_flag = false        # auto-flag urgent emails
# batch_delay = 5          # seconds to batch before processing
# custom_instructions = "I'm a software engineer. Emails from @company.com are high priority."
# system_prompt = ""       # full override (only when preset = "custom")

# Static rules — run BEFORE AI triage, skip AI if matched
# [[settings.hooks.rules]]
# name = "GitHub Notifications"
# match = { from = "*@github.com" }
# actions = { labels = ["Dev"], mark_read = true }
#
# [[settings.hooks.rules]]
# name = "VIP Contacts"
# match = { from = "ceo@company.com" }
# actions = { flag = true, alert = true, labels = ["VIP"] }

# [settings.hooks.alerts]
# desktop = false         # enable OS-level desktop notifications
# sound = false           # play sound for urgent emails
# urgency_threshold = "high" # minimum priority: "urgent" | "high" | "normal" | "low"
# webhook_url = ""        # HTTP POST to Slack/Discord/ntfy.sh/etc.
# webhook_events = ["urgent", "high"]  # which priorities trigger webhook

# Mail filter rules. Forwarding (Sieve redirect, notify mailto:, and the local
# rule forward action) is allowed ONLY to the addresses or domains listed here.
# Edit this list yourself: no IMAP Wizard tool can change it, and no tool
# argument can get around it. A domain does not cover its subdomains.
# The Sieve filter command hands mail to a program on the server. It is refused
# unless the program is named here (also edited by you only).
# [sieve]
# allowed_redirects = ["me@example.org", "example.net"]
# allowed_programs = ["my-filter-program"]

[[accounts]]
name = "personal"
email = "you@example.com"
full_name = "Your Name"
# username defaults to email if omitted
# username = "you@example.com"
password = "your-app-password"
# max_attachment_mb = 40  # optional per-account attachment limit override

[accounts.imap]
host = "imap.example.com"
port = 993
tls = true
starttls = false
verify_ssl = true

[accounts.smtp]
host = "smtp.example.com"
port = 465
tls = true
starttls = false
verify_ssl = true

[accounts.smtp.pool]
enabled = true
max_connections = 1
max_messages = 100

# Server-side filter rules (Sieve over ManageSieve). Without this block the
# IMAP host is tried on port 4190 with STARTTLS. Gmail, Outlook, iCloud and
# most large providers have no ManageSieve: use local rules there.
# [accounts.sieve]
# enabled = true
# host = "imap.example.com"
# port = 4190
# tls = false       # implicit TLS from the first byte (wins over starttls)
# starttls = true   # upgrade before logging in; certificates are always checked
`;
}

/**
 * Check if a config file exists at the default XDG path.
 */
export async function configExists(filePath: string = CONFIG_FILE): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

/** Re-export for convenience */
export { CONFIG_FILE, xdg };
