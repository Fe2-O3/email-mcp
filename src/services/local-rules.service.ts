/**
 * Local filter rules: for providers without server-side rules (Gmail, Outlook,
 * iCloud, …). They extend the static rules of config.toml (`[[settings.hooks.rules]]`)
 * with rules a tool can add and remove, plus a header match and move/forward actions.
 *
 * They run inside IMAP Wizard, in the process that holds the background-writer
 * lease and runs the watcher, and only while it runs. Mail that arrives while
 * no IMAP Wizard process is running is not filtered.
 *
 * Rules live in a JSON file in the data directory (LOCAL_RULES_FILE), never in
 * config.toml. A forward goes only to an address on `sieve.allowed_redirects`,
 * checked when the rule is added and again every time it fires.
 */

import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { z } from 'zod';

import { LOCAL_RULES_FILE } from '../config/xdg.js';
import { mcpLog } from '../logging.js';
import audit from '../safety/audit.js';
import { isAllowedRedirect, parsePlainAddress } from '../safety/redirect-allowlist.js';
import type { AccountConfig, EmailMeta } from '../types/index.js';
import { matchesPattern } from '../utils/glob-match.js';
import type ImapService from './imap.service.js';
import type SmtpService from './smtp.service.js';

export const LocalRuleMatchSchema = z.object({
  from: z.string().min(1).optional(),
  to: z.string().min(1).optional(),
  subject: z.string().min(1).optional(),
  header: z
    .object({
      name: z
        .string()
        .min(1)
        .regex(/^[!-9;-~]+$/, 'A header name has no spaces or colons'),
      value: z.string().min(1),
    })
    .optional(),
});

export const LocalRuleActionsSchema = z.object({
  moveTo: z.string().min(1).optional(),
  labels: z.array(z.string().min(1)).optional(),
  flag: z.boolean().optional(),
  markRead: z.boolean().optional(),
  forwardTo: z.string().min(1).optional(),
});

export const LocalRuleSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /** Absent: every account. */
  account: z.string().min(1).optional(),
  match: LocalRuleMatchSchema,
  actions: LocalRuleActionsSchema,
  createdAt: z.string(),
});

const LocalRulesFileSchema = z.object({
  version: z.literal(1),
  rules: z.array(LocalRuleSchema),
});

export type LocalRule = z.infer<typeof LocalRuleSchema>;
export type LocalRuleInput = Omit<LocalRule, 'id' | 'createdAt'>;

