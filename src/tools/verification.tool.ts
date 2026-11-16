import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import ClipboardService from '../services/clipboard.service.js';
import type ImapService from '../services/imap.service.js';
import VerificationService from '../services/verification.service.js';
import type { AppConfig } from '../types/index.js';
import { verificationOutputSchema } from './schemas.js';

export default function registerVerificationTool(
  server: McpServer,
  imapService: ImapService,
  config: AppConfig,
): void {
  const verificationService = new VerificationService(imapService);
  const clipboard = new ClipboardService();

  server.registerTool(
    'get_verification_code',
    {
      title: 'Find a recent verification code',
      description:
        'Search recent mail on demand for a one-time verification code. ' +
        'The feature must be enabled in [settings.verification]. ' +
        'Magic links are only searched when include_magic_links is enabled. ' +
        'The code is returned in the result. Clipboard writes happen only when ' +
        'copy_to_clipboard=true; the clipboard is never read or cleared.',
      inputSchema: z.object({
        account: z
          .string()
          .optional()
          .describe('Account name; omit to scan all configured accounts'),
        mailbox: z.string().default('INBOX').describe('Mailbox to scan'),
        lookback_minutes: z.coerce
          .number()
          .int()
          .min(1)
          .max(240)
          .default(15)
          .describe('Only search messages from the last 1 to 240 minutes'),
        max_messages: z.coerce
          .number()
          .int()
          .min(1)
          .max(50)
          .default(20)
          .describe('Maximum recent messages to inspect per account'),
        copy_to_clipboard: z
          .boolean()
          .default(false)
          .describe('Explicitly copy the found code or link to the system clipboard'),
      }),
      outputSchema: verificationOutputSchema,
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (params) => {
      try {
        const accountNames = params.account
          ? [params.account]
          : config.accounts.map((account) => account.name);
        const hit = await verificationService.findLatest({
          accountNames,
          mailbox: params.mailbox,
          lookbackMinutes: params.lookback_minutes,
          maxMessages: params.max_messages,
          includeMagicLinks: config.settings.verification.includeMagicLinks,
        });

        if (!hit) {
          return {
            content: [
              {
                type: 'text' as const,
                text: `No verification code${config.settings.verification.includeMagicLinks ? ' or sign-in link' : ''} found in the last ${params.lookback_minutes} minutes.`,
              },
            ],
            structuredContent: { found: false, copied: false },
          };
        }

        let copied = false;
        let copyError: string | undefined;
        if (params.copy_to_clipboard) {
          if (config.settings.readOnly) {
            copyError = 'Clipboard writes are disabled in read-only mode.';
          } else {
            try {
              await clipboard.copy(hit.value);
              copied = true;
            } catch (err) {
              copyError = err instanceof Error ? err.message : String(err);
            }
          }
        }

        const ageSeconds = Math.max(0, Math.round((Date.now() - Date.parse(hit.date)) / 1000));
        const valueLabel = hit.kind === 'code' ? 'Code' : 'Sign-in link';
        const lines = [
          `${valueLabel} from ${hit.service}: ${hit.display}`,
          `From: ${hit.from}`,
          `Subject: ${hit.subject}`,
          `Account/mailbox: ${hit.account}/${hit.mailbox}`,
          `Age: ${ageSeconds}s${hit.confidence ? ` · Confidence: ${hit.confidence}` : ''}`,
        ];
        if (copied) lines.push('Copied to clipboard.');
        if (copyError) lines.push(`Could not copy to clipboard: ${copyError}`);

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
          structuredContent: {
            found: true,
            kind: hit.kind,
            value: hit.value,
            account: hit.account,
            mailbox: hit.mailbox,
            from: hit.from,
            subject: hit.subject,
            service: hit.service,
            date: hit.date,
            confidence: hit.confidence,
            copied,
            copy_error: copyError,
          },
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Could not search for a verification code: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
