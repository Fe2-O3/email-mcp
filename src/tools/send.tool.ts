/**
 * MCP tools: send_email, reply_email, forward_email
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import audit from '../safety/audit.js';
import { MAX_EMAIL_BODY_LENGTH, validateInputLength } from '../safety/validation.js';

import type SmtpService from '../services/smtp.service.js';
import {
  attachmentInput,
  dryRunFailure,
  dryRunParam,
  dryRunResult,
  toOutgoingAttachments,
} from './schema-helpers.js';

export default function registerSendTools(server: McpServer, smtpService: SmtpService): void {
  // ---------------------------------------------------------------------------
  // send_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'send_email',
    {
      title: 'Send email',
      description: 'Send a new email. Supports plain text or HTML body, CC, and BCC.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        to: z
          .array(z.email({ pattern: z.regexes.html5Email }))
          .min(1)
          .describe('Recipient email addresses'),
        subject: z.string().describe('Email subject'),
        body: z.string().max(MAX_EMAIL_BODY_LENGTH).describe('Email body content'),
        cc: z
          .array(z.email({ pattern: z.regexes.html5Email }))
          .optional()
          .describe('CC recipients'),
        bcc: z
          .array(z.email({ pattern: z.regexes.html5Email }))
          .optional()
          .describe('BCC recipients'),
        html: z.boolean().default(false).describe('Send as HTML (default: plain text)'),
        attachments: z
          .array(attachmentInput)
          .optional()
          .describe('Files to attach: base64 parts or absolute local file paths'),
        message_id: z
          .string()
          .optional()
          .describe(
            'Explicit Message-ID for retries. Use it so a retried send deduplicates instead of delivering twice.',
          ),
        allow_duplicate: z
          .boolean()
          .default(false)
          .describe('Deliberately resend the same recipients+subject within one minute'),
        dryRun: dryRunParam,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        validateInputLength(params.subject, 998, 'Subject');
        validateInputLength(params.body, MAX_EMAIL_BODY_LENGTH, 'Body');
        const sendOptions = {
          ...params,
          attachments: toOutgoingAttachments(params.attachments),
          messageId: params.message_id,
          allowDuplicate: params.allow_duplicate,
        };
        if (params.dryRun) {
          return dryRunResult(await smtpService.previewSend(params.account, sendOptions));
        }
        const result = await smtpService.sendEmail(params.account, sendOptions);
        await audit.log(
          'send_email',
          params.account,
          { to: params.to, subject: params.subject },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email sent successfully!\nTo: ${params.to.join(', ')}\nSubject: ${params.subject}\nMessage-ID: ${result.messageId}`,
            },
          ],
        };
      } catch (err) {
        if (params.dryRun) return dryRunFailure(err);
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'send_email',
          params.account,
          { to: params.to, subject: params.subject },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to send email: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // reply_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'reply_email',
    {
      title: 'Reply email',
      description:
        'Reply to an email with proper threading (In-Reply-To & References headers). Use get_email first to read the original.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        emailId: z.string().describe('Email ID to reply to (from list_emails or get_email)'),
        mailbox: z.string().default('INBOX').describe('Mailbox where the original email is'),
        body: z.string().max(MAX_EMAIL_BODY_LENGTH).describe('Reply body content'),
        replyAll: z.boolean().default(false).describe('Reply to all recipients'),
        html: z.boolean().default(false).describe('Send as HTML'),
        attachments: z
          .array(attachmentInput)
          .optional()
          .describe('Files to attach: base64 parts or absolute local file paths'),
        allow_duplicate: z
          .boolean()
          .default(false)
          .describe(
            'Deliberately reply to the same email again. Use it only after checking the Sent folder.',
          ),
        dryRun: dryRunParam,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        validateInputLength(params.body, MAX_EMAIL_BODY_LENGTH, 'Body');
        const replyOptions = {
          ...params,
          attachments: toOutgoingAttachments(params.attachments),
          allowDuplicate: params.allow_duplicate,
        };
        if (params.dryRun) {
          return dryRunResult(await smtpService.previewReply(params.account, replyOptions));
        }
        const result = await smtpService.replyToEmail(params.account, replyOptions);
        await audit.log(
          'reply_email',
          params.account,
          { emailId: params.emailId, mailbox: params.mailbox },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: [
                '✅ Reply sent successfully!',
                `To: ${(result.to ?? []).join(', ')}`,
                ...(result.cc && result.cc.length > 0 ? [`Cc: ${result.cc.join(', ')}`] : []),
                `Message-ID: ${result.messageId}`,
                ...(result.warnings ?? []).map((w) => `⚠️ ${w}`),
              ].join('\n'),
            },
          ],
        };
      } catch (err) {
        if (params.dryRun) return dryRunFailure(err);
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'reply_email',
          params.account,
          { emailId: params.emailId, mailbox: params.mailbox },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to reply: ${errMsg}`,
            },
          ],
        };
      }
    },
  );

  // ---------------------------------------------------------------------------
  // forward_email
  // ---------------------------------------------------------------------------
  server.registerTool(
    'forward_email',
    {
      title: 'Forward email',
      description:
        'Forward an email to new recipients with optional additional message. Original email is quoted below.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        emailId: z.string().describe('Email ID to forward (from list_emails or get_email)'),
        mailbox: z.string().default('INBOX').describe('Mailbox where the original email is'),
        to: z
          .array(z.email({ pattern: z.regexes.html5Email }))
          .min(1)
          .describe('Forward to these recipients'),
        body: z
          .string()
          .max(MAX_EMAIL_BODY_LENGTH)
          .optional()
          .describe('Additional message above the forwarded content'),
        cc: z
          .array(z.email({ pattern: z.regexes.html5Email }))
          .optional()
          .describe('CC recipients'),
        include_attachments: z
          .boolean()
          .default(true)
          .describe('Reattach the original email\u2019s attachments (default: true)'),
        html: z.boolean().default(false).describe('Send as HTML (default: plain text)'),
        attachments: z
          .array(attachmentInput)
          .optional()
          .describe(
            'Extra files to attach besides the original\u2019s: base64 parts or absolute local file paths',
          ),
        allow_duplicate: z
          .boolean()
          .default(false)
          .describe(
            'Deliberately forward the same email to the same people again. Use it only after checking the Sent folder.',
          ),
        dryRun: dryRunParam,
      }),
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    async (params) => {
      try {
        if (params.body !== undefined) {
          validateInputLength(params.body, MAX_EMAIL_BODY_LENGTH, 'Body');
        }
        const forwardOptions = {
          ...params,
          attachments: toOutgoingAttachments(params.attachments),
          includeAttachments: params.include_attachments,
          allowDuplicate: params.allow_duplicate,
        };
        if (params.dryRun) {
          return dryRunResult(await smtpService.previewForward(params.account, forwardOptions));
        }
        const result = await smtpService.forwardEmail(params.account, forwardOptions);
        await audit.log(
          'forward_email',
          params.account,
          { to: params.to, emailId: params.emailId },
          'ok',
        );
        return {
          content: [
            {
              type: 'text' as const,
              text: `✅ Email forwarded successfully!\nTo: ${params.to.join(', ')}\nMessage-ID: ${result.messageId}`,
            },
          ],
        };
      } catch (err) {
        if (params.dryRun) return dryRunFailure(err);
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'forward_email',
          params.account,
          { to: params.to, emailId: params.emailId },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to forward: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
