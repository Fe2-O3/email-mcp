// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * Input schema pieces shared by several tools.
 */

import { z } from 'zod';

import type { OutgoingAttachmentInput } from '../services/outgoing-attachments.js';

/**
 * One outgoing attachment: inline base64 bytes, or the absolute path of a local file.
 * A path is read by the server, and only from places `assertSafeReadPath` allows.
 */
export const attachmentInput = z
  .object({
    filename: z.string().optional().describe('Name shown to the recipient (default: file name)'),
    contentType: z.string().optional().describe('MIME type, e.g. application/pdf'),
    base64: z.string().min(1).optional().describe('Attachment bytes as base64 (or use path)'),
    path: z
      .string()
      .min(1)
      .optional()
      .describe(
        'Absolute path of a local file to attach (or use base64). Hidden files, system and app folders are refused.',
      ),
  })
  .refine((a) => (a.base64 === undefined) !== (a.path === undefined), {
    message: 'Give exactly one of "base64" or "path" for each attachment',
  });

export type AttachmentInput = z.infer<typeof attachmentInput>;

/** Map tool input to the shape the services take. */
export function toOutgoingAttachments(
  attachments: readonly AttachmentInput[] | undefined,
): OutgoingAttachmentInput[] | undefined {
  return attachments?.map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    content: a.base64,
    path: a.path,
  }));
}
