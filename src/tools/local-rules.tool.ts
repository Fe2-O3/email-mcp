/**
 * MCP tools: list_local_rules, add_local_rule, remove_local_rule.
 *
 * Local rules are for providers without server-side rules. They run only while
 * IMAP Wizard runs (in the process that runs the watcher), and are stored in
 * the data directory, never in config.toml.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type ConnectionManager from '../connections/manager.js';
import audit from '../safety/audit.js';
import { delimitUntrusted, SAVED_TEXT_NOTICE } from '../safety/untrusted-content.js';
import type ImapService from '../services/imap.service.js';
import type { LocalRule, LocalRulesStore } from '../services/local-rules.service.js';
import {
  isCatchAllRule,
  LocalRuleActionsSchema,
  LocalRuleMatchSchema,
  moveTargetProblem,
  normalizeLocalRule,
  validateLocalRule,
} from '../services/local-rules.service.js';
import type { AppConfig } from '../types/index.js';
import { dryRunParam } from './schema-helpers.js';

const RUNS_ONLY_WHILE =
  'Local rules run only while IMAP Wizard is running, in the process that runs the watcher ' +
  '([settings.watcher] enabled = true, and not read_only). Mail that arrives while it is not ' +
  'running is not filtered. For rules that always run, use the Sieve tools where the provider ' +
  'supports them (sieve_status).';

const text = (body: string, isError = false) => ({
  ...(isError ? { isError: true } : {}),
  content: [{ type: 'text' as const, text: body }],
});

const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function describeRule(rule: LocalRule): string {
  const match = [
    rule.match.from ? `from ${JSON.stringify(rule.match.from)}` : '',
    rule.match.to ? `to ${JSON.stringify(rule.match.to)}` : '',
    rule.match.subject ? `subject ${JSON.stringify(rule.match.subject)}` : '',
    rule.match.header
      ? `header ${rule.match.header.name} ${JSON.stringify(rule.match.header.value)}`
      : '',
  ].filter(Boolean);
  const actions = [
    rule.actions.labels?.length ? `label ${rule.actions.labels.join(', ')}` : '',
    rule.actions.flag ? 'flag' : '',
    rule.actions.markRead ? 'mark read' : '',
    rule.actions.forwardTo ? `forward to ${rule.actions.forwardTo}` : '',
    rule.actions.moveTo ? `move to ${JSON.stringify(rule.actions.moveTo)}` : '',
  ].filter(Boolean);
  return `[${rule.id}] ${JSON.stringify(rule.name)} (${rule.account ?? 'all accounts'}): when ${match.join(' and ')} → ${actions.join(', ')}`;
}

export function registerLocalRulesReadTools(
  server: McpServer,
  store: LocalRulesStore,
  config: AppConfig,
): void {
  server.registerTool(
    'list_local_rules',
    {
      title: 'List local rules',
      description:
        'List the local filter rules IMAP Wizard runs on new mail (for providers without ' +
        'server-side rules). They run only while IMAP Wizard is running.',
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    },
    async () => {
      try {
        const rules = await store.load();
        const notes = [RUNS_ONLY_WHILE];
        if (!config.settings.watcher?.enabled) {
          notes.unshift('NOTE: the watcher is off, so these rules do not run at all right now.');
        }
        if (config.settings.readOnly) {
          notes.unshift('NOTE: read_only is on, so these rules do not run.');
        }
        const known = Array.isArray(config.accounts)
          ? new Set(config.accounts.map((a) => a.name))
          : null;
        const lines = rules.map((r) => {
          const flags = [
            isCatchAllRule(r.match) ? 'WARNING: matches every message' : '',
            r.account && known && !known.has(r.account)
              ? `WARNING: there is no account named ${JSON.stringify(r.account)}, so it never runs`
              : '',
          ].filter(Boolean);
          return `- ${describeRule(r)}${flags.length > 0 ? ` [${flags.join('; ')}]` : ''}`;
        });
        // Rule names and patterns may have been written by a model that read an
        // email: they come back marked as data.
        const body =
          rules.length === 0
            ? 'No local rules.'
            : delimitUntrusted(lines.join('\n'), SAVED_TEXT_NOTICE);
        return text(`${body}\n\n${notes.join('\n')}`);
      } catch (err) {
        return text(`Listing local rules failed: ${errorText(err)}`, true);
      }
    },
  );
}

export function registerLocalRulesWriteTools(
  server: McpServer,
  store: LocalRulesStore,
  connections: ConnectionManager,
  imapService: ImapService,
  config: AppConfig,
  /** Reads the allowlist fresh from config.toml; falls back to the loaded copy. */
  readAllowlist: () => Promise<readonly string[]> = async () =>
    config.sieve?.allowedRedirects ?? [],
): void {
  const watched = config.settings.watcher?.folders ?? ['INBOX'];

  server.registerTool(
    'add_local_rule',
    {
      title: 'Add local rule',
      description:
        'Add a filter rule that IMAP Wizard runs on new mail: match on from, to, subject or a ' +
        'header (glob patterns: * wildcard, | for alternatives; all given conditions must match), ' +
        'then label, flag, mark read, forward or move. The first matching rule wins. ' +
        'Forwarding is allowed only to an address on the allowlist a person keeps in config.toml ' +
        '([sieve] allowed_redirects); no argument changes that. ' +
        RUNS_ONLY_WHILE,
      inputSchema: z.object({
        name: z.string().min(1).describe('A short unique name for the rule'),
        account: z
          .string()
          .min(1)
          .optional()
          .describe('Account name from list_accounts; omit for every account'),
        match: LocalRuleMatchSchema.describe('Conditions; all given ones must match'),
        actions: LocalRuleActionsSchema.describe(
          'What to do: moveTo (folder), labels, flag, markRead, forwardTo (allowlisted address)',
        ),
        dryRun: dryRunParam,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ name, account, match, actions, dryRun }) => {
      const input = normalizeLocalRule({ name, account, match, actions });
      try {
        if (account !== undefined) connections.getAccount(account);
        const problems = validateLocalRule(input, await readAllowlist(), await store.load());
        if (actions.moveTo) {
          // With no account named the rule runs on every account, so the
          // folder must be fine on each of them.
          const targets = account !== undefined ? [account] : connections.getAccountNames();
          const refusals = new Set<string>();
          for (const target of targets) {
            // eslint-disable-next-line no-await-in-loop -- one account at a time
            const mailboxes = await imapService.listMailboxes(target);
            if (
              !mailboxes.some((m) => m.path === actions.moveTo) &&
              !/^inbox$/i.test(actions.moveTo)
            ) {
              problems.push(
                `The folder ${JSON.stringify(actions.moveTo)} does not exist on "${target}".`,
              );
            }
            const problem = moveTargetProblem(actions.moveTo, mailboxes, watched);
            if (problem) refusals.add(problem);
          }
          problems.push(...refusals);
        }
        if (problems.length > 0) {
          if (!dryRun)
            await audit.log('add_local_rule', account ?? '*', input, 'error', problems.join(' '));
          return text(`${dryRun ? '[DRY RUN] ' : ''}Not added:\n- ${problems.join('\n- ')}`, true);
        }
        if (dryRun) {
          return text(
            `[DRY RUN] Would add the local rule ${JSON.stringify(name)}. Nothing was changed.\n${RUNS_ONLY_WHILE}`,
          );
        }
        const rule = await store.add(input);
        await audit.log('add_local_rule', account ?? '*', { ...input, id: rule.id }, 'ok');
        return text(`Added local rule ${describeRule(rule)}\n${RUNS_ONLY_WHILE}`);
      } catch (err) {
        if (dryRun) return text(`[DRY RUN] Would fail: ${errorText(err)}`, true);
        await audit.log('add_local_rule', account ?? '*', input, 'error', errorText(err));
        return text(`Adding the local rule failed: ${errorText(err)}`, true);
      }
    },
  );

  server.registerTool(
    'remove_local_rule',
    {
      title: 'Remove local rule',
      description: 'Remove a local filter rule by its id or name (see list_local_rules).',
      inputSchema: z.object({
        rule: z.string().min(1).describe('Rule id or name from list_local_rules'),
        dryRun: dryRunParam,
      }),
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
    },
    async ({ rule, dryRun }) => {
      try {
        if (dryRun) {
          const key = rule.trim().toLowerCase();
          const found = (await store.load()).find(
            (r) => r.id === rule || r.name.trim().toLowerCase() === key,
          );
          return found
            ? text(`[DRY RUN] Would remove ${describeRule(found)}. Nothing was changed.`)
            : text(`[DRY RUN] Would fail: there is no local rule ${JSON.stringify(rule)}.`, true);
        }
        const removed = await store.remove(rule);
        if (!removed) return text(`There is no local rule ${JSON.stringify(rule)}.`, true);
        await audit.log('remove_local_rule', removed.account ?? '*', { rule: removed }, 'ok');
        return text(`Removed ${describeRule(removed)}`);
      } catch (err) {
        if (dryRun) return text(`[DRY RUN] Would fail: ${errorText(err)}`, true);
        await audit.log('remove_local_rule', '*', { rule }, 'error', errorText(err));
        return text(`Removing the local rule failed: ${errorText(err)}`, true);
      }
    },
  );
}
