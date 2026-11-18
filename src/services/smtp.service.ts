/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import crypto from 'node:crypto';

import type { Transporter } from 'nodemailer';
import { DEFAULT_SEND_LIMIT_MB, resolveSendLimitMb } from '../config/send-limit.js';
import { redactedError, sentCredentials } from '../connections/credential-redaction.js';
import type { IConnectionManager } from '../connections/types.js';
import { mcpLog } from '../logging.js';
import type RateLimiter from '../safety/rate-limiter.js';
import { sanitizeTemplateVariable } from '../safety/validation.js';
import type { DryRunPlan, SendResult } from '../types/index.js';
import type ImapService from './imap.service.js';
import {
  type OutgoingAttachmentInput,
  resolveOutgoingAttachments,
} from './outgoing-attachments.js';

/** Reply markers: Re (English), AW (German), SV (Nordic). */
export const REPLY_PREFIX = /^\s*(re|aw|sv)\s*:/i;
/** Forward markers: Fwd, Fw, WG (German). */
export const FORWARD_PREFIX = /^\s*(fwd?|wg)\s*:/i;

export interface SendEmailOptions {
  to: string[];
  subject: string;
  body: string;
  cc?: string[];
  bcc?: string[];
  html?: boolean;
  /** Attachments: inline base64 `content`, or the `path` of a local file (checked by the read guard). */
  attachments?: OutgoingAttachmentInput[];
  /**
   * Explicit Message-ID for retries. Without it nodemailer mints a fresh
   * one per attempt, so a retried send is indistinguishable from a new
   * email and the recipient sees both.
   */
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  /** Set on a deliberate resend to pass the duplicate-send guard. */
  allowDuplicate?: boolean;
}

export interface ReplyOptions {
  emailId: string;
  mailbox?: string;
  body: string;
  replyAll?: boolean;
  html?: boolean;
  attachments?: OutgoingAttachmentInput[];
}

export interface ForwardOptions {
  emailId: string;
  mailbox?: string;
  to: string[];
  body?: string;
  cc?: string[];
  html?: boolean;
  /** Defaults to true: a forward that silently drops the invoice is the bug. */
  includeAttachments?: boolean;
  /** Extra attachments added to the forward: inline base64 `content`, or a local file `path`. */
  attachments?: OutgoingAttachmentInput[];
}

export default class SmtpService {
  private readonly pendingSentFilings = new Set<Promise<void>>();

  constructor(
    private connections: IConnectionManager,
    private rateLimiter: RateLimiter,
    private imapService: ImapService,
    private globalAttachmentLimitMb = DEFAULT_SEND_LIMIT_MB,
  ) {}

  // -------------------------------------------------------------------------
  // Send email
  // -------------------------------------------------------------------------

