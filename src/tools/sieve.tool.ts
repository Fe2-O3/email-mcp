// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * MCP tools for server-side filter rules (Sieve over ManageSieve, RFC 5804):
 * sieve_status, sieve_list_scripts, sieve_get_script, sieve_check_script,
 * sieve_put_script, sieve_activate_script, sieve_delete_script.
 *
 * Tool shapes follow Mailoo's sieve tools; the safety rules (allowlist,
 * previews, backups, refusals) are in sieve-manager.service.ts.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type ConnectionManager from '../connections/manager.js';
import audit from '../safety/audit.js';
import { delimitUntrusted } from '../safety/untrusted-content.js';
import type SieveManager from '../services/sieve-manager.service.js';
import type { CheckReport } from '../services/sieve-manager.service.js';
import { describeFindings } from '../services/sieve-scan.js';
import { dryRunParam } from './schema-helpers.js';

const accountParam = z.string().describe('Account name from list_accounts');
const nameParam = z.string().min(1).describe('Script name from sieve_list_scripts');

type TextResult = { isError?: boolean; content: { type: 'text'; text: string }[] };

const text = (body: string, isError = false): TextResult => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: 'text' as const, text: body }],
});

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function checkLines(report: CheckReport): string[] {
  const lines: string[] = [];
  if (!report.server.supported) {
    lines.push('Server syntax check: not offered by this server (CHECKSCRIPT).');
  } else if (report.server.ok) {
    lines.push(
      `Server syntax check: OK${report.server.warnings ? ` with warnings: ${report.server.warnings}` : ''}`,
    );
  } else {
    lines.push('Server syntax check: FAILED', delimitUntrusted(report.server.message));
  }
  const findings = [...report.scan.findings, ...report.folderFindings];
  if (findings.length === 0) {
    lines.push('Risky actions: none found.');
  } else {
    lines.push('Risky actions:', ...describeFindings(findings).map((l) => `- ${l}`));
  }
  return lines;
}

