/**
 * MCP tools: get_email_security — sender authentication signals.
 *
 * A separate tool on purpose: get_email's output stays stable, and triage
 * that wants SPF/DKIM/DMARC can ask for exactly that without pulling the
 * body. Security subset only - no tracking URLs, no full header block.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import type ImapService from '../services/imap.service.js';

export default function registerSecurityTools(server: McpServer, imapService: ImapService): void {
  server.registerTool(
    'get_email_security',
    {
      title: 'Get email security',
      description:
        'Report sender authentication signals for one email: SPF, DKIM and DMARC verdicts ' +
        'plus From-adjacent addresses (Reply-To, Return-Path). Absent headers are reported ' +
        'as none, never as pass.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        emailId: z.string().describe('Email ID from list_emails or search_emails'),
        mailbox: z.string().default('INBOX').describe('Mailbox where the email is'),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account, emailId, mailbox }) => {
      try {
        const signals = await imapService.getEmailSecurity(account, emailId, mailbox);
        const lines = [
          `🔐 Sender authentication for email ${emailId}:`,
          `   SPF:         ${signals.spf}`,
          `   DKIM:        ${signals.dkim}${signals.dkimSignatures > 0 ? ` (${signals.dkimSignatures} signature(s))` : ''}`,
          `   DMARC:       ${signals.dmarc}`,
          `   Reply-To:    ${signals.replyTo ?? '(not set)'}`,
          `   Return-Path: ${signals.returnPath ?? '(not set)'}`,
          '',
          'none means the header was absent - it is not a passing check.',
        ];
        return { content: [{ type: 'text' as const, text: lines.join('\n') }] };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to read security signals: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