  async sendEmail(accountName: string, options: SendEmailOptions): Promise<SendResult> {
    this.checkRateLimit(accountName);
    this.assertNotDuplicate(accountName, options.to, options.subject, options.allowDuplicate);

    const mailOptions = await this.composeSend(accountName, options);
    const transport = await this.connections.getSmtpTransport(accountName);

    const result = await this.sendWithRecovery(accountName, transport, mailOptions);

    this.recordDuplicate(accountName, options.to, options.subject);
    this.fileToSent(accountName, mailOptions);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  /** Everything `sendEmail` checks and builds, without sending, filing or counting against the rate limit. */
  async previewSend(accountName: string, options: SendEmailOptions): Promise<DryRunPlan> {
    this.assertRateLimitAvailable(accountName);
    this.assertNotDuplicate(accountName, options.to, options.subject, options.allowDuplicate);
    const mailOptions = await this.composeSend(accountName, options);
    return SmtpService.describeMail('send this email', mailOptions);
  }

  private async composeSend(
    accountName: string,
    options: SendEmailOptions,
  ): Promise<Record<string, unknown>> {
    const account = this.connections.getAccount(accountName);
    const attachments = await this.resolveAttachments(account, options.attachments);

    const messageId =
      options.messageId ?? `<${crypto.randomUUID()}@${account.email.split('@')[1]}>`;
    return {
      from: account.fullName ? { name: account.fullName, address: account.email } : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      subject: options.subject,
      ...(options.html ? { html: options.body } : { text: options.body }),
      messageId,
      ...(options.inReplyTo ? { inReplyTo: options.inReplyTo } : {}),
      ...(options.references ? { references: options.references.join(' ') } : {}),
      ...(attachments.length > 0
        ? {
            attachments: attachments.map((a) => ({
              filename: a.filename,
              content: a.content,
              encoding: 'base64' as const,
              contentType: a.contentType,
            })),
          }
        : {}),
      disableFileAccess: true,
      disableUrlAccess: true,
    };
  }

  // -------------------------------------------------------------------------
  // Reply
  // -------------------------------------------------------------------------

  async replyToEmail(accountName: string, options: ReplyOptions): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const mailOptions = await this.composeReply(accountName, options);
    const transport = await this.connections.getSmtpTransport(accountName);

    const result = await this.sendWithRecovery(accountName, transport, mailOptions);

    this.fileToSent(accountName, mailOptions);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  /** Everything `replyToEmail` checks and builds, without sending or counting against the rate limit. */
  async previewReply(accountName: string, options: ReplyOptions): Promise<DryRunPlan> {
    this.assertRateLimitAvailable(accountName);
    const mailOptions = await this.composeReply(accountName, options);
    return SmtpService.describeMail('send this reply', mailOptions);
  }

  private async composeReply(
    accountName: string,
    options: ReplyOptions,
  ): Promise<Record<string, unknown>> {
    const account = this.connections.getAccount(accountName);
    const extraAttachments = await this.resolveAttachments(account, options.attachments);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    // Build recipient list — Reply-To overrides From when present
    const to = [original.replyTo?.address ?? original.from.address];
    const cc: string[] = [];

    if (options.replyAll) {
      // Add all original To recipients except ourselves
      original.to
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          to.push(addr.address);
        });
      // Add CC recipients except ourselves
      (original.cc ?? [])
        .filter((addr) => addr.address !== account.email)
        .forEach((addr) => {
          cc.push(addr.address);
        });
    }

    // Build threading headers
    const references = [...(original.references ?? []), original.messageId].filter(Boolean);

    // Any existing reply marker, in any case or common locale (RE:, re:, AW:, SV:),
    // counts: otherwise replies stack "Re: RE: ..." (upstream #102).
    const subject = REPLY_PREFIX.test(original.subject)
      ? original.subject
      : `Re: ${original.subject}`;

