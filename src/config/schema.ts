/**
 * Zod schemas for configuration validation.
 */

import { z } from 'zod';

import { parseAllowlistEntry } from '../safety/redirect-allowlist.js';
import { isLoopbackHost, LOOPBACK_HOSTS_TEXT } from '../utils/loopback.js';

export const ImapConfigSchema = z.object({
  host: z.string().min(1, 'IMAP host is required'),
  port: z.number().int().min(1).max(65535).default(993),
  tls: z.boolean().default(true),
  starttls: z.boolean().default(false),
  verify_ssl: z.boolean().default(true),
});

export const SmtpConfigSchema = z.object({
  host: z.string().min(1, 'SMTP host is required'),
  port: z.number().int().min(1).max(65535).default(465),
  tls: z.boolean().default(true),
  starttls: z.boolean().default(false),
  verify_ssl: z.boolean().default(true),
  pool: z
    .object({
      enabled: z.boolean().default(true),
      max_connections: z.number().int().min(1).default(1),
      max_messages: z.number().int().min(1).default(100),
    })
    // Factory defaults: a static object here would be one shared instance
    // across every parse in the process — a mutation on one parsed config
    // would poison later loads (ported from upstream bf09dcc).
    .default(() => ({
      enabled: true,
      max_connections: 1,
      max_messages: 100,
    })),
});

export const OAuth2ConfigSchema = z.object({
  provider: z.enum(['google', 'microsoft', 'custom']),
  client_id: z.string().min(1, 'OAuth2 client_id is required'),
  client_secret: z.string().min(1, 'OAuth2 client_secret is required'),
  refresh_token: z.string().min(1, 'OAuth2 refresh_token is required'),
  // Custom provider endpoints (only when provider = "custom")
  token_url: z
    .string()
    .url()
    .refine((v) => v.startsWith('https://'), 'token_url must be https')
    .optional(),
  auth_url: z
    .string()
    .url()
    .refine((v) => v.startsWith('https://'), 'auth_url must be https')
    .optional(),
  scopes: z.array(z.string()).optional(),
});

/**
 * Per-account ManageSieve endpoint. Without this block the server is probed at the
 * IMAP host, port 4190, with STARTTLS.
 */
export const SieveAccountConfigSchema = z.object({
  enabled: z.boolean().default(true),
  host: z.string().min(1, 'Sieve host cannot be empty').optional(),
  port: z.number().int().min(1).max(65535).optional(),
  tls: z.boolean().default(false),
  starttls: z.boolean().default(true),
});

export const AccountConfigSchema = z
  .object({
    name: z.string().min(1, 'Account name is required'),
    email: z.string().email('Invalid email address'),
    full_name: z.string().optional(),
    username: z.string().optional(),
    password: z.string().optional(),
    /** Shell command whose trimmed stdout is used as the password. */
    password_command: z.string().min(1, 'password_command cannot be empty').optional(),
    /** Override the effective outbound attachment cap for this account, in MB. */
    max_attachment_mb: z.number().int().min(1).optional(),
    /**
     * File a copy of each sent message in the Sent folder over IMAP. Default:
     * on, except for Gmail, which files SMTP sends in Sent itself.
     */
    append_sent: z.boolean().optional(),
    oauth2: OAuth2ConfigSchema.optional(),
    imap: ImapConfigSchema,
    smtp: SmtpConfigSchema,
    sieve: SieveAccountConfigSchema.optional(),
  })
  // Boolean() rather than a ?? chain: ?? short-circuits on non-nullish, so a
  // leftover `password = ""` would swallow a valid password_command.
  .refine(
    (data) => Boolean(data.password) || Boolean(data.password_command) || Boolean(data.oauth2),
    { message: 'Either password_command, password or oauth2 config is required' },
  )
  // The login crosses this connection; with neither TLS nor STARTTLS only a
  // loopback host keeps it on the machine.
  // Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225),
  // Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
  .superRefine((account, ctx) => {
    (
      [
        ['imap', 'IMAP'],
        ['smtp', 'SMTP'],
      ] as const
    ).forEach(([protocol, label]) => {
      const { host, tls, starttls } = account[protocol];
      // A blank host already carries its own issue.
      if (!tls && !starttls && host.trim() !== '' && !isLoopbackHost(host)) {
        ctx.addIssue({
          code: 'custom',
          path: [protocol, 'tls'],
          message: `Account ${JSON.stringify(account.name)}: ${label} to ${JSON.stringify(host)} would be unencrypted (tls = false and starttls = false). Set tls = true or starttls = true, or use a loopback host (${LOOPBACK_HOSTS_TEXT}).`,
        });
      }
    });
    // ManageSieve logs in with the same credentials.
    const { sieve } = account;
    if (sieve?.enabled && !sieve.tls && !sieve.starttls) {
      const host = sieve.host ?? account.imap.host;
      if (host.trim() !== '' && !isLoopbackHost(host)) {
        ctx.addIssue({
          code: 'custom',
          path: ['sieve', 'tls'],
          message: `Account ${JSON.stringify(account.name)}: ManageSieve to ${JSON.stringify(host)} would be unencrypted (tls = false and starttls = false). Set tls = true or starttls = true, or use a loopback host (${LOOPBACK_HOSTS_TEXT}).`,
        });
      }
    }
  });

