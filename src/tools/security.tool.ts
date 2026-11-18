/**
 * MCP tools: get_email_security — sender authentication signals.
 *
 * A separate tool on purpose: get_email's output stays stable, and triage
 * that wants SPF/DKIM/DMARC can ask for exactly that without pulling the
 * body. Security subset only - no tracking URLs, no full header block.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import { delimitUntrusted } from '../safety/untrusted-content.js';
import type ImapService from '../services/imap.service.js';

export default function registerSecurityTools(server: McpServer, imapService: ImapService): void {
  server.registerTool(
    'get_email_security',
    {
      title: 'Get email security',
      description:
        'Report sender authentication signals for one email: SPF, DKIM and DMARC verdicts ' +
        'plus From-adjacent addresses (Reply-To, Return-Path). Absent headers are reported ' +
        'as none, never as pass. Only the top Authentication-Results header and headers from ' +
        "the account's own mail host count; others are shown as unverified text.",
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
        // The verdicts are ours. Reply-To, Return-Path and the Authentication-Results
        // headers nobody vouched for are text the sender wrote, so they are fenced.
        const fromMessage = [
          `Reply-To:    ${signals.replyTo ?? '(not set)'}`,
          `Return-Path: ${signals.returnPath ?? '(not set)'}`,
          ...signals.unverified.map((v, i) => `Unverified Authentication-Results ${i + 1}: ${v}`),
        ];
        const lines = [
          `🔐 Sender authentication for email ${emailId}:`,
          `   SPF:         ${signals.spf}`,
          `   DKIM:        ${signals.dkim}${signals.dkimSignatures > 0 ? ` (${signals.dkimSignatures} signature(s))` : ''}`,
          `   DMARC:       ${signals.dmarc}`,
          '',
          'none means the header was absent - it is not a passing check.',
          'Verdicts come from the top Authentication-Results header and headers written by your own mail host.' +
            (signals.unverified.length > 0
              ? ` ${signals.unverified.length} other header(s) were NOT trusted, because a sender can write its own; they are shown below as unverified.`
              : ''),
          delimitUntrusted(fromMessage.join('\n')),
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
