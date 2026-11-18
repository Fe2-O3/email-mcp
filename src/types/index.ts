/**
 * Shared TypeScript types for IMAP Wizard.
 */

// ---------------------------------------------------------------------------
// Address
// ---------------------------------------------------------------------------

export interface EmailAddress {
  name?: string;
  address: string;
}

// ---------------------------------------------------------------------------
// Account
// ---------------------------------------------------------------------------

export interface Account {
  name: string;
  email: string;
  fullName?: string;
}

export interface ImapConfig {
  host: string;
  port: number;
  tls: boolean;
  starttls: boolean;
  verifySsl: boolean;
}

export interface SmtpConfig {
  host: string;
  port: number;
  tls: boolean;
  starttls: boolean;
  verifySsl: boolean;
  pool?: {
    enabled: boolean;
    maxConnections: number;
    maxMessages: number;
  };
}

// ---------------------------------------------------------------------------
// Authentication
// ---------------------------------------------------------------------------

export interface OAuth2Config {
  provider: 'google' | 'microsoft' | 'custom';
  clientId: string;
  clientSecret: string;
  refreshToken: string;
  accessToken?: string;
  tokenExpiry?: number;
  // Custom provider endpoints (only when provider = "custom")
  tokenUrl?: string;
  authUrl?: string;
  scopes?: string[];
}

export interface AccountConfig {
  name: string;
  email: string;
  fullName?: string;
  username: string;
  password?: string;
  /** Command that produced `password`. Diagnostic only — never the secret. */
  passwordCommand?: string;
  /** Optional per-account outbound attachment cap in MB. */
  maxAttachmentMb?: number;
  oauth2?: OAuth2Config;
  imap: ImapConfig;
  smtp: SmtpConfig;
  /** ManageSieve settings. Absent means auto-detect from the IMAP host. */
  sieve?: SieveAccountConfig;
}

/** Per-account ManageSieve (RFC 5804) endpoint. */
export interface SieveAccountConfig {
  enabled: boolean;
  /** Defaults to the IMAP host. */
  host?: string;
  /** Defaults to 4190. */
  port?: number;
  /** Implicit TLS from the first byte. Wins over starttls. */
  tls: boolean;
  /** Upgrade with STARTTLS before logging in (the RFC 5804 default). */
  starttls: boolean;
}

/**
 * Global Sieve settings. `allowedRedirects` is edited by a human in config.toml only:
 * no tool reads-modifies-writes it, and no tool argument bypasses it.
 */
export interface SieveGlobalConfig {
  /** Addresses (`a@example.com`) or domains (`example.com`) mail may be forwarded to. */
  allowedRedirects: string[];
  /** Server programs the Sieve `filter` command may run. Empty: `filter` is refused. */
  allowedPrograms?: string[];
}

export interface WatcherConfig {
  enabled: boolean;
  folders: string[];
  idleTimeout: number;
}

export interface VerificationConfig {
  enabled: boolean;
  includeMagicLinks: boolean;
}

// ---------------------------------------------------------------------------
// Hook Rules
// ---------------------------------------------------------------------------

export interface HookRuleMatch {
  from?: string;
  to?: string;
  subject?: string;
}

export interface HookRuleActions {
  labels?: string[];
  flag?: boolean;
  markRead?: boolean;
  alert?: boolean;
  /** Add the email's calendar event to the local calendar (triggers confirmation dialog). */
  addToCalendar?: boolean;
}

export interface HookRule {
  name: string;
  match: HookRuleMatch;
  actions: HookRuleActions;
}

// ---------------------------------------------------------------------------
// Alerts
// ---------------------------------------------------------------------------