/**
 * Global Sieve settings. `allowed_redirects` is the only thing that can allow a
 * standing forward (Sieve redirect, notify mailto:, or a local rule). A human
 * edits it in this file; no tool writes it. One-off sends (send_email,
 * forward_email and the like) are not limited by it.
 */
export const SieveGlobalConfigSchema = z.object({
  allowed_redirects: z
    .array(z.string())
    .default(() => [])
    .superRefine((entries, ctx) => {
      entries.forEach((entry, index) => {
        const parsed = parseAllowlistEntry(entry);
        if ('error' in parsed) {
          ctx.addIssue({ code: 'custom', path: [index], message: parsed.error });
        }
      });
    }),
  /**
   * Server programs the Sieve `filter` command may run (names as the script writes
   * them). Empty means `filter` is refused. A human edits this; no tool writes it.
   */
  allowed_programs: z.array(z.string()).default(() => []),
});

export const WatcherConfigSchema = z.object({
  enabled: z.boolean().default(false),
  folders: z.array(z.string()).default(() => ['INBOX']),
  idle_timeout: z.number().int().min(60).max(1740).default(1740),
});

/** On-demand verification-code lookup is deliberately disabled by default. */
export const VerificationConfigSchema = z.object({
  enabled: z.boolean().default(false),
  /** Allow the on-demand tool to return sign-in links as well as numeric codes. */
  include_magic_links: z.boolean().default(false),
});

export const HookRuleMatchSchema = z.object({
  from: z.string().optional(),
  to: z.string().optional(),
  subject: z.string().optional(),
});

export const HookRuleActionsSchema = z.object({
  labels: z.array(z.string()).optional(),
  flag: z.boolean().optional(),
  mark_read: z.boolean().optional(),
  alert: z.boolean().optional(),
  add_to_calendar: z.boolean().optional(),
});

export const HookRuleSchema = z.object({
  name: z.string().min(1, 'Rule name is required'),
  match: HookRuleMatchSchema,
  actions: HookRuleActionsSchema,
});

export const AlertsConfigSchema = z.object({
  desktop: z.boolean().default(false),
  sound: z.boolean().default(false),
  urgency_threshold: z.enum(['urgent', 'high', 'normal', 'low']).default('high'),
  webhook_url: z.string().default(''),
  webhook_events: z
    .array(z.enum(['urgent', 'high', 'normal', 'low']))
    .default((): ('urgent' | 'high' | 'normal' | 'low')[] => ['urgent', 'high']),
});

export const HooksConfigSchema = z.object({
  on_new_email: z.enum(['triage', 'notify', 'none']).default('notify'),
  preset: z
    .enum(['inbox-zero', 'gtd', 'priority-focus', 'notification-only', 'custom'])
    .default('priority-focus'),
  auto_label: z.boolean().default(false),
  auto_flag: z.boolean().default(false),
  batch_delay: z.number().int().min(1).max(60).default(5),
  custom_instructions: z.string().optional(),
  system_prompt: z.string().optional(),
  rules: z.array(HookRuleSchema).default(() => []),
  alerts: AlertsConfigSchema.default(
    (): z.infer<typeof AlertsConfigSchema> => ({
      desktop: false,
      sound: false,
      urgency_threshold: 'high',
      webhook_url: '',
      webhook_events: ['urgent', 'high'],
    }),
  ),
  auto_calendar: z.boolean().default(false),
  calendar_name: z.string().default(''),
  calendar_alarm_minutes: z.number().int().min(0).max(1440).default(15),
  calendar_confirm: z.boolean().default(true),
});

