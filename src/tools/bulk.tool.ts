/**
 * MCP tool: bulk_action — batch operations on multiple emails.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import audit from '../safety/audit.js';

import type ImapService from '../services/imap.service.js';
import type { BulkResult } from '../types/index.js';
import { uncertainWriteNote } from '../utils/imap-error.js';
import { dryRunFailure, dryRunParam, dryRunResult } from './schema-helpers.js';

const ACTIONS = ['mark_read', 'mark_unread', 'flag', 'unflag', 'move', 'delete'] as const;

export default function registerBulkTools(
  server: McpServer,
  imapService: ImapService,
  { allowDelete = true }: { allowDelete?: boolean } = {},
): void {
  // Without the "delete mail" box, the AI is never offered delete at all.
  const actions = allowDelete ? ACTIONS : ACTIONS.filter((a) => a !== 'delete');
  server.registerTool(
    'bulk_action',
    {
      title: 'Bulk action',
      description: `Batch operation on multiple emails by UID list. Supports ${actions.join(', ')}. Max 100 IDs per call. Returns success/failure counts.`,
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        mailbox: z.string().default('INBOX').describe('Source mailbox containing the emails'),
        action: z
          .enum(actions as [(typeof ACTIONS)[number], ...(typeof ACTIONS)[number][]])
          .describe('Bulk action to perform'),
        ids: z
          .array(z.number().int())
          .min(1)
          .max(100)
          .describe('Array of email UIDs (max 100). Get UIDs from list_emails or search_emails.'),
        destination: z
          .string()
          .optional()
          .describe("Destination mailbox — required when action is 'move'"),
        dryRun: dryRunParam,
      }),
      annotations: { readOnlyHint: false, destructiveHint: allowDelete },
    },
    async ({ account, mailbox, action, ids, destination, dryRun }) => {
      try {
        if (dryRun) {
          return dryRunResult(
            await imapService.previewBulk(account, ids, mailbox, action, destination),
          );
        }
        if (action === 'move' && !destination) {
          return {
            isError: true,
            content: [
              {
                type: 'text' as const,
                text: `Destination mailbox is required for "move" action.`,
              },
            ],
          };
        }

        let result: BulkResult;
        if (action === 'move') {
          result = await imapService.bulkMove(account, ids, mailbox, destination as string);
        } else if (action === 'delete') {
          // The schema already leaves delete out; this guards a client that skips it.
          if (!allowDelete) {
            return {
              isError: true,
              content: [
                {
                  type: 'text' as const,
                  text: 'Deleting is turned off. The owner can turn on "Delete mail" with: imap-wizard tools',
                },
              ],
            };
          }
          result = await imapService.bulkDelete(account, ids, mailbox);
        } else {
          result = await imapService.bulkSetFlags(account, ids, mailbox, action);
        }

        await audit.log(
          'bulk_action',
          account,
          {
            mailbox,
            action,
            ids: ids.length,
            succeeded: result.succeeded,
            failed: result.failed,
            destination,
          },
          // Only ids that exist are acted on, so a call that touched nothing is not "ok".
          result.succeeded > 0 ? 'ok' : 'error',
          result.errors?.join('; '),
        );

        return {
          // Nothing was acted on: say so as an error, not a quiet success.
          ...(result.succeeded === 0 && result.failed > 0 ? { isError: true } : {}),
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(result, null, 2),
            },
          ],
        };
      } catch (err) {
        if (dryRun) return dryRunFailure(err);
        const errMsg = err instanceof Error ? err.message : String(err);
        await audit.log(
          'bulk_action',
          account,
          { mailbox, action, ids: ids.length },
          'error',
          errMsg,
        );
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Bulk action failed: ${errMsg}${uncertainWriteNote(err)}`,
            },
          ],
        };
      }
    },
  );
}