export interface AlertsConfig {
  desktop: boolean;
  sound: boolean;
  urgencyThreshold: 'urgent' | 'high' | 'normal' | 'low';
  webhookUrl: string;
  webhookEvents: ('urgent' | 'high' | 'normal' | 'low')[];
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface HooksConfig {
  onNewEmail: 'triage' | 'notify' | 'none';
  preset: 'inbox-zero' | 'gtd' | 'priority-focus' | 'notification-only' | 'custom';
  autoLabel: boolean;
  autoFlag: boolean;
  batchDelay: number;
  customInstructions?: string;
  systemPrompt?: string;
  rules: HookRule[];
  alerts: AlertsConfig;
  /** Automatically add calendar events detected in new emails to the local calendar. */
  autoCalendar?: boolean;
  /** Target calendar name for auto-add (empty = default calendar). */
  calendarName?: string;
  /** Minutes before event to show an alert (default: 15). */
  calendarAlarmMinutes?: number;
  /** Show a native confirmation dialog before adding (default: true). */
  calendarConfirm?: boolean;
}

/** Local mirror settings — see CacheConfigSchema for defaults and rationale. */
export interface CacheConfig {
  enabled: boolean;
  mailboxes: string[];
  windowDays: number;
  readThrough: boolean;
  offlineReads: boolean;
  bodyMaxMb: number;
  bodyMessages: number;
  maxSizeMb: number;
  syncInterval: number;
}

export type Toolset = 'full' | 'core' | 'minimal';

export interface AppConfig {
  settings: {
    rateLimit: number;
    send: {
      maxAttachmentMb: number;
    };
    /** Seconds without an MCP request before the stdio server exits; 0 disables. */
    idleExit: number;
    readOnly: boolean;
    /** Which tools to register: everything, everyday mail work, or triage and read only. */
    toolset: Toolset;
    cache: CacheConfig;
    watcher: WatcherConfig;
    verification: VerificationConfig;
    hooks: HooksConfig;
  };
  /** Absent means an empty forwarding allowlist. */
  sieve?: SieveGlobalConfig;
  accounts: AccountConfig[];
}

// ---------------------------------------------------------------------------
// Mailbox
// ---------------------------------------------------------------------------

export interface Mailbox {
  name: string;
  path: string;
  specialUse?: string;
  /** Undefined when the IMAP STATUS call failed — distinct from a genuinely empty mailbox. */
  totalMessages?: number;
  /** Undefined when the IMAP STATUS call failed — distinct from "nothing unread". */
  unseenMessages?: number;
}

// ---------------------------------------------------------------------------
// Email
// ---------------------------------------------------------------------------

/** How a message was originated, when its headers say so. */
export type BulkKind = 'newsletter' | 'automated';

export interface BulkSignal {
  kind: BulkKind;
  /** RFC 2919 list identifier, without its angle brackets. */
  listId?: string;
  /** Most actionable RFC 2369 unsubscribe URI (https preferred over mailto). */
  unsubscribe?: string;
  /** RFC 8058 one-click unsubscribe is supported. */
  oneClick: boolean;
}

export interface EmailMeta {
  id: string;
  /** RFC 822 Message-ID header. Empty when the sender omitted one. */
  messageId: string;
  subject: string;
  from: EmailAddress;
  to: EmailAddress[];
  date: string;
  seen: boolean;
  flagged: boolean;
  answered: boolean;
  hasAttachments: boolean;
  labels: string[];
  /** Set only for list or machine-generated mail; absent for personal mail. */
  bulk?: BulkSignal;
}

export interface AttachmentMeta {
  filename: string;
  mimeType: string;
  size: number;
}

export interface Email extends EmailMeta {
  cc?: EmailAddress[];
  bcc?: EmailAddress[];
  replyTo?: EmailAddress;
  bodyText?: string;
  bodyHtml?: string;
  messageId: string;
  inReplyTo?: string;
  references?: string[];
  attachments: AttachmentMeta[];
  headers: Record<string, string>;
  /** True when a body part could not be downloaded, so bodyText / bodyHtml may be missing. */
  bodyIncomplete?: boolean;
  /** Set only when served from the local cache because the server was unreachable. */
  offline?: { cachedAt: string };
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

/** What a write tool would do, reported by a dry run. Nothing was changed. */
export interface DryRunPlan {
  summary: string;
  /** Things worth knowing before running it for real. */
  notes: string[];
  /** Lines copied from an email (subject, addresses, file names): shown fenced as untrusted text. */
  fromMessage?: string[];
}

export interface SendResult {
  messageId: string;
  status: 'sent' | 'failed';
  /** Who a reply went to (replies only). */
  to?: string[];
  cc?: string[];
  /** Things the caller should be told about a send that did go out. */
  warnings?: string[];
}

export interface PaginatedResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

// ---------------------------------------------------------------------------
// Bulk Operations
// ---------------------------------------------------------------------------

export interface BulkResult {
  total: number;
  succeeded: number;
  failed: number;
  errors?: string[];
  /** Side effects of a command that did run, such as a plain EXPUNGE. */
  warnings?: string[];
}

// ---------------------------------------------------------------------------
// Contacts
// ---------------------------------------------------------------------------

export interface Contact {
  name?: string;
  email: string;
  frequency: number;
  lastSeen: string;
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEntry {
  ts: string;
  tool: string;
  account: string;
  params: Record<string, unknown>;
  result: 'ok' | 'error';
  error?: string;
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

export interface ThreadResult {
  threadId: string;
  messages: Email[];
  participants: EmailAddress[];
  messageCount: number;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

export interface EmailTemplate {
  name: string;
  description?: string;
  subject: string;
  body: string;
  variables: string[];
}

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export interface ProviderConfig {
  name: string;
  domains: string[];
  imap: ImapConfig;
  smtp: SmtpConfig;
  notes?: string;
  oauth2?: {
    authUrl: string;
    tokenUrl: string;
    scopes: string[];
  };
}

// ---------------------------------------------------------------------------
// Calendar
// ---------------------------------------------------------------------------

export interface CalendarEvent {
  uid: string;
  summary: string;
  description?: string;
  start: string;
  end: string;
  location?: string;
  organizer?: EmailAddress;
  attendees: EmailAddress[];
  status: 'TENTATIVE' | 'CONFIRMED' | 'CANCELLED';
  method?: string;
  recurrence?: string;
}

// ---------------------------------------------------------------------------
// Analytics
// ---------------------------------------------------------------------------

export interface SenderStat {
  email: string;
  name?: string;
  count: number;
}

export interface DailyVolume {
  date: string;
  count: number;
}

export interface EmailStats {
  period: 'day' | 'week' | 'month';
  dateRange: { from: string; to: string };
  totalReceived: number;
  unreadCount: number;
  flaggedCount: number;
  topSenders: SenderStat[];
  dailyVolume: DailyVolume[];
  hasAttachmentsCount: number;
  avgPerDay: number;
}

/** Cheap mailbox counters, from STATUS plus one SEARCH. */
export interface MailboxSnapshot {
  /** Messages in the mailbox. */
  total: number;
  /** Unread messages in the mailbox. */
  unread: number;
  /** Messages whose internal date falls today. */
  receivedToday: number;
}

export interface QuotaInfo {
  usedMb: number;
  totalMb: number;
  percentage: number;
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

export type LabelStrategyType = 'protonmail' | 'gmail' | 'keyword' | 'unsupported';

export interface LabelInfo {
  name: string;
  path?: string;
  strategy: LabelStrategyType;
}

// ---------------------------------------------------------------------------
// Scheduling
// ---------------------------------------------------------------------------

export interface ScheduledEmail {
  id: string;
  account: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  body: string;
  html: boolean;
  sendAt: string;
  createdAt: string;
  sendingAt?: string;
  /**
   * `unknown` means the send may or may not have gone out (a crash or a lost
   * reply). It is never retried: the owner checks Sent, then cancels the job.
   */
  status: 'pending' | 'sending' | 'sent' | 'failed' | 'unknown';
  /** Refusals by the mail server so far (not counted: no connection, rate limit). */
  attempts: number;
  /** Not before this time, after a temporary problem such as no connection. */
  retryAfter?: string;
  /** Temporary problems in a row, used to back off. */
  retries?: number;
  lastError?: string;
  draftMessageId?: string;
  draftMailbox?: string;
  /** UIDVALIDITY of draftMailbox when the draft was saved; cleanup is skipped if it changed. */
  draftUidValidity?: string;
  inReplyTo?: string;
  references?: string[];
  sentAt?: string;
  sentMessageId?: string;
}
