// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * Toolsets: which tools the server registers.
 *
 *   full    every tool (the default; nothing changes for existing users)
 *   core    minimal plus everyday mail management
 *   minimal just enough to triage, read and answer mail
 *
 * Grouping idea adapted from Mailoo's toolset setting (see NOTICE). read_only
 * is a separate switch: it still removes the write tools inside any toolset.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import type { Toolset } from '../types/index.js';

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
  'mark_email',
  'move_email',
  'delete_email',
  'list_labels',
  'add_label',
  'remove_label',
  'create_label',
  'save_draft',
  'send_draft',
  'download_attachment',
  'export_email',
  'forward_email',
];

/** The tool names a toolset allows, or null when it allows every tool. */
export function allowedTools(toolset: Toolset): ReadonlySet<string> | null {
  if (toolset === 'minimal') return new Set(MINIMAL_TOOLS);
  if (toolset === 'core') return new Set(CORE_TOOLS);
  return null;
}

/**
 * Returns a view of the server whose registerTool silently skips tools the
 * toolset does not allow. Every other member passes through untouched.
 */
export function restrictToToolset(server: McpServer, toolset: Toolset): McpServer {
  const allowed = allowedTools(toolset);
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
