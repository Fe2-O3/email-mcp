// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * MCP tool: export_email
 *
 * Saves one message's raw RFC 822 source as a .eml file. Like download_attachment it
 * writes a local file only, never changes mail, and stays available in read_only mode.
 */

import { createHash } from 'node:crypto';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, sep } from 'node:path';

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type ImapService from '../services/imap.service.js';

/** Inline (base64) responses stay small; savePath may go larger. */
export const EXPORT_INLINE_MAX_BYTES = 5 * 1024 * 1024;
export const EXPORT_SAVE_MAX_BYTES = 50 * 1024 * 1024;

/**
 * Where an export lands. `~` expands to the home directory; the path must then be
 * absolute. An existing directory (or a path ending in a separator) receives the
 * generated filename, so a message can never choose its own file name. An existing
 * file is never overwritten.
 */
export async function writeEmlFile(
  savePath: string,
  generatedName: string,
  source: Buffer,
): Promise<string> {
  const expanded = savePath.startsWith('~')
    ? join(process.env.HOME ?? '', savePath.slice(1))
    : savePath;
  if (!isAbsolute(expanded)) {
    throw new Error('savePath must be an absolute path (or start with ~)');
  }
  const info = await stat(expanded).catch(() => undefined);
  const target =
    info?.isDirectory() || expanded.endsWith(sep) || expanded.endsWith('/')
      ? join(expanded, generatedName)
      : expanded;
  await mkdir(dirname(target), { recursive: true });
  try {
    // 'wx' fails instead of replacing a file that is already there.
    await writeFile(target, source, { flag: 'wx' });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      throw new Error(`Refusing to overwrite existing file: ${target}`);
    }
    throw err;
  }
  return target;
}

export default function registerExportTools(server: McpServer, imapService: ImapService): void {
  server.registerTool(
    'export_email',
    {
      title: 'Export email',
      description:
        'Export one email as its raw RFC 822 source (.eml): headers, body and attachments, byte for byte. ' +
        'Use it to archive the message itself. Does NOT mark the email as seen or change any flag. ' +
        'By default returns base64 for messages up to 5MB. ' +
        'Use savePath (absolute path or ~/..., a file or an existing directory) to write the .eml to disk, up to 50MB; ' +
        'it returns path + size + sha256 and refuses to overwrite an existing file.',
      inputSchema: z.object({
        account: z.string().describe('Account name from list_accounts'),
        emailId: z.string().describe('Email ID (UID) from list_emails or get_email'),
        mailbox: z.string().default('INBOX').describe('Mailbox containing the email'),
        savePath: z
          .string()
          .optional()
          .describe(
            'Absolute path to write the .eml to, or an existing directory to receive <YYYY-MM-DD>_<uid>.eml. ' +
              'Parent directories are created. An existing file is not overwritten.',
          ),
      }),
      // Writes a local file when savePath is set, never mail.
      annotations: {
        readOnlyHint: false,
        destructiveHint: false,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ account, emailId, mailbox, savePath }) => {
      try {
        const result = await imapService.exportEmail(
          account,
          emailId,
          mailbox,
          savePath ? EXPORT_SAVE_MAX_BYTES : EXPORT_INLINE_MAX_BYTES,
        );
        const meta = {
          filename: result.filename,
          mimeType: result.mimeType,
          size: result.size,
          sizeHuman: `${Math.round(result.size / 1024)}KB`,
        };

        if (savePath) {
          const savedTo = await writeEmlFile(savePath, result.filename, result.source);
          const sha256 = createHash('sha256').update(result.source).digest('hex');
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ saved: true, path: savedTo, ...meta, sha256 }, null, 2),
              },
            ],
          };
        }

        return {
          content: [
            { type: 'text' as const, text: JSON.stringify(meta, null, 2) },
            {
              type: 'text' as const,
              text: `\n--- Base64 Content ---\n${result.source.toString('base64')}`,
            },
          ],
        };
      } catch (err) {
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to export email: ${err instanceof Error ? err.message : String(err)}`,
            },
          ],
        };
      }
    },
  );
}