/**
 * Local mirror settings.
 *
 * Defaults are deliberately conservative: mirroring INBOX only, 90 days back.
 * Measured against a real 170-message mailbox this costs well under a
 * megabyte, so `max_size_mb` is a backstop rather than an expected limit.
 */
export const CacheConfigSchema = z.object({
  enabled: z.boolean().default(true),
  /** Mailboxes synced proactively. Others are still cached when read. */
  mailboxes: z.array(z.string()).default(() => ['INBOX']),
  /** How far back to mirror. 0 means no limit. */
  window_days: z.number().int().min(0).default(90),
  /**
   * Serve repeat get_email reads from the local body cache and write bodies
   * back. Off means the live path exactly as before.
   */
  read_through: z.boolean().default(false),
  /** With read_through on and the server unreachable, serve cached bodies with a warning. */
  offline_reads: z.boolean().default(true),
  /** LRU budget for cached bodies, inside max_size_mb. */
  body_max_mb: z.number().int().min(1).default(200),
  /** Backfill bodies for the newest N messages per synced mailbox; 0 disables backfill. */
  body_messages: z.number().int().min(0).default(500),
  /** Backstop on mirror size. */
  max_size_mb: z.number().int().min(1).default(500),
  /** Seconds between background reconciles. */
  sync_interval: z.number().int().min(30).default(300),
});

export const ToolsetSchema = z.enum(['full', 'core', 'minimal']);
export const ToolGroupSchema = z.enum(['read', 'send', 'organize', 'rules', 'calendar', 'alerts']);

export const SettingsSchema = z.object({
  rate_limit: z.number().int().min(1).default(10),
  send: z
    .object({
      /** Maximum base64-encoded attachment bytes per outbound message, in MB. */
      max_attachment_mb: z.number().int().min(1).default(25),
    })
    .default(() => ({ max_attachment_mb: 25 })),
  // Seconds without an MCP request before the stdio server exits on its own.
  // 0 (the default) disables: stdin EOF is the primary lifecycle signal, so a
  // host that closes the pipe does not need a timer. Set a positive value only
  // as a backstop for hosts that never close it.
  idle_exit: z.number().int().min(0).max(86_400).default(0),
  read_only: z.boolean().default(false),
  // Which tools the server registers: "full" (everything, the default),
  // "core" (read, send and everyday mail management) or "minimal" (triage
  // and read). read_only still removes write tools within any toolset.
  toolset: ToolsetSchema.default('full'),
  // A finer choice than toolset: the tool groups to turn on, as ticked in
  // `imap-wizard tools`. When present it wins over toolset. "read" is always
  // added. Absent (the default) means toolset decides.
  tools: z.array(ToolGroupSchema).optional(),
  cache: CacheConfigSchema.default(() => ({
    enabled: true,
    mailboxes: ['INBOX'],
    window_days: 90,
    read_through: false,
    offline_reads: true,
    body_max_mb: 200,
    body_messages: 500,
    max_size_mb: 500,
    sync_interval: 300,
  })),
  watcher: WatcherConfigSchema.default(() => ({
    enabled: false,
    folders: ['INBOX'],
    idle_timeout: 1740,
  })),
  verification: VerificationConfigSchema.default(() => ({
    enabled: false,
    include_magic_links: false,
  })),
  hooks: HooksConfigSchema.default(
    (): z.infer<typeof HooksConfigSchema> => ({
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
    }),
  ),
});

export const AppConfigFileSchema = z.object({
  settings: SettingsSchema.default(
    (): z.infer<typeof SettingsSchema> => ({
      rate_limit: 10,
      send: { max_attachment_mb: 25 },
      idle_exit: 0,
      read_only: false,
      toolset: 'full',
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
        enabled: false,
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
    }),
  ),
  sieve: SieveGlobalConfigSchema.default(() => ({ allowed_redirects: [], allowed_programs: [] })),
  accounts: z.array(AccountConfigSchema).min(1, 'At least one account is required'),
});

export type RawAccountConfig = z.infer<typeof AccountConfigSchema>;
export type RawAppConfig = z.infer<typeof AppConfigFileSchema>;
