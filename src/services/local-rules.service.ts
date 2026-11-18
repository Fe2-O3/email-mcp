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
import accountFingerprint from '../connections/account-identity.js';
import { mcpLog } from '../logging.js';
import audit from '../safety/audit.js';
import { isAllowedRedirect, parsePlainAddress } from '../safety/redirect-allowlist.js';
import { validateLabelName } from '../safety/validation.js';
import type { AccountConfig, EmailMeta } from '../types/index.js';
import { isCatchAllPattern, matchesPattern } from '../utils/glob-match.js';
import type ImapService from './imap.service.js';
import type SmtpService from './smtp.service.js';
import { FORWARD_MARKER_HEADER } from './smtp.service.js';

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
  /**
   * The server and login `account` pointed at when the rule was added. A rule
   * whose account now points elsewhere does not run. Absent on older rules.
   */
  accountFingerprint: z.string().min(1).optional(),
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

/** Limits on what a tool may store. Stored files are not checked against them, so older rules still load. */
export const MAX_RULE_NAME = 100;
export const MAX_RULE_PATTERN = 200;
export const MAX_RULES = 200;

/** The conditions a rule has, as text patterns. */
function conditionPatterns(match: LocalRule['match']): string[] {
  return [match.from, match.to, match.subject, match.header?.value].filter(
    (p): p is string => typeof p === 'string',
  );
}

/**
 * True when every condition of the rule matches any message, so the rule acts
 * on all new mail. One specific condition is enough to make it a real filter.
 */
export function isCatchAllRule(match: LocalRule['match']): boolean {
  const patterns = conditionPatterns(match);
  return patterns.length > 0 && patterns.every((p) => isCatchAllPattern(p));
}

/** Store a forward target as one plain `local@domain` address (not "<a@b>" or padded). */
export function normalizeLocalRule(rule: LocalRuleInput): LocalRuleInput {
  const target = rule.actions.forwardTo;
  const parsed = target === undefined ? null : parsePlainAddress(target);
  return {
    ...rule,
    name: rule.name.trim(),
    actions: parsed
      ? { ...rule.actions, forwardTo: `${parsed.local}@${parsed.domain}` }
      : rule.actions,
  };
}

const SPECIAL_FOLDER_NAME =
  /^(trash|bin|deleted( items| messages)?|junk( e-?mail)?|spam|drafts?|sent( items| mail| messages)?|archives?|all mail)$/i;

function sameFolder(a: string, b: string): boolean {
  if (/^inbox$/i.test(a.trim()) && /^inbox$/i.test(b.trim())) return true;
  return a.trim() === b.trim();
}

/**
 * Why a rule must not move mail into `dest`, or undefined. Trash, Junk, Drafts,
 * Sent, Archive and other special-use folders hide mail from the owner; a
 * watched folder makes the moved copy count as new mail and run the rules
 * again, which loops. `mailboxes` is the account's folder list, when known.
 */
