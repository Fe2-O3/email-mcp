/**
 * Scheduler service — JSON file-based email scheduling queue.
 *
 * Manages scheduled emails with a local file queue.
 * Source of truth is the JSON files in XDG state directory.
 */

import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { SCHEDULED_DIR, SCHEDULED_SENT_DIR } from '../config/xdg.js';
import audit from '../safety/audit.js';
import type { ScheduledEmail } from '../types/index.js';
import type ImapService from './imap.service.js';
import type SmtpService from './smtp.service.js';
import { UncertainSendError } from './smtp.service.js';

/** Max age (ms) for "sending" status before resetting to "pending" */
const STALE_LOCK_MS = 5 * 60 * 1000;

/** Refusals by the mail server before a job is marked "failed" */
const MAX_ATTEMPTS = 3;

/** Back-off after a temporary problem (no connection, rate limit): 1 min, 2, 4... up to 15. */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 15 * 60_000;

const INTERRUPTED_MESSAGE =
  'Interrupted while sending: the email may or may not have gone out (unknown). ' +
  'Check the Sent folder first. It will not be sent again; cancel this job to clear it.';

export interface CheckResult {
  sent: number;
  /** Jobs the server refused until they ran out of attempts. */
  failed: number;
  /** Jobs whose result is unknown (check Sent first). */
  unknown: number;
  /** Jobs held back by a temporary problem, to be tried again later. */
  deferred: number;
  errors: string[];
  /** Why nothing was sent (read-only mode). */
  skipped?: string;
}

/**
 * True when nothing was sent and nothing was refused by the server: no
 * connection, no network, a rate limit or the duplicate guard. Such a job
 * waits and tries again without using up an attempt.
 */
function isTemporaryProblem(err: unknown): boolean {
  const e = (err ?? {}) as {
    code?: string;
    command?: string;
    message?: string;
    cause?: { code?: string };
  };
  const codes = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EDNS', 'ENETUNREACH', 'EAI_AGAIN']);
  if ((e.code && codes.has(e.code)) || (e.cause?.code && codes.has(e.cause.code))) return true;
  if (e.command === 'CONN') return true;
  return /^Rate limit exceeded|already being sent|allow_duplicate|unknown result|fetch failed/i.test(
    e.message ?? '',
  );
}

export default class SchedulerService {
  constructor(
    private smtpService: SmtpService,
    private imapService: ImapService,
    /** Read-only mode: queued mail is kept but never sent. */
    private readOnly = false,
    /**
     * Which server and login an account name points at now, or undefined when
     * there is no such account. Without it, jobs are sent as they always were.
     */
    private accountIdentity?: (account: string) => string | undefined,
  ) {}

  // -------------------------------------------------------------------------
  // Schedule a new email
  // -------------------------------------------------------------------------

