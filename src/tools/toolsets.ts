// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * Toolsets: which tools the server registers.
 *
 *   full    every tool (the default; nothing changes for existing users)
 *   core    minimal plus everyday mail management
 *   minimal just enough to triage, read and answer mail
 *
 * Grouping idea adapted from Mailoo's toolset setting (see NOTICE). The
 * `tools` setting is a finer choice: a list of the groups below. read_only is
 * a separate switch: it still removes the write tools inside any choice.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { ToolGroup, Toolset } from '../types/index.js';

export const MINIMAL_TOOLS: readonly string[] = [
  'list_accounts',
  'list_mailboxes',
  'list_emails',
  'search_emails',
  'get_email',
  'get_thread',
  'send_email',
  'reply_email',
];

export const CORE_TOOLS: readonly string[] = [
  ...MINIMAL_TOOLS,
  'get_emails',
  'get_email_status',
  'mark_email',
  'move_email',
  'delete_email',
  'bulk_action',
  'list_labels',
  'add_label',
  'remove_label',
  'create_label',
  'delete_label',
  'save_draft',
  'send_draft',
  'download_attachment',
  'export_email',
  'forward_email',
];

/**
 * Tool groups: the boxes a person ticks in setup and in `imap-wizard tools`.
 * They are sorted by risk, not by topic, because that is how people decide
 * ("may it send as me?", "may it delete?"). Every tool sits in exactly one
 * group. "read" is always on, because every other group needs it to find mail.
 *
 * Every optional feature is listed, even the rare or risky ones, so people
 * can see it exists. Risky ones start off. `on` is the starting tick.
 */
export const TOOL_GROUPS = {
  read: {
    label: 'Read and search your mail',
    hint: 'always on. Open, search and summarize mail, threads and attachments',
    on: true,
    tools: [
      'list_accounts',
      'list_mailboxes',
      'list_emails',
      'search_emails',
      'get_email',
      'get_emails',
      'get_email_status',
      'get_thread',
      'download_attachment',
      'find_email_folder',
      'get_email_security',
    ],
  },
  drafts: {
    label: 'Write drafts for you to review',
    hint: 'replies stay in the right thread. You press send yourself',
    on: true,
    tools: ['save_draft'],
  },
  send: {
    label: 'Send email as you',
    hint: 'send, reply, forward, schedule. Off: an email it reads could trick it into sending',
    on: false,
    tools: [
      'send_email',
      'reply_email',
      'forward_email',
      'send_draft',
      'schedule_email',
      'list_scheduled',
      'cancel_scheduled',
    ],
  },
  tidy: {
    label: 'Tidy up',
    hint: 'mark read, flag, move, label, make and rename folders',
    on: true,
    tools: [
      'mark_email',
      'move_email',
      'bulk_action',
      'list_labels',
      'add_label',
      'remove_label',
      'create_label',
      'create_mailbox',
      'rename_mailbox',
    ],
  },
  delete: {
    label: 'Delete mail',
    hint: 'to Trash or for good, plus folders and labels. Off: mistakes are hard to undo',
    on: false,
    tools: ['delete_email', 'delete_label', 'delete_mailbox'],
  },
  calendar: {
    label: 'Calendar and reminders',
    hint: 'add invites and reminders to the Calendar and Reminders apps (Mac)',
    on: true,
    tools: [
      'extract_calendar',
      'add_to_calendar',
      'check_calendar_permissions',
      'list_calendars',
      'list_events',
      'list_reminders',
      'create_reminder',
      'analyze_email_for_scheduling',
    ],
  },
  rules: {
    label: 'Filter rules that keep running',
    hint: 'sort new mail by rules. Off: rules run after the chat ends and can forward mail',
    on: false,
    tools: [
      'sieve_status',
      'sieve_list_scripts',
      'sieve_get_script',
      'sieve_check_script',
      'sieve_put_script',
      'sieve_activate_script',
      'sieve_delete_script',
      'list_local_rules',
      'add_local_rule',
      'remove_local_rule',
    ],
  },
  reports: {
    label: 'Reports and exports',
    hint: 'mail stats, your top contacts, save an email as a file',
    on: false,
    tools: ['get_email_stats', 'extract_contacts', 'export_email'],
  },
  templates: {
    label: 'Templates',
    hint: 'fill-in-the-blank messages you save as files. Setup adds an example to start',
    on: false,
    tools: ['list_templates', 'apply_template'],
  },
  alerts: {
    label: 'Alerts and troubleshooting',
    hint: 'let the AI check connections and change new-mail alerts. Alerts work without it',
    on: false,
    tools: [
      'check_health',
      'get_watcher_status',
      'list_presets',
      'get_hooks_config',
      'check_notification_setup',
      'test_notification',
      'configure_alerts',
    ],
  },
  codes: {
    label: 'Sign-in code catcher',
    hint: 'finds the newest login code in your mail. Off: it helps anyone who controls the AI log in as you',
    on: false,
    tools: ['get_verification_code'],
  },
} as const satisfies Record<
  ToolGroup,
  { label: string; hint: string; on: boolean; tools: readonly string[] }
>;

/** Group names in the order they are shown. */
export const TOOL_GROUP_NAMES = Object.keys(TOOL_GROUPS) as ToolGroup[];

/** The starting ticks for a new setup: read, drafts, tidy up, calendar. */
export const DEFAULT_TOOL_GROUPS: readonly ToolGroup[] = TOOL_GROUP_NAMES.filter(
  (name) => TOOL_GROUPS[name].on,
);

/**
 * True when the settings let the sign-in code catcher run. With a `tools`
 * list, the "codes" box decides. Without one, [settings.verification] does.
 */
export function codesAllowed(
  groups: readonly ToolGroup[] | undefined,
  verificationEnabled: boolean,
): boolean {
  return groups ? groups.includes('codes') : verificationEnabled;
}

/** The chosen groups, with "read" added and duplicates dropped, in display order. */
export function normalizeToolGroups(groups: readonly ToolGroup[]): ToolGroup[] {
  const chosen = new Set<ToolGroup>(['read', ...groups]);
  return TOOL_GROUP_NAMES.filter((name) => chosen.has(name));
}

/**
 * The tool names the settings allow, or null when they allow every tool.
 * A `tools` group list, when set, wins over `toolset`.
 */
export function allowedTools(
  toolset: Toolset,
  groups?: readonly ToolGroup[],
): ReadonlySet<string> | null {
  if (groups) {
    return new Set(normalizeToolGroups(groups).flatMap((name) => TOOL_GROUPS[name].tools));
  }
  if (toolset === 'minimal') return new Set(MINIMAL_TOOLS);
  if (toolset === 'core') return new Set(CORE_TOOLS);
  return null;
}

/**
 * Returns a view of the server whose registerTool silently skips tools the
 * toolset does not allow. Every other member passes through untouched.
 */
export function restrictToToolset(
  server: McpServer,
  toolset: Toolset,
  groups?: readonly ToolGroup[],
): McpServer {
  const allowed = allowedTools(toolset, groups);
  if (!allowed) return server;
  return new Proxy(server, {
    get(target, prop) {
      if (prop === 'registerTool') {
        return (name: string, ...rest: unknown[]) => {
          if (!allowed.has(name)) return undefined;
          return (target.registerTool as (...args: unknown[]) => unknown)(name, ...rest);
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
