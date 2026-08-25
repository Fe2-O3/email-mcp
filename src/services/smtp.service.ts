/**
 * SMTP service — pure business logic for email send operations.
 *
 * No MCP dependency — fully unit-testable.
 */

import crypto from 'node:crypto';

import type { Transporter } from 'nodemailer';
import type { IConnectionManager } from '../connections/types.js';
import { mcpLog } from '../logging.js';
import type RateLimiter from '../safety/rate-limiter.js';
import { sanitizeTemplateVariable } from '../safety/validation.js';
import type { SendResult } from '../types/index.js';
import type ImapService from './imap.service.js';

export default class SmtpService {
  constructor(
    private connections: IConnectionManager,
    private rateLimiter: RateLimiter,
    private imapService: ImapService,
  ) {}

  // -------------------------------------------------------------------------
  // Send email
  // -------------------------------------------------------------------------

  async sendEmail(
    accountName: string,
    options: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
      bcc?: string[];
      html?: boolean;
      /** Inline attachment parts. Content is base64; no filesystem paths are accepted. */
      attachments?: Array<{ filename?: string; content: string; contentType?: string }>;
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
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);
    this.assertNotDuplicate(accountName, options.to, options.subject, options.allowDuplicate);

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    const messageId =
      options.messageId ?? `<${crypto.randomUUID()}@${account.email.split('@')[1]}>`;
    const mailOptions = {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      bcc: options.bcc?.join(', '),
      subject: options.subject,
      ...(options.html ? { html: options.body } : { text: options.body }),
      messageId,
      ...(options.inReplyTo ? { inReplyTo: options.inReplyTo } : {}),
      ...(options.references ? { references: options.references.join(' ') } : {}),
      ...(options.attachments && options.attachments.length > 0
        ? {
            attachments: options.attachments.map((a) => ({
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

    const result = await this.sendWithRecovery(accountName, transport, mailOptions);

    this.fileToSent(accountName, mailOptions);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  // -------------------------------------------------------------------------
  // Reply
  // -------------------------------------------------------------------------

  async replyToEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      body: string;
      replyAll?: boolean;
      html?: boolean;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    // Build recipient list
    const to = [original.from.address];
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

    const subject = original.subject.startsWith('Re:')
      ? original.subject
      : `Re: ${original.subject}`;

    const transport = await this.connections.getSmtpTransport(accountName);

    const mailOptions = {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: to.join(', '),
      cc: cc.length > 0 ? cc.join(', ') : undefined,
      subject,
      inReplyTo: original.messageId,
      references: references.join(' '),
      messageId: `<${crypto.randomUUID()}@${account.email.split('@')[1]}>`,
      ...(options.html ? { html: options.body } : { text: options.body }),
    };

    const result = await this.sendWithRecovery(accountName, transport, mailOptions);

    this.fileToSent(accountName, mailOptions);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }

  // -------------------------------------------------------------------------
  // Forward
  // -------------------------------------------------------------------------

  async forwardEmail(
    accountName: string,
    options: {
      emailId: string;
      mailbox?: string;
      to: string[];
      body?: string;
      cc?: string[];
      html?: boolean;
      /** Defaults to true: a forward that silently drops the invoice is the bug. */
      includeAttachments?: boolean;
    },
  ): Promise<SendResult> {
    this.checkRateLimit(accountName);

    const account = this.connections.getAccount(accountName);
    const original = await this.imapService.getEmail(accountName, options.emailId, options.mailbox);

    const subject = original.subject.startsWith('Fwd:')
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

    const transport = await this.connections.getSmtpTransport(accountName);

    // Reattach the original's parts. Fetching happens before anything goes
    // out, and the fetch refuses oversized originals at compose time.
    const includeAttachments =
      options.includeAttachments === undefined ? true : options.includeAttachments;
    const attachments = includeAttachments
      ? await this.imapService.fetchMessageAttachments(
          accountName,
          options.emailId,
          options.mailbox ?? 'INBOX',
        )
      : [];

    const mailOptions = {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
      to: options.to.join(', '),
      cc: options.cc?.join(', '),
      subject,
      messageId: `<${crypto.randomUUID()}@${account.email.split('@')[1]}>`,
      ...(options.html ? { html: fullBody } : { text: fullBody }),
      ...(attachments.length > 0 ? { attachments } : {}),
      disableFileAccess: true,
      disableUrlAccess: true,
    };

    const result = await this.sendWithRecovery(accountName, transport, mailOptions);

    this.fileToSent(accountName, mailOptions);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
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
    this.recentSends.set(key, Date.now());
    // The record exists to catch retries minutes apart, not to grow forever.
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
    void (async () => {
      try {
        const { default: MailComposer } = await import('nodemailer/lib/mail-composer/index.js');
        const composer = new MailComposer(mailOptions as never);
        const raw = await composer.compile().build();
        const res = await this.imapService.appendSent(accountName, raw);
        if (!res.appended) {
          mcpLog('debug', 'smtp', `No Sent folder found for "${accountName}"; copy not filed`);
        }
      } catch {
        mcpLog('warning', 'smtp', `Sent-folder filing failed for "${accountName}"`);
      }
    })();
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
      throw err;
    }
  }

  // -------------------------------------------------------------------------
  // Send draft
  // -------------------------------------------------------------------------

  async sendDraft(accountName: string, draftId: number, mailbox?: string): Promise<SendResult> {
    this.checkRateLimit(accountName);

    // Fetch the draft via IMAP
    const { email: draft, mailbox: draftsPath } = await this.imapService.fetchDraft(
      accountName,
      draftId,
      mailbox,
    );

    const account = this.connections.getAccount(accountName);
    const transport = await this.connections.getSmtpTransport(accountName);

    const to = draft.to.map((a) => a.address).join(', ');
    const cc = draft.cc?.map((a) => a.address).join(', ');
    const bcc = draft.bcc?.map((a) => a.address).join(', ');

    // A draft saved with attachments must send with them. The draft's own
    // UID addresses its parts in the Drafts mailbox.
    const draftAttachments = await this.imapService.fetchMessageAttachments(
      accountName,
      String(draftId),
      draftsPath,
    );

    const mailOptions = {
      from: account.fullName ? `"${account.fullName}" <${account.email}>` : account.email,
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

    const result = await this.sendWithRecovery(accountName, transport, mailOptions);

    // Delete the draft after successful send
    await this.imapService.deleteDraft(accountName, draftId, draftsPath);

    this.fileToSent(accountName, mailOptions);

    return {
      messageId: result.messageId ?? '',
      status: 'sent',
    };
  }
}