export function registerSieveReadTools(
  server: McpServer,
  connections: ConnectionManager,
  manager: SieveManager,
): void {
  server.registerTool(
    'sieve_status',
    {
      title: 'Server-side rules status',
      description:
        'Check whether an account supports server-side filter rules (Sieve over ManageSieve): ' +
        'capabilities, scripts and which one is active. Providers without ManageSieve (Gmail, ' +
        'Outlook, iCloud and most large providers) get a plain answer pointing to local rules.',
      inputSchema: z.object({ account: accountParam }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ account }) => {
      try {
        const status = await manager.status(connections.getAccount(account));
        const summary = status.available
          ? `Server-side rules are available on ${status.host}:${status.port}. Active script: ${status.active ?? 'none'}.`
          : `Server-side rules are not available. ${status.reason ?? ''}`.trim();
        return text(
          `${summary}\n${JSON.stringify(
            {
              ...status,
              allowedRedirects: manager.allowedRedirects(),
              allowedRedirectsNote:
                'Forwarding is allowed only to these addresses or domains. Only a person editing config.toml ([sieve] allowed_redirects) can change them.',
            },
            null,
            2,
          )}`,
        );
      } catch (err) {
        return text(`Sieve status failed: ${errorText(err)}`, true);
      }
    },
  );

  server.registerTool(
    'sieve_list_scripts',
    {
      title: 'List Sieve scripts',
      description: 'List the server-side filter scripts of an account and which one is active.',
      inputSchema: z.object({ account: accountParam }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ account }) => {
      try {
        const scripts = await manager.listScripts(connections.getAccount(account));
        if (scripts.length === 0) return text('No Sieve scripts on this account.');
        return text(
          scripts
            .map((s) => `${s.active ? '● (active)' : '○'} ${JSON.stringify(s.name)}`)
            .join('\n'),
        );
      } catch (err) {
        return text(`Listing Sieve scripts failed: ${errorText(err)}`, true);
      }
    },
  );

  server.registerTool(
    'sieve_get_script',
    {
      title: 'Get Sieve script',
      description:
        'Download a server-side filter script. The script text is returned as untrusted content.',
      inputSchema: z.object({ account: accountParam, name: nameParam }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ account, name }) => {
      try {
        const script = await manager.getScript(connections.getAccount(account), name);
        return text(
          `Script ${JSON.stringify(name)}${script.active ? ' (active)' : ''}:\n${delimitUntrusted(script.content)}`,
        );
      } catch (err) {
        return text(`Getting the Sieve script failed: ${errorText(err)}`, true);
      }
    },
  );

  server.registerTool(
    'sieve_check_script',
    {
      title: 'Check Sieve script',
      description:
        "Check a script without saving it: the server's own syntax check (CHECKSCRIPT, when offered) " +
        'plus a scan for risky actions (forwarding, auto-replies, rejects, discards, notifications, ' +
        'includes, filing into missing folders). Give `content`, or `name` to check a stored script.',
      inputSchema: z.object({
        account: accountParam,
        name: z
          .string()
          .min(1)
          .optional()
          .describe('Stored script to check (or its name, with content)'),
        content: z.string().optional().describe('Sieve script source to check (RFC 5228)'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true },
    },
    async ({ account, name, content }) => {
      if (name === undefined && content === undefined) {
        return text('Give either content (a script to check) or name (a stored script).', true);
      }
      try {
        const report = await manager.checkScript(connections.getAccount(account), {
          name,
          content,
        });
        const verdict = report.blocked
          ? 'This script would be REFUSED by sieve_put_script.'
          : 'This script can be saved.';
        return text([verdict, ...checkLines(report)].join('\n'));
      } catch (err) {
        return text(`Checking the Sieve script failed: ${errorText(err)}`, true);
      }
    },
  );
}

export function registerSieveWriteTools(
  server: McpServer,
  connections: ConnectionManager,
  manager: SieveManager,
): void {
  server.registerTool(
    'sieve_put_script',
    {
      title: 'Save Sieve script',
      description:
        'Create or replace a server-side filter script. PREVIEWS BY DEFAULT: shows the diff, the ' +
        'server check and risky actions, and changes nothing. Pass apply: true to save. Replacing ' +
        'a script first saves a backup copy (imapwiz-backup-<timestamp>-<name>). Saving over the ' +
        'ACTIVE script changes live mail filtering immediately. Forwarding (redirect) is refused ' +
        'unless the target is in the allowlist a person keeps in config.toml; no argument changes that.',
      inputSchema: z.object({
        account: accountParam,
        name: z.string().min(1).describe('Script name'),
        content: z.string().describe('Sieve script source (RFC 5228)'),
        apply: z
          .boolean()
          .default(false)
          .describe('Actually save the script. Without it this only previews.'),
        dryRun: dryRunParam,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ account, name, content, apply, dryRun }) => {
      const write = apply && !dryRun;
      try {
        const cfg = connections.getAccount(account);
        const report = await manager.putScript(cfg, name, content, write);
        const header = report.exists
          ? `Replaces the existing script ${JSON.stringify(name)} on "${cfg.name}".`
          : `Creates the new script ${JSON.stringify(name)} on "${cfg.name}".`;
        const live = report.live
          ? `WARNING: ${JSON.stringify(name)} is the ACTIVE script. Saving it changes live mail filtering immediately.`
          : 'The script is not active; saving it does not change filtering until sieve_activate_script.';
        const body = [
          header,
          live,
          ...checkLines(report),
          'Diff (- current, + new):',
          delimitUntrusted(report.diff.join('\n') || '(no changes)'),
        ];

        if (report.refused) {
          if (write) {
            await audit.log(
              'sieve_put_script',
              cfg.name,
              { name, diff: report.diff.join('\n') },
              'error',
              report.refused,
            );
          }
          return text([`REFUSED: ${report.refused} Nothing was saved.`, ...body].join('\n'), true);
        }
        if (!write) {
          const mode = dryRun ? '[DRY RUN]' : '[PREVIEW]';
          return text(
            [`${mode} Nothing was saved. Call again with apply: true to save.`, ...body].join('\n'),
          );
        }
        await audit.log(
          'sieve_put_script',
          cfg.name,
          { name, live: report.live, backup: report.backup, diff: report.diff.join('\n') },
          'ok',
        );
        const saved = [
          `Saved ${JSON.stringify(name)}.`,
          report.backup ? `The previous version is kept as ${JSON.stringify(report.backup)}.` : '',
          report.live
            ? 'It is the active script, so it is live now.'
            : 'It is not active. Use sieve_activate_script to turn it on.',
          report.serverWarnings ? `Server warnings: ${report.serverWarnings}` : '',
        ].filter(Boolean);
        return text([...saved, ...body.slice(2)].join('\n'));
      } catch (err) {
        if (write) {
          await audit.log('sieve_put_script', account, { name }, 'error', errorText(err));
        }
        return text(`Saving the Sieve script failed: ${errorText(err)}`, true);
      }
    },
  );

  server.registerTool(
    'sieve_activate_script',
    {
      title: 'Activate Sieve script',
      description:
        'Make a script the active one (only one is active at a time), which changes live mail ' +
        'filtering. The script and its includes are scanned first; a script that forwards outside ' +
        'the config.toml allowlist is refused. To turn off every server-side rule, leave name ' +
        'empty and pass disableAll: true.',
      inputSchema: z.object({
        account: accountParam,
        name: z.string().default('').describe('Script to activate; empty only with disableAll'),
        disableAll: z
          .boolean()
          .default(false)
          .describe('Deactivate every script (name must be empty)'),
        dryRun: dryRunParam,
      }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: true,
        openWorldHint: true,
      },
    },
    async ({ account, name, disableAll, dryRun }) => {
      try {
        const cfg = connections.getAccount(account);
        const report = await manager.activateScript(cfg, name, disableAll, !dryRun);
        const scanLines = report.scan
          ? report.scan.findings.length > 0
            ? ['Risky actions:', ...describeFindings(report.scan.findings).map((l) => `- ${l}`)]
            : ['Risky actions: none found.']
          : [];
        const previous = `Previously active: ${report.previous === null ? 'none' : JSON.stringify(report.previous)}.`;
        if (report.refused) {
          if (!dryRun) {
            await audit.log(
              'sieve_activate_script',
              cfg.name,
              { name, disableAll },
              'error',
              report.refused,
            );
          }
          return text([`REFUSED: ${report.refused}`, previous, ...scanLines].join('\n'), true);
        }
        const what =
          name === '' ? 'deactivate every Sieve script' : `activate ${JSON.stringify(name)}`;
        if (dryRun) {
          return text(
            [
              `[DRY RUN] Would ${what} on "${cfg.name}".`,
              previous,
              ...scanLines,
              'Nothing was changed.',
            ].join('\n'),
          );
        }
        await audit.log(
          'sieve_activate_script',
          cfg.name,
          { name, disableAll, previous: report.previous },
          'ok',
        );
        const done =
          name === ''
            ? 'Deactivated every Sieve script. No server-side rules run now.'
            : `Activated ${JSON.stringify(name)}. It filters incoming mail now.`;
        const undo =
          report.previous !== null && report.previous !== name
            ? `To undo, activate ${JSON.stringify(report.previous)} again.`
            : '';
        return text([done, previous, undo, ...scanLines].filter(Boolean).join('\n'));
      } catch (err) {
        if (!dryRun) {
          await audit.log(
            'sieve_activate_script',
            account,
            { name, disableAll },
            'error',
            errorText(err),
          );
        }
        return text(`Activating the Sieve script failed: ${errorText(err)}`, true);
      }
    },
  );

  server.registerTool(
    'sieve_delete_script',
    {
      title: 'Delete Sieve script',
      description:
        'Delete a server-side filter script. The active script is refused (activate another one ' +
        'first). A backup copy (imapwiz-backup-<timestamp>-<name>) is saved before deleting.',
      inputSchema: z.object({ account: accountParam, name: nameParam, dryRun: dryRunParam }),
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ account, name, dryRun }) => {
      try {
        const cfg = connections.getAccount(account);
        const report = await manager.deleteScript(cfg, name, !dryRun);
        if (report.refused) {
          if (!dryRun) {
            await audit.log('sieve_delete_script', cfg.name, { name }, 'error', report.refused);
          }
          return text(`REFUSED: ${report.refused} Nothing was deleted.`, true);
        }
        if (dryRun) {
          return text(
            `[DRY RUN] Would back up and delete ${JSON.stringify(name)} on "${cfg.name}". Nothing was changed.`,
          );
        }
        await audit.log('sieve_delete_script', cfg.name, { name, backup: report.backup }, 'ok');
        return text(
          report.backup
            ? `Deleted ${JSON.stringify(name)}. A copy is kept as ${JSON.stringify(report.backup)}.`
            : `Deleted the backup script ${JSON.stringify(name)}.`,
        );
      } catch (err) {
        if (!dryRun) {
          await audit.log('sieve_delete_script', account, { name }, 'error', errorText(err));
        }
        return text(`Deleting the Sieve script failed: ${errorText(err)}`, true);
      }
    },
  );
}
