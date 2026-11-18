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
 * Tool groups: the boxes a person ticks in `imap-wizard tools`. Every tool
 * except the opt-in get_verification_code sits in exactly one group. "read"
 * is always on, because every other group needs it to find mail.
 */
export const TOOL_GROUPS = {
  read: {
    label: 'Read mail',
    hint: 'list, search and open mail, threads, attachments',
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
      'export_email',
      'extract_contacts',
      'get_email_stats',
      'check_health',
      'find_email_folder',
      'get_email_security',
      'list_templates',
    ],
  },
  send: {
    label: 'Send and reply',
    hint: 'send, reply, forward, drafts, templates, scheduled sends',
    tools: [
      'send_email',
      'reply_email',
      'forward_email',
      'save_draft',
      'send_draft',
      'apply_template',
      'schedule_email',
      'list_scheduled',
      'cancel_scheduled',
    ],
  },
  organize: {
    label: 'Organize',
    hint: 'move, label, mark, delete, folders',
    tools: [
      'mark_email',
      'move_email',
      'delete_email',
      'bulk_action',
      'list_labels',
      'add_label',
      'remove_label',
      'create_label',
      'delete_label',
      'create_mailbox',
      'rename_mailbox',
      'delete_mailbox',
    ],
  },
  rules: {
    label: 'Filter rules',
    hint: 'Sieve filters on the server, local rules',
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
  calendar: {
    label: 'Calendar and reminders',
    hint: 'invites, events, reminders',
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
  alerts: {
    label: 'Alerts',
    hint: 'new-mail watcher, desktop and webhook alerts',
    tools: [
      'get_watcher_status',
      'list_presets',
      'get_hooks_config',
      'check_notification_setup',
      'test_notification',
      'configure_alerts',
    ],
  },
} as const satisfies Record<ToolGroup, { label: string; hint: string; tools: readonly string[] }>;

/** Group names in the order they are shown. */
export const TOOL_GROUP_NAMES = Object.keys(TOOL_GROUPS) as ToolGroup[];

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
