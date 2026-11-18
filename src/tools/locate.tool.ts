/**
 * MCP tool: find_email_folder
 *
 * Locates the real mailbox folder(s) containing an email.
 * Essential when working with virtual folders like "All Mail" or "Starred",
 * which don't support IMAP MOVE operations.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import { delimitUntrusted } from '../safety/untrusted-content.js';
import type ImapService from '../services/imap.service.js';

export default function registerLocateTools(server: McpServer, imapService: ImapService): void {
  server.registerTool(
    'find_email_folder',
    {
      title: 'Find email folder',
      description:
        'Find a real mailbox folder an email belongs to. ' +
        'Required before move_email or delete_email when the email was found in a virtual folder ' +
        '(e.g., "All Mail", "Starred"). Returns the first real folder path found, to use as ' +
        "sourceMailbox, and the email's UID in that folder. UIDs are numbered per folder, so use " +
        'the UID returned here with that folder, not the original emailId. On a label-based server ' +
        'a message may also sit in other folders.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        emailId: z.string().describe('Email ID (UID) from list_emails'),
        sourceMailbox: z
          .string()
          .default('INBOX')
          .describe('Mailbox where the email is currently visible (e.g., "All Mail")'),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ account, emailId, sourceMailbox }) => {
      try {
        const { folders, messageId, uids } = await imapService.findEmailFolder(
          account,
          emailId,
          sourceMailbox,
        );

        if (folders.length === 0) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No real folder found for email ${emailId}. It may only exist in virtual folders.`,
              },
            ],
          };
        }

        const folder = folders[0];
        const lines = [`📁 Email ${emailId} found in:`, ...folders.map((f) => `  • ${f}`), ''];
        if (uids && uids.length === 1) {
          lines.push(
            `In "${folder}" this email has UID ${uids[0]}. For move_email or delete_email use ` +
              `emailId ${uids[0]} with sourceMailbox "${folder}"` +
              (String(uids[0]) === emailId
                ? '.'
                : `, not ${emailId}: UIDs are numbered per folder, so ${emailId} there is a different email or none.`),
          );
        } else if (uids && uids.length > 1) {
          lines.push(
            `More than one email in "${folder}" has this Message-ID (UIDs ${uids.join(', ')}). ` +
              `Check which one is meant with get_email before you move or delete, and do not use ${emailId} there.`,
          );
        } else {
          lines.push(`Use this as sourceMailbox for move_email or delete_email.`);
        }
        if (messageId) {
          lines.push(delimitUntrusted(`Message-ID: ${messageId}`));
        }

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to locate email: ${errMsg}`,
            },
          ],
        };
      }
    },
  );
}