export function moveTargetProblem(
  dest: string,
  mailboxes: readonly { path: string; specialUse?: string }[] | null,
  watched: readonly string[],
): string | undefined {
  const leaf = dest.split(/[/.]/).pop() ?? dest;
  const listed = mailboxes?.find((m) => m.path === dest);
  if (listed?.specialUse || SPECIAL_FOLDER_NAME.test(leaf.trim())) {
    return `A local rule may not move mail into ${JSON.stringify(dest)}: it is a special folder (Trash, Junk, Drafts, Sent, Archive...), so mail would disappear from view. Use labels or flags instead.`;
  }
  if (watched.some((w) => sameFolder(w, dest))) {
    return `A local rule may not move mail into ${JSON.stringify(dest)}: that folder is watched, so the moved message would count as new mail and run the rules again.`;
  }
  return undefined;
}

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
  } else if (isCatchAllRule(match)) {
    problems.push(
      'This rule would match every message (a condition made only of * matches anything). ' +
        'Name a real sender, recipient, subject or header value.',
    );
  }
  if (rule.name.length > MAX_RULE_NAME) {
    problems.push(`The rule name is longer than ${MAX_RULE_NAME} characters.`);
  }
  if (conditionPatterns(match).some((p) => p.length > MAX_RULE_PATTERN)) {
    problems.push(`A match pattern is longer than ${MAX_RULE_PATTERN} characters.`);
  }
  if (existing.length >= MAX_RULES) {
    problems.push(`There are already ${MAX_RULES} local rules. Remove one first.`);
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
  for (const label of actions.labels ?? []) {
    try {
      validateLabelName(label);
    } catch (err) {
      problems.push(err instanceof Error ? err.message : String(err));
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
  /** Edits in this process run one at a time, in the order they were asked for. */
  private queue: Promise<unknown> = Promise.resolve();

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
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error(
        `The local rules file ${this.filePath} is damaged (it is not valid JSON). Fix or remove it.`,
      );
    }
    const parsed = LocalRulesFileSchema.safeParse(json);
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
    // A random part, not the clock: two saves in the same millisecond shared
    // one temp name, and the second rename then failed with ENOENT.
    const tmp = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, `${JSON.stringify({ version: 1, rules }, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await fs.rename(tmp, this.filePath);
  }

  /**
   * Run one edit alone: after the edits already queued in this process, and
   * while holding a lock file so another IMAP Wizard process cannot read the
   * list at the same time. Without it two simultaneous edits each read the old
   * list and the last write dropped the other's rule.
   */
  private edit<T>(run: () => Promise<T>): Promise<T> {
    const result = this.queue.then(async () => {
      const release = await this.acquireFileLock();
      try {
        return await run();
      } finally {
        await release();
      }
    });
    this.queue = result.catch(() => undefined);
    return result;
  }

  private async acquireFileLock(): Promise<() => Promise<void>> {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
    const lockPath = `${this.filePath}.lock`;
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        // eslint-disable-next-line no-await-in-loop -- retry until the other editor is done
        const handle = await fs.open(lockPath, 'wx', 0o600);
        // eslint-disable-next-line no-await-in-loop
        await handle.close();
        return async () => {
          await fs.rm(lockPath, { force: true });
        };
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      // A lock left by a crashed editor is not waited on forever.
      try {
        // eslint-disable-next-line no-await-in-loop
        const { mtimeMs } = await fs.stat(lockPath);
        if (Date.now() - mtimeMs > LOCK_STALE_MS) {
          // eslint-disable-next-line no-await-in-loop
          await fs.rm(lockPath, { force: true });
          continue; // eslint-disable-line no-continue
        }
      } catch {
        continue; // eslint-disable-line no-continue -- it vanished: try to take it
      }
      if (Date.now() > deadline) {
        throw new Error(
          `The local rules file ${this.filePath} is being edited by another process. Try again in a moment.`,
        );
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => {
        setTimeout(resolve, 25);
      });
    }
  }

  add(input: LocalRuleInput, now: Date = new Date()): Promise<LocalRule> {
    return this.edit(async () => {
      const rules = await this.load();
      // Checked here, under the lock, so two adds with one name cannot both win.
      const lower = input.name.trim().toLowerCase();
      if (rules.some((r) => r.name.trim().toLowerCase() === lower)) {
        throw new Error(`A local rule named ${JSON.stringify(input.name)} already exists.`);
      }
      if (rules.length >= MAX_RULES) {
        throw new Error(`There are already ${MAX_RULES} local rules. Remove one first.`);
      }
      const rule: LocalRule = LocalRuleSchema.parse({
        ...input,
        id: randomUUID().slice(0, 8),
        createdAt: now.toISOString(),
      });
      await this.save([...rules, rule]);
      return rule;
    });
  }

  /** Removes by id or name (case-insensitive); returns the removed rule, or null. */
  remove(idOrName: string): Promise<LocalRule | null> {
    return this.edit(async () => {
      const rules = await this.load();
      const key = idOrName.trim().toLowerCase();
      const target = rules.find((r) => r.id === idOrName || r.name.trim().toLowerCase() === key);
      if (!target) return null;
      await this.save(rules.filter((r) => r !== target));
      return target;
    });
  }
}

const LOCK_WAIT_MS = 5000;
const LOCK_STALE_MS = 30_000;

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
    // Own keys only: a header named "constructor" must not read Object.prototype.
    const key = match.header.name.toLowerCase();
    const value = headers && Object.hasOwn(headers, key) ? headers[key] : undefined;
    if (value === undefined || !matchesPattern(match.header.value, value)) return false;
  }
  return Boolean(match.from ?? match.to ?? match.subject ?? match.header);
}

/**
 * True when the rule records which mailbox its account was, and the account of
 * that name is now a different server or login. A missing account is not
 * "moved": such a rule matches nothing and is flagged by list_local_rules.
 */
export function ruleAccountMoved(
  rule: Pick<LocalRule, 'account' | 'accountFingerprint'>,
  accounts: readonly AccountConfig[],
): boolean {
  if (!rule.account || !rule.accountFingerprint) return false;
  const account = accounts.find((a) => a.name === rule.account);
  if (!account?.imap) return false;
  return accountFingerprint(account) !== rule.accountFingerprint;
}

export interface LocalRulesDeps {
  store: LocalRulesStore;
  imapService: ImapService;
  smtpService: SmtpService;
  /**
   * The human-edited allowlist, read fresh from config.toml each time a forward
   * fires, so removing an address takes effect in a running process. An
   * unreadable file must give an empty list.
   */
  readAllowlist?: () => Promise<readonly string[]>;
  /** A fixed allowlist, used only when `readAllowlist` is not given (tests). */
  allowlist?: readonly string[];
  /** Folders the watcher watches. A move into one would run the rules on the moved copy. */
  watchedFolders?: () => readonly string[];
  accounts: readonly AccountConfig[];
}

export default class LocalRulesService {
  /** Catch-all rules already warned about, so the log has one line per rule. */
  private readonly warnedCatchAll = new Set<string>();

  /** Rules whose account moved, already warned about. */
  private readonly warnedMoved = new Set<string>();

  constructor(private readonly deps: LocalRulesDeps) {}

  private async currentAllowlist(): Promise<readonly string[]> {
    if (this.deps.readAllowlist) {
      try {
        return await this.deps.readAllowlist();
      } catch {
        return [];
      }
    }
    return this.deps.allowlist ?? [];
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
    rules = await this.withoutMovedAccounts(rules);
    if (rules.length === 0) return batch;

    // Rules saved before catch-all rules were refused still run, but say so once.
    for (const r of rules) {
      if (isCatchAllRule(r.match) && !this.warnedCatchAll.has(r.id)) {
        this.warnedCatchAll.add(r.id);
        await mcpLog(
          'warning',
          'rules',
          `Local rule "${r.name}" matches every message. New rules like it are refused; remove it with remove_local_rule if it is not wanted.`,
        ).catch(() => undefined);
      }
    }

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

  /**
   * Rules made for a mailbox whose account name now points at another server
   * or login are left out, with one log line each: they would act on mail they
   * were never written for.
   */
  private async withoutMovedAccounts(rules: LocalRule[]): Promise<LocalRule[]> {
    const kept: LocalRule[] = [];
    for (const r of rules) {
      if (!ruleAccountMoved(r, this.deps.accounts)) {
        kept.push(r);
        continue;
      }
      if (!this.warnedMoved.has(r.id)) {
        this.warnedMoved.add(r.id);
        await mcpLog(
          'warning',
          'rules',
          `Local rule "${r.name}" was made for "${r.account}" when it pointed at another server or login, so it does not run. Remove it, then add it again if it is still wanted.`,
        ).catch(() => undefined);
      }
    }
    return kept;
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
        } catch (err) {
          headers = {};
          // Not "no match", silently: say the header rules could not be checked.
          await mcpLog(
            'warning',
            'rules',
            `Could not read the headers of ${email.account}/${email.mailbox} #${email.meta.id} for a header rule: ${err instanceof Error ? err.message : String(err)}`,
          ).catch(() => undefined);
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
    // A forward that did not go out leaves the message where it is: moving it
    // away would hide mail that was never passed on.
    let forwardFailed = false;
    if (actions.forwardTo) {
      const parsedTarget = parsePlainAddress(actions.forwardTo);
      const target = parsedTarget
        ? `${parsedTarget.local}@${parsedTarget.domain}`
        : actions.forwardTo;
      const own = this.deps.accounts.find((a) => a.name === account)?.email.toLowerCase();
      const sender = email.meta.from.address.toLowerCase();
      if (!isAllowedRedirect(target, await this.currentAllowlist())) {
        failed.push(`forward to ${target}: not in sieve.allowed_redirects (config.toml)`);
        forwardFailed = true;
      } else if (sender === own || sender === target) {
        // A forward of our own mail, or of mail from the target, can loop.
        failed.push(`forward to ${target}: skipped, the message is from ${sender}`);
        forwardFailed = true;
      } else {
        // Refuse mail that IMAP Wizard already forwarded: a ring of accounts
        // forwarding to each other stops after one hop. Not knowing is a no.
        let alreadyForwarded: boolean | undefined;
        try {
          const headers = await imapService.getHeaders(account, id, mailbox);
          alreadyForwarded = Object.hasOwn(headers, FORWARD_MARKER_HEADER.toLowerCase());
        } catch (err) {
          failed.push(
            `forward to ${target}: not sent, the headers could not be read (${err instanceof Error ? err.message : String(err)})`,
          );
          forwardFailed = true;
        }
        if (alreadyForwarded) {
          failed.push(
            `forward to ${target}: skipped, this message was already forwarded by IMAP Wizard`,
          );
          forwardFailed = true;
        } else if (alreadyForwarded === false) {
          await attempt(`forward to ${target}`, () =>
            smtpService.forwardEmail(account, { emailId: id, mailbox, to: [target] }),
          );
          forwardFailed = !done.includes(`forward to ${target}`);
        }
      }
    }
    // Moving changes the UID, so it goes last.
    if (actions.moveTo) {
      const dest = actions.moveTo;
      const watched = this.deps.watchedFolders?.() ?? [];
      if (forwardFailed) {
        failed.push(`move to ${dest}: skipped, the forward did not go out`);
      } else if (sameFolder(dest, mailbox)) {
        // Already there: a move would only mint a new number and look like new mail.
        done.push(`move to ${dest} (already there)`);
      } else if (watched.some((w) => sameFolder(w, dest))) {
        failed.push(
          `move to ${dest}: skipped, that folder is watched and the rules would run again`,
        );
      } else {
        await attempt(`move to ${dest}`, () => imapService.moveEmail(account, id, mailbox, dest));
      }
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