  async schedule(
    account: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      sendAt: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      inReplyTo?: string;
      references?: string[];
    },
  ): Promise<ScheduledEmail> {
    const sendAtDate = new Date(options.sendAt);
    if (Number.isNaN(sendAtDate.getTime())) {
      throw new Error(`Invalid send_at date: ${options.sendAt}`);
    }
    if (sendAtDate.getTime() <= Date.now()) {
      throw new Error('send_at must be in the future');
    }

    const scheduled: ScheduledEmail = {
      id: crypto.randomUUID(),
      account,
      to: options.to,
      cc: options.cc,
      bcc: options.bcc,
      subject: options.subject,
      body: options.body,
      html: options.html ?? false,
      sendAt: sendAtDate.toISOString(),
      createdAt: new Date().toISOString(),
      status: 'pending',
      attempts: 0,
      inReplyTo: options.inReplyTo,
      references: options.references,
      accountFingerprint: this.accountIdentity?.(account),
    };

    // Save IMAP draft (best-effort)
    try {
      const draftResult = await this.imapService.saveDraft(account, {
        to: options.to,
        subject: `[Scheduled: ${sendAtDate.toLocaleString()}] ${options.subject}`,
        body: options.body,
        cc: options.cc,
        html: options.html,
      });
      // A server that does not report the draft's UID gives no id: keep none
      // rather than a number that could later name some other message.
      if (draftResult.id !== undefined) {
        scheduled.draftMessageId = String(draftResult.id);
        scheduled.draftMailbox = draftResult.mailbox;
        scheduled.draftUidValidity = draftResult.uidValidity;
      }
    } catch {
      // Draft mirror is best-effort
    }

    await SchedulerService.writeScheduledFile(scheduled);
    return scheduled;
  }

  // -------------------------------------------------------------------------
  // List scheduled emails
  // -------------------------------------------------------------------------

  // eslint-disable-next-line class-methods-use-this
  async list(
    options: {
      account?: string;
      status?: 'active' | 'pending' | 'sent' | 'failed' | 'unknown' | 'all';
    } = {},
  ): Promise<ScheduledEmail[]> {
    const status = options.status ?? 'active';
    const emails: ScheduledEmail[] = [];

    // Queue folder: pending, sending, failed and unknown jobs (and, rarely, a
    // sent job whose record could not be moved).
    emails.push(...(await SchedulerService.readDir(SCHEDULED_DIR, true)));

    // Read sent from sent/ subdir
    if (status === 'sent' || status === 'all') {
      emails.push(...(await SchedulerService.readDir(SCHEDULED_SENT_DIR, false)));
    }

    // Filter by account if specified
    const filtered = options.account ? emails.filter((e) => e.account === options.account) : emails;

    const keep = (e: ScheduledEmail): boolean => {
      if (status === 'all') return true;
      // A job still waiting, being sent, or needing the owner's attention.
      if (status === 'active')
        return ['pending', 'sending', 'failed', 'unknown'].includes(e.status);
      return e.status === status;
    };

    return filtered
      .filter(keep)
      .sort((a, b) => new Date(a.sendAt).getTime() - new Date(b.sendAt).getTime());
  }

  // -------------------------------------------------------------------------
  // Cancel a scheduled email
  // -------------------------------------------------------------------------

  async cancel(scheduleId: string): Promise<{ cancelled: boolean; draftDeleted: boolean }> {
    const filePath = path.join(SCHEDULED_DIR, `${scheduleId}.json`);
    const lockPath = `${filePath}.sending`;
    const claimPath = `${filePath}.cancelling`;
    let draftDeleted = false;

    // Claim the job first, so the scheduler cannot pick it up while we clean
    // up. If the claim fails the job is gone, being sent, or interrupted.
    let claimed = claimPath;
    try {
      await fs.rename(filePath, claimPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      const inFlight = await SchedulerService.readJob(lockPath);
      if (!inFlight) throw new Error(`Scheduled email "${scheduleId}" not found`);
      if (!SchedulerService.isStaleSending(inFlight, Date.now())) {
        throw new Error(
          `Scheduled email "${scheduleId}" is being sent right now ("already sending"), so it was not cancelled. ` +
            'Check the Sent folder in a minute.',
        );
      }
      // An interrupted send: the owner has had the chance to check Sent.
      claimed = lockPath;
    }

    const scheduled = await SchedulerService.readJob(claimed);
    if (!scheduled || !['pending', 'failed', 'unknown', 'sending'].includes(scheduled.status)) {
      if (claimed === claimPath) await fs.rename(claimPath, filePath).catch(() => {});
      throw new Error(`Cannot cancel email with status "${scheduled?.status ?? 'unreadable'}"`);
    }

    // Delete IMAP draft (best-effort)
    if (scheduled.draftMessageId && scheduled.draftMailbox) {
      try {
        await this.imapService.trashDraft(
          scheduled.account,
          Number(scheduled.draftMessageId),
          scheduled.draftMailbox,
          scheduled.draftUidValidity,
        );
        draftDeleted = true;
      } catch {
        // Draft deletion is best-effort
      }
    }

    await fs.unlink(claimed);
    return { cancelled: true, draftDeleted };
  }

  // -------------------------------------------------------------------------
  // Check and send overdue emails
  // -------------------------------------------------------------------------

  /* eslint-disable no-await-in-loop, no-continue -- Sequential file processing required */
  async checkAndSend(): Promise<CheckResult> {
    const result: CheckResult = { sent: 0, failed: 0, unknown: 0, deferred: 0, errors: [] };
    await SchedulerService.ensureDirs();

    let files: string[];
    try {
      files = await fs.readdir(SCHEDULED_DIR);
    } catch {
      return result;
    }

    const now = Date.now();

    // Read-only mode: nothing goes out, and the owner is told why. Jobs stay queued.
    if (this.readOnly) {
      let overdue = 0;
      for (const job of await SchedulerService.readDir(SCHEDULED_DIR, false)) {
        if (job.status === 'pending' && new Date(job.sendAt).getTime() <= now) overdue += 1;
      }
      if (overdue > 0) {
        result.skipped = `Read-only mode is on, so ${overdue} overdue scheduled email(s) were not sent. They stay queued and will go out once read-only mode is turned off.`;
      }
      return result;
    }

    // A crash mid-send leaves <id>.json.sending. Never resend one: the mail
    // may be out already. Mark it "unknown" so it shows up and can be cancelled.
    for (const file of files.filter((f) => f.endsWith('.json.sending'))) {
      await this.recoverInterrupted(file, now, result);
    }

    // Process files sequentially — must not double-send
    // eslint-disable-next-line no-restricted-syntax
    for (const file of files.filter((f) => f.endsWith('.json'))) {
      try {
        await this.processJob(file, now, result);
      } catch (err) {
        result.errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    return result;
  }
  /* eslint-enable no-await-in-loop, no-continue */

  private identityProblem(job: ScheduledEmail): string | undefined {
    if (!this.accountIdentity) return undefined;
    const current = this.accountIdentity(job.account);
    if (current === undefined) {
      return `The account "${job.account}" no longer exists, so this scheduled email was not sent.`;
    }
    if (job.accountFingerprint !== undefined && job.accountFingerprint !== current) {
      return `The account "${job.account}" now points at a different server or login than when this email was scheduled, so it was not sent. Schedule it again if it should still go out.`;
    }
    return undefined;
  }

  private async recoverInterrupted(file: string, now: number, result: CheckResult): Promise<void> {
    const lockPath = path.join(SCHEDULED_DIR, file);
    const id = file.slice(0, -'.json.sending'.length);
    const job = await SchedulerService.readJob(lockPath);
    if (!job || !SchedulerService.isStaleSending(job, now)) return;
    // Already recorded as sent: only the cleanup was missed.
    if (await SchedulerService.fileExists(path.join(SCHEDULED_SENT_DIR, `${id}.json`))) {
      await fs.unlink(lockPath).catch(() => {});
      return;
    }
    job.status = 'unknown';
    job.lastError = INTERRUPTED_MESSAGE;
    delete job.sendingAt;
    try {
      await SchedulerService.writeJob(path.join(SCHEDULED_DIR, `${id}.json`), job);
      await fs.unlink(lockPath);
    } catch (err) {
      result.errors.push(`${file}: ${err instanceof Error ? err.message : String(err)}`);
      return;
    }
    result.unknown += 1;
    result.errors.push(`${id}.json: ${INTERRUPTED_MESSAGE}`);
  }

  private async processJob(file: string, now: number, result: CheckResult): Promise<void> {
    const filePath = path.join(SCHEDULED_DIR, file);
    const job = await SchedulerService.readJob(filePath);
    if (!job) return; // unreadable or corrupted: leave it alone

    // Old files: status "sending" on the plain name. The crash case is
    // "unknown", not "pending" again.
    if (job.status === 'sending') {
      if (!SchedulerService.isStaleSending(job, now)) return;
      job.status = 'unknown';
      job.lastError = INTERRUPTED_MESSAGE;
      delete job.sendingAt;
      await SchedulerService.writeJob(filePath, job);
      result.unknown += 1;
      result.errors.push(`${file}: ${INTERRUPTED_MESSAGE}`);
      return;
    }

    if (job.status !== 'pending') return;
    if (new Date(job.sendAt).getTime() > now) return;
    if (job.retryAfter && new Date(job.retryAfter).getTime() > now) return;

    if (job.attempts >= MAX_ATTEMPTS) {
      job.status = 'failed';
      job.lastError = job.lastError ?? 'Max retry attempts exceeded';
      await SchedulerService.writeJob(filePath, job);
      result.failed += 1;
      return;
    }

    // The name alone does not say which mailbox: sent from whatever account
    // holds it today, the mail would go out under someone else's identity.
    const mismatch = this.identityProblem(job);
    if (mismatch) {
      job.status = 'failed';
      job.lastError = mismatch;
      await SchedulerService.writeJob(filePath, job);
      result.failed += 1;
      result.errors.push(`${file}: ${mismatch}`);
      return;
    }

    // Acquire lock — atomic via rename, so two processes cannot both
    // claim the same file. The winner renames to .sending, the loser
    // sees ENOENT on the original and skips.
    const lockPath = `${filePath}.sending`;
    try {
      await fs.rename(filePath, lockPath);
    } catch {
      return;
    }
    job.status = 'sending';
    job.sendingAt = new Date().toISOString();
    try {
      await SchedulerService.writeJob(lockPath, job);
    } catch (err) {
      // Nothing was sent yet: put the file back where it was.
      await fs.rename(lockPath, filePath).catch(() => {});
      throw err;
    }
    // From here on, filePath is stale — use lockPath until we move to sent/

    let sendResult: { messageId: string };
    try {
      // Send — preserve threading headers
      sendResult = await this.smtpService.sendEmail(job.account, {
        to: job.to,
        subject: job.subject,
        body: job.body,
        cc: job.cc,
        bcc: job.bcc,
        html: job.html,
        inReplyTo: job.inReplyTo,
        references: job.references,
      });
    } catch (err) {
      await this.settleFailedSend(job, file, lockPath, filePath, err, result);
      return;
    }

    // The mail is out. Whatever happens next, this job must never be sent again.
    job.status = 'sent';
    job.sentAt = new Date().toISOString();
    job.sentMessageId = sendResult.messageId;
    delete job.sendingAt;
    delete job.retryAfter;
    result.sent += 1;
    void audit.log(
      'scheduled_send',
      job.account,
      { scheduleId: job.id, to: job.to, subject: job.subject },
      'ok',
    );

    try {
      await SchedulerService.writeJob(path.join(SCHEDULED_SENT_DIR, file), job);
      await fs.unlink(lockPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      const warning = `The email was sent, but its sent record could not be saved (${reason}). It will not be sent again.`;
      result.errors.push(`${file}: ${warning}`);
      job.lastError = warning;
      try {
        // Keep it visible as "sent" in the queue folder.
        await SchedulerService.writeJob(lockPath, job);
        await fs.rename(lockPath, filePath);
      } catch {
        // The .sending file stays; a later scan marks it "unknown", never pending.
      }
    }

    // Delete draft (best-effort)
    if (job.draftMessageId && job.draftMailbox) {
      try {
        await this.imapService.trashDraft(
          job.account,
          Number(job.draftMessageId),
          job.draftMailbox,
          job.draftUidValidity,
        );
      } catch {
        // Best-effort
      }
    }
  }

  /** Decide what a failed send means: unknown, try again later, or failed. */
  // eslint-disable-next-line class-methods-use-this
  private async settleFailedSend(
    job: ScheduledEmail,
    file: string,
    lockPath: string,
    filePath: string,
    err: unknown,
    result: CheckResult,
  ): Promise<void> {
    const message = err instanceof Error ? err.message : String(err);
    delete job.sendingAt;
    job.lastError = message;

    if (err instanceof UncertainSendError) {
      // Never retried on its own: the server may have accepted it.
      job.status = 'unknown';
      result.unknown += 1;
    } else if (isTemporaryProblem(err)) {
      // No connection, rate limit, duplicate guard: nothing was sent and
      // nothing was refused, so this is not an attempt. Back off instead.
      job.status = 'pending';
      job.retries = (job.retries ?? 0) + 1;
      job.retryAfter = new Date(
        Date.now() + Math.min(RETRY_BASE_MS * 2 ** (job.retries - 1), RETRY_MAX_MS),
      ).toISOString();
      result.deferred += 1;
    } else {
      // The server refused it (bad recipient, refused login...).
      job.attempts += 1;
      job.status = job.attempts >= MAX_ATTEMPTS ? 'failed' : 'pending';
      if (job.status === 'pending') {
        job.retryAfter = new Date(Date.now() + RETRY_BASE_MS * job.attempts).toISOString();
      } else {
        result.failed += 1;
      }
    }
    result.errors.push(`${file}: ${message}`);

    if (job.status !== 'pending') {
      void audit.log(
        'scheduled_send',
        job.account,
        { scheduleId: job.id, to: job.to, subject: job.subject, status: job.status },
        'error',
        message,
      );
    }

    try {
      await SchedulerService.writeJob(lockPath, job);
      await fs.rename(lockPath, filePath);
    } catch {
      // The .sending file stays and a later scan marks it "unknown": safe.
    }
  }
  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private static async ensureDirs(): Promise<void> {
    await fs.mkdir(SCHEDULED_DIR, { recursive: true, mode: 0o700 });
    await fs.mkdir(SCHEDULED_SENT_DIR, { recursive: true, mode: 0o700 });
    await fs.chmod(SCHEDULED_DIR, 0o700).catch(() => {});
    await fs.chmod(SCHEDULED_SENT_DIR, 0o700).catch(() => {});
  }

  private static async writeScheduledFile(scheduled: ScheduledEmail): Promise<void> {
    await SchedulerService.ensureDirs();
    await SchedulerService.writeJob(path.join(SCHEDULED_DIR, `${scheduled.id}.json`), scheduled);
  }

  private static async writeJob(filePath: string, job: ScheduledEmail): Promise<void> {
    await fs.writeFile(filePath, JSON.stringify(job, null, 2), { mode: 0o600 });
    await fs.chmod(filePath, 0o600).catch(() => {});
  }

  /** Read one job file; undefined when it is missing or corrupted. */
  private static async readJob(filePath: string): Promise<ScheduledEmail | undefined> {
    try {
      return JSON.parse(await fs.readFile(filePath, 'utf-8')) as ScheduledEmail;
    } catch {
      return undefined;
    }
  }

  private static async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /** A job marked "sending" for longer than the lock window: its sender is gone. */
  private static isStaleSending(job: ScheduledEmail, now: number): boolean {
    const since = job.sendingAt
      ? new Date(job.sendingAt).getTime()
      : new Date(job.createdAt).getTime();
    return now - since > STALE_LOCK_MS;
  }

  /**
   * Read job files. With `includeInFlight`, also the `.json.sending` files,
   * so a job being sent (or left by a crash) is visible instead of vanishing.
   */
  private static async readDir(
    dirPath: string,
    includeInFlight: boolean,
  ): Promise<ScheduledEmail[]> {
    const emails: ScheduledEmail[] = [];
    try {
      const files = await fs.readdir(dirPath);
      // eslint-disable-next-line no-restricted-syntax
      for (const file of files) {
        const inFlight = file.endsWith('.json.sending');
        if (!file.endsWith('.json') && !(includeInFlight && inFlight)) continue; // eslint-disable-line no-continue
        const job = await SchedulerService.readJob(path.join(dirPath, file)); // eslint-disable-line no-await-in-loop
        if (!job) continue; // eslint-disable-line no-continue
        if (
          inFlight &&
          job.status === 'sending' &&
          SchedulerService.isStaleSending(job, Date.now())
        ) {
          job.status = 'unknown';
          job.lastError = INTERRUPTED_MESSAGE;
        }
        emails.push(job);
      }
    } catch {
      // Directory may not exist yet
    }
    return emails;
  }
}
