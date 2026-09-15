/**
 * MCP tool: download_attachment
 */

import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';

export default function registerAttachmentTools(server: McpServer, imapService: ImapService): void {
  server.registerTool(
    'download_attachment',
    {
      title: 'Download attachment',
      description:
        'Download an email attachment by filename. First use get_email to see available attachments and their filenames. ' +
        'By default returns base64-encoded content for files up to 5MB. ' +
        'For larger files, use savePath to write directly to disk (returns path + size + sha256). ' +
        'Warning: downloading many large attachments without savePath will flood the model context.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        id: z.string().describe('Email ID (UID) from list_emails or get_email'),
        mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
        filename: z.string().describe('Exact attachment filename (from get_email metadata)'),
        savePath: z
          .string()
          .optional()
          .describe(
            'Absolute path to save the file to (e.g. ~/Downloads/report.pdf). ' +
              'Parent directories are created automatically. ' +
              'When provided, returns path + size + sha256 instead of base64 content.',
          ),
      }),
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async ({ account, id, mailbox, filename, savePath }) => {
      try {
        const result = await imapService.downloadAttachment(account, id, mailbox, filename);

        // If savePath is provided, write to disk and return metadata only
        if (savePath) {
          // Expand ~ to home directory
          const resolvedPath = savePath.startsWith('~')
            ? join(process.env.HOME ?? '', savePath.slice(1))
            : savePath;

          // Create parent directories if needed
          await mkdir(dirname(resolvedPath), { recursive: true });

          // Decode base64 and write
          const content = Buffer.from(result.contentBase64, 'base64');
          await writeFile(resolvedPath, content);

          // Compute sha256
          const sha256 = createHash('sha256').update(content).digest('hex');

          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify(
                  {
                    saved: true,
                    path: resolvedPath,
                    filename: result.filename,
                    mimeType: result.mimeType,
                    size: result.size,
                    sizeHuman: `${Math.round(result.size / 1024)}KB`,
                    sha256,
                  },
                  null,
                  2,
                ),
              },
            ],
          };
        }

        // Default: return base64 content
        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify(
                {
                  filename: result.filename,
                  mimeType: result.mimeType,
                  size: result.size,
                  sizeHuman: `${Math.round(result.size / 1024)}KB`,
                },
                null,
                2,
              ),
            },
            {
              type: 'text' as const,
              text: `\n--- Base64 Content ---\n${result.contentBase64}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to download attachment: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