    return {
      from: account.fullName ? { name: account.fullName, address: account.email } : account.email,
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject,
      inReplyTo: original.messageId,
      references: references.join(' '),
      messageId: `<${crypto.randomUUID()}@${account.email.split('@')[1]}>`,
      ...(options.html ? { html: options.body } : { text: options.body }),
      ...(extraAttachments.length
        ? {
            attachments: extraAttachments.map((attachment) => ({
              filename: attachment.filename,
              content: attachment.content,
              encoding: 'base64' as const,
              contentType: attachment.contentType,
            })),
          }
        : {}),
      disableFileAccess: true,
      disableUrlAccess: true,
    };
  }

  // -------------------------------------------------------------------------
  // Forward
  // -------------------------------------------------------------------------

  async forwardEmail(accountName: string, options: ForwardOptions): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const mailOptions = await this.composeForward(accountName, options);
    const transport = await this.connections.getSmtpTransport(accountName);

    const result = await this.sendWithRecovery(accountName, transport, mailOptions);

    this.fileToSent(accountName, mailOptions);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  /** Everything `forwardEmail` checks and builds, without sending or counting against the rate limit. */
  async previewForward(accountName: string, options: ForwardOptions): Promise<DryRunPlan> {
    this.assertRateLimitAvailable(accountName);
    const mailOptions = await this.composeForward(accountName, options);
    return SmtpService.describeMail('forward this email', mailOptions);
  }

  private async composeForward(
    accountName: string,
    options: ForwardOptions,
  ): Promise<Record<string, unknown>> {
    const account = this.connections.getAccount(accountName);
    const extraAttachments = await this.resolveAttachments(account, options.attachments);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    const subject = FORWARD_PREFIX.test(original.subject)
      ? original.subject
      : `Fwd: ${original.subject}`;

    const from = original.from.name
      ? `${original.from.name} <${original.from.address}>`
      : original.from.address;
    const to = original.to.map((a) => a.address).join(', ');

    // Every field below comes from a message someone else composed, so the HTML
    // branch escapes them. Interpolating an attacker-chosen display name into
    // the markup of a message the user is forwarding onward is HTML injection.
    const esc = (value: string) => sanitizeTemplateVariable(value, true);

    let fullBody: string;
    if (options.html) {
      const forwardHeader = [
        '<br><hr>',
        '<div>---------- Forwarded message ----------<br>',
        `From: ${esc(from)}<br>`,
        `Date: ${esc(original.date)}<br>`,
        `Subject: ${esc(original.subject)}<br>`,
        `To: ${esc(to)}</div><br>`,
      ].join('');

      // Prefer the original's HTML part; a plain-text original goes in a <pre>
      // so its line breaks survive, rather than collapsing into one paragraph.
      const originalBody = original.bodyHtml ?? `<pre>${esc(original.bodyText ?? '')}</pre>`;

      fullBody = (options.body ?? '') + forwardHeader + originalBody;
    } else {
      const forwardHeader = [
        '',
        '---------- Forwarded message ----------',
        `From: ${from}`,
        `Date: ${original.date}`,
        `Subject: ${original.subject}`,
        `To: ${to}`,
        '',
      ].join('\n');

      const originalBody = original.bodyText ?? original.bodyHtml ?? '';
      fullBody = (options.body ?? '') + forwardHeader + originalBody;
    }

    // Reattach the original's parts. Fetching happens before anything goes
    // out, and the fetch refuses oversized originals at compose time.
    const includeAttachments =
      options.includeAttachments === undefined ? true : options.includeAttachments;
    const originalAttachments = includeAttachments
      ? await this.imapService.fetchMessageAttachments(
          accountName,
          options.emailId,
          options.mailbox ?? 'INBOX',
          this.sendLimitMb(account) * 1024 * 1024,
        )
      : [];
    const attachments = [
      ...originalAttachments,
      ...extraAttachments.map((a) => ({ ...a, encoding: 'base64' as const })),
    ];
    const totalBytes = attachments.reduce((n, a) => n + Buffer.byteLength(a.content, 'utf8'), 0);
    if (totalBytes > this.sendLimitMb(account) * 1024 * 1024) {
      throw new Error(
        `The original's attachments plus the added ones exceed the ${this.sendLimitMb(account)} MB send limit.`,
      );
    }

    return {
      from: account.fullName ? { name: account.fullName, address: account.email } : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject,
      messageId: `<${crypto.randomUUID()}@${account.email.split('@')[1]}>`,
      ...(options.html ? { html: fullBody } : { text: fullBody }),
      ...(attachments.length > 0 ? { attachments } : {}),
      disableFileAccess: true,
      disableUrlAccess: true,
    };
  }

  // -------------------------------------------------------------------------
  // Rate limit check
  // -------------------------------------------------------------------------

  private checkRateLimit(accountName: string): void {
    if (!this.rateLimiter.tryConsume(accountName)) {
      throw new Error(
        `Rate limit exceeded for account "${accountName}". ` +
          `Please wait before sending more emails.`,
      );
    }
  }

  /** Like `checkRateLimit`, but does not use up a send. */
  private assertRateLimitAvailable(accountName: string): void {
    if (this.rateLimiter.remaining(accountName) < 1) {
      throw new Error(
        `Rate limit exceeded for account "${accountName}". ` +
          `Please wait before sending more emails.`,
      );
    }
  }

  /** Turn a composed message into a dry-run report. Nothing in it is sent. */
  private static describeMail(verb: string, mail: Record<string, unknown>): DryRunPlan {
    const list = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
    const from = mail.from as string | { name?: string; address: string };
    const fromText = typeof from === 'string' ? from : from.address;
    const attachments = (mail.attachments ?? []) as Array<{
      filename?: string;
      content: string;
    }>;
    const bodyText = String(mail.html ?? mail.text ?? '');
    const notes = [
      `From: ${fromText}`,
      `To: ${list(mail.to) ?? '(none)'}`,
      ...(list(mail.cc) ? [`Cc: ${list(mail.cc)}`] : []),
      ...(list(mail.bcc) ? [`Bcc: ${list(mail.bcc)}`] : []),
      `Subject: ${String(mail.subject ?? '')}`,
      ...(list(mail.inReplyTo) ? [`In reply to: ${list(mail.inReplyTo)}`] : []),
      `Body: ${bodyText.length} characters${mail.html ? ' (HTML)' : ''}`,
      ...attachments.map(
        (a) =>
          `Attachment: ${a.filename ?? '(unnamed)'}, ${Buffer.from(a.content, 'base64').length} bytes`,
      ),
    ];
    return { summary: `Would ${verb}.`, notes };
  }

  private sendLimitMb(account: ReturnType<IConnectionManager['getAccount']>): number {
    return resolveSendLimitMb(account, this.globalAttachmentLimitMb);
  }

  /** Read path attachments through the read guard and enforce the send limit on the base64 total. */
  private resolveAttachments(
    account: ReturnType<IConnectionManager['getAccount']>,
    attachments: OutgoingAttachmentInput[] | undefined,
  ) {
    return resolveOutgoingAttachments(attachments, {
      maxEncodedBytes: this.sendLimitMb(account) * 1024 * 1024,
    });
  }

  /**
   * Recent sends, keyed by account | recipients | subject. A retried send is
   * otherwise indistinguishable from a new one: nodemailer mints a fresh
   * random Message-ID per attempt, so a timeout-then-retry delivers twice and
   * mailbox providers file both copies.
   */
  private readonly recentSends = new Map<string, number>();

  /** Window in which an identical account+recipients+subject send is refused. */
  private static readonly DUPLICATE_SEND_WINDOW_MS = 60_000;

  private assertNotDuplicate(
    accountName: string,
    to: string[],
    subject: string,
    allowDuplicate?: boolean,
  ): void {
    const key = `${accountName}|${to.slice().sort().join(',')}|${subject}`;
    const last = this.recentSends.get(key);
    if (
      last !== undefined &&
      Date.now() - last < SmtpService.DUPLICATE_SEND_WINDOW_MS &&
      !allowDuplicate
    ) {
      throw new Error(
        `An email with the same recipients and subject was sent less than a minute ago. ` +
          `If this is a deliberate resend, set allow_duplicate to true.`,
      );
    }
  }

  private recordDuplicate(accountName: string, to: string[], subject: string): void {
    const key = `${accountName}|${to.slice().sort().join(',')}|${subject}`;
    this.recentSends.set(key, Date.now());
    if (this.recentSends.size > 1000) {
      const cutoff = Date.now() - SmtpService.DUPLICATE_SEND_WINDOW_MS;
      for (const [k, ts] of this.recentSends) {
        if (ts < cutoff) this.recentSends.delete(k);
        if (this.recentSends.size <= 500) break;
      }
    }
  }

  /**
   * File a sent message into the Sent folder, best effort. SMTP already
   * succeeded: an APPEND failure is logged as a warning and never surfaces as
   * a failed send - the mail went out either way.
   *
   * The raw message is composed locally via MailComposer — the SMTP transport
   * does not return it (only json/stream transports set `info.message`).
   */
  private fileToSent(accountName: string, mailOptions: Record<string, unknown>): void {
    const filing = (async () => {
      try {
        const { default: MailComposer } = await import('nodemailer/lib/mail-composer/index.js');
        const composer = new MailComposer(mailOptions as never);
        const raw = await composer.compile().build();
        const res = await this.imapService.appendSent(accountName, raw);
        if (!res.appended) {
          mcpLog('debug', 'smtp', `No Sent folder found for "${accountName}"; copy not filed`);
        }
      } catch (err) {
        const reason = err instanceof Error ? err.message : String(err);
        mcpLog('warning', 'smtp', `Sent-folder filing failed for "${accountName}": ${reason}`);
      }
    })();
    this.pendingSentFilings.add(filing);
    void filing.then(
      () => this.pendingSentFilings.delete(filing),
      () => this.pendingSentFilings.delete(filing),
    );
  }

  /** Wait for best-effort Sent-folder copies before a one-shot CLI closes connections. */
  async waitForSentFilings(): Promise<void> {
    await Promise.all(this.pendingSentFilings);
  }

  /**
   * Send through the pooled transport, and on failure evict it. A pooled SMTP
   * socket that died between messages would otherwise be handed to every
   * later send: only a health check ever re-verified the cache, so the send
   * path wedged until restart. Evicting lets the next call dial fresh.
   */
  private async sendWithRecovery(
    accountName: string,
    transport: Transporter,
    payload: Record<string, unknown>,
  ): Promise<{ messageId?: string; message?: Buffer }> {
    try {
      return (await transport.sendMail(payload as never)) as {
        messageId?: string;
        message?: Buffer;
      };
    } catch (err) {
      this.connections.invalidateSmtpTransport(accountName);
      // A refused login can quote the password or token the server was sent.
      throw redactedError(err, sentCredentials(this.connections.getAccount(accountName)));
    }
  }

  // -------------------------------------------------------------------------
  // Send draft
  // -------------------------------------------------------------------------

  async sendDraft(accountName: string, draftId: number, mailbox?: string): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const { mailOptions, draftsPath } = await this.composeDraft(accountName, draftId, mailbox);
    const transport = await this.connections.getSmtpTransport(accountName);

    const result = await this.sendWithRecovery(accountName, transport, mailOptions);

    // The sent draft goes to Trash, never a plain permanent delete.
    const warnings = await this.imapService.trashDraft(accountName, draftId, draftsPath);

    this.fileToSent(accountName, mailOptions);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
      ...(warnings.length > 0 ? { warnings } : {}),
    };
  }

  /** Everything `sendDraft` checks and builds, without sending, deleting the draft or using up a send. */
  async previewSendDraft(
    accountName: string,
    draftId: number,
    mailbox?: string,
  ): Promise<DryRunPlan> {
    this.assertRateLimitAvailable(accountName);
    const { mailOptions, draftsPath } = await this.composeDraft(accountName, draftId, mailbox);
    if (!mailOptions.to && !mailOptions.cc && !mailOptions.bcc) {
      throw new Error(`Draft ${draftId} has no recipients. Add some before sending it.`);
    }
    const plan = SmtpService.describeMail('send this draft', mailOptions);
    plan.notes.push(`The draft would then be moved from "${draftsPath}" to Trash.`);
    return plan;
  }

  private async composeDraft(
    accountName: string,
    draftId: number,
    mailbox?: string,
  ): Promise<{ mailOptions: Record<string, unknown>; draftsPath: string }> {
    // Fetch the draft via IMAP
    const { email: draft, mailbox: draftsPath } = await this.imapService.fetchDraft(
      accountName,
      draftId,
      mailbox,
    );

    const account = this.connections.getAccount(accountName);

    const to = draft.to.map((a) => a.address).join(', ');
    const cc = draft.cc?.map((a) => a.address).join(', ');
    const bcc = draft.bcc?.map((a) => a.address).join(', ');

    // A draft saved with attachments must send with them. The draft's own
    // UID addresses its parts in the Drafts mailbox.
    const draftAttachments = await this.imapService.fetchMessageAttachments(
      accountName,
      String(draftId),
      draftsPath,
      this.sendLimitMb(account) * 1024 * 1024,
    );

    const mailOptions = {
      from: account.fullName ? { name: account.fullName, address: account.email } : account.email,
      to,
      cc,
      bcc,
      subject: draft.subject,
      messageId: `<${crypto.randomUUID()}@${account.email.split('@')[1]}>`,
      inReplyTo: draft.inReplyTo,
      references: draft.references?.join(' '),
      ...(draft.bodyHtml ? { html: draft.bodyHtml } : { text: draft.bodyText ?? '' }),
      ...(draftAttachments.length > 0 ? { attachments: draftAttachments } : {}),
      disableFileAccess: true,
      disableUrlAccess: true,
    };
    return { mailOptions, draftsPath };
  }
}