/** Reasons a rule cannot be added, or an empty list. Checked again before a forward fires. */
export function validateLocalRule(
  rule: LocalRuleInput,
  allowlist: readonly string[],
  existing: readonly LocalRule[],
): string[] {
  const problems: string[] = [];
  const { match, actions } = rule;
  if (!match.from && !match.to && !match.subject && !match.header) {
    problems.push('Give at least one match condition (from, to, subject or header).');
  }
  const hasAction =
    Boolean(actions.moveTo) ||
    (actions.labels?.length ?? 0) > 0 ||
    actions.flag === true ||
    actions.markRead === true ||
    Boolean(actions.forwardTo);
  if (!hasAction) {
    problems.push('Give at least one action (moveTo, labels, flag, markRead or forwardTo).');
  }
  if (actions.forwardTo !== undefined) {
    if (!parsePlainAddress(actions.forwardTo)) {
      problems.push(
        `forwardTo must be one plain email address, not ${JSON.stringify(actions.forwardTo)}.`,
      );
    } else if (!isAllowedRedirect(actions.forwardTo, allowlist)) {
      problems.push(
        `Forwarding to ${actions.forwardTo} is not allowed: it is not in sieve.allowed_redirects. ` +
          'Only a person editing config.toml can add it; no tool can.',
      );
    }
  }
  const lower = rule.name.trim().toLowerCase();
  if (existing.some((r) => r.name.trim().toLowerCase() === lower)) {
    problems.push(`A local rule named ${JSON.stringify(rule.name)} already exists.`);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

export class LocalRulesStore {
  constructor(readonly filePath: string = LOCAL_RULES_FILE) {
    if (path.basename(filePath).toLowerCase() === 'config.toml') {
      throw new Error('Local rules are never stored in config.toml');
    }
  }

  /** The stored rules; an empty list when the file does not exist yet. Throws on a damaged file. */
  async load(): Promise<LocalRule[]> {
    let raw: string;
    try {
      raw = await fs.readFile(this.filePath, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const parsed = LocalRulesFileSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
      throw new Error(
        `The local rules file ${this.filePath} is not valid (${parsed.error.issues[0]?.message ?? 'unknown problem'}). Fix or remove it.`,
      );
    }
    return parsed.data.rules;
  }

  /** Writes the whole list: a temp file, then a rename, so a crash never leaves half a file. */
  private async save(rules: LocalRule[]): Promise<void> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const tmp = `${this.filePath}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(tmp, this.filePath);
  }

  async add(input: LocalRuleInput, now: Date = new Date()): Promise<LocalRule> {
    const rules = await this.load();
    const rule: LocalRule = LocalRuleSchema.parse({
      ...input,
      id: randomUUID().slice(0, 8),
      createdAt: now.toISOString(),
    });
    await this.save([...rules, rule]);
    return rule;
  }

  /** Removes by id or name (case-insensitive); returns the removed rule, or null. */
  async remove(idOrName: string): Promise<LocalRule | null> {
    const rules = await this.load();
    const key = idOrName.trim().toLowerCase();
    const target = rules.find((r) => r.id === idOrName || r.name.trim().toLowerCase() === key);
    if (!target) return null;
    await this.save(rules.filter((r) => r !== target));
    return target;
  }
}

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

export interface RuleEmail {
  account: string;
  mailbox: string;
  meta: EmailMeta;
}

export function ruleMatches(
  rule: LocalRule,
  email: RuleEmail,
  headers: Record<string, string> | undefined,
): boolean {
  if (rule.account && rule.account !== email.account) return false;
  const { match } = rule;
  const fromAddr = email.meta.from.address;
  const fromFull = email.meta.from.name ? `${email.meta.from.name} <${fromAddr}>` : fromAddr;
  if (
    match.from &&
    !matchesPattern(match.from, fromAddr) &&
    !matchesPattern(match.from, fromFull)
  ) {
    return false;
  }
  if (match.to) {
    const addresses = email.meta.to.map((t) => t.address);
    const pattern = match.to;
    if (
      !addresses.some((a) => matchesPattern(pattern, a)) &&
      !matchesPattern(pattern, addresses.join(', '))
    ) {
      return false;
    }
  }
  if (match.subject && !matchesPattern(match.subject, email.meta.subject)) return false;
  if (match.header) {
    const value = headers?.[match.header.name.toLowerCase()];
    if (value === undefined || !matchesPattern(match.header.value, value)) return false;
  }
  return Boolean(match.from ?? match.to ?? match.subject ?? match.header);
}

export interface LocalRulesDeps {
  store: LocalRulesStore;
  imapService: ImapService;
  smtpService: SmtpService;
  /** The human-edited allowlist from config.toml. Read only. */
  allowlist: readonly string[];
  accounts: readonly AccountConfig[];
}

export default class LocalRulesService {
  private readonly allowlist: readonly string[];

  constructor(private readonly deps: LocalRulesDeps) {
    this.allowlist = Object.freeze([...deps.allowlist]);
  }

  /**
   * Applies the first matching rule to each email and returns the emails no
   * rule matched (they go on to the config.toml rules and AI triage). The
   * rules file is read on every batch, so a rule added in another IMAP Wizard
   * process takes effect here without a restart.
   */
  async applyToBatch(batch: RuleEmail[]): Promise<RuleEmail[]> {
    let rules: LocalRule[];
    try {
      rules = await this.deps.store.load();
    } catch (err) {
      await mcpLog(
        'warning',
        'rules',
        `Local rules skipped: ${err instanceof Error ? err.message : String(err)}`,
      ).catch(() => undefined);
      return batch;
    }
    if (rules.length === 0) return batch;

    const unmatched: RuleEmail[] = [];
    for (const email of batch) {
      // eslint-disable-next-line no-await-in-loop -- one message at a time keeps IMAP use bounded
      const rule = await this.firstMatch(rules, email);
      if (rule) {
        // eslint-disable-next-line no-await-in-loop -- actions for one message run in order
        await this.apply(rule, email);
      } else {
        unmatched.push(email);
      }
    }
    return unmatched;
  }

  private async firstMatch(rules: LocalRule[], email: RuleEmail): Promise<LocalRule | undefined> {
    let headers: Record<string, string> | undefined;
    for (const rule of rules) {
      if (
        rule.match.header &&
        headers === undefined &&
        (!rule.account || rule.account === email.account)
      ) {
        try {
          // eslint-disable-next-line no-await-in-loop -- fetched once, only when a rule needs it
          headers = await this.deps.imapService.getHeaders(
            email.account,
            email.meta.id,
            email.mailbox,
          );
        } catch {
          headers = {};
        }
      }
      if (ruleMatches(rule, email, headers)) return rule;
    }
    return undefined;
  }

  private async apply(rule: LocalRule, email: RuleEmail): Promise<void> {
    const { imapService, smtpService } = this.deps;
    const { account, mailbox } = email;
    const id = email.meta.id;
    const { actions } = rule;
    const done: string[] = [];
    const failed: string[] = [];
    const attempt = async (label: string, run: () => Promise<unknown>): Promise<void> => {
      try {
        await run();
        done.push(label);
      } catch (err) {
        failed.push(`${label}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };

    for (const label of actions.labels ?? []) {
      // eslint-disable-next-line no-await-in-loop -- labels on one message, in order
      await attempt(`label ${label}`, () => imapService.addLabel(account, id, mailbox, label));
    }
    if (actions.flag)
      await attempt('flag', () => imapService.setFlags(account, id, mailbox, 'flag'));
    if (actions.markRead) {
      await attempt('mark read', () => imapService.setFlags(account, id, mailbox, 'read'));
    }
    if (actions.forwardTo) {
      const target = actions.forwardTo;
      const own = this.deps.accounts.find((a) => a.name === account)?.email.toLowerCase();
      const sender = email.meta.from.address.toLowerCase();
      if (!isAllowedRedirect(target, this.allowlist)) {
        failed.push(`forward to ${target}: not in sieve.allowed_redirects (config.toml)`);
      } else if (sender === own || sender === target.toLowerCase()) {
        // A forward of our own mail, or of mail from the target, can loop.
        failed.push(`forward to ${target}: skipped, the message is from ${sender}`);
      } else {
        await attempt(`forward to ${target}`, () =>
          smtpService.forwardEmail(account, { emailId: id, mailbox, to: [target] }),
        );
      }
    }
    // Moving changes the UID, so it goes last.
    if (actions.moveTo) {
      const dest = actions.moveTo;
      await attempt(`move to ${dest}`, () => imapService.moveEmail(account, id, mailbox, dest));
    }

    await audit
      .log(
        'local_rule',
        account,
        { rule: rule.name, ruleId: rule.id, emailId: id, mailbox, done, failed },
        failed.length > 0 ? 'error' : 'ok',
        failed.length > 0 ? failed.join('; ') : undefined,
      )
      .catch(() => undefined);
    await mcpLog(
      failed.length > 0 ? 'warning' : 'info',
      'rules',
      `Local rule "${rule.name}" on ${account}/${mailbox} #${id}: ${[...done, ...failed.map((f) => `FAILED ${f}`)].join(', ')}`,
    ).catch(() => undefined);
  }
}
