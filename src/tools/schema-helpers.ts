// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * Input schema pieces shared by several tools.
 */

import { z } from 'zod';
import { delimitUntrusted } from '../safety/untrusted-content.js';
import type { OutgoingAttachmentInput } from '../services/outgoing-attachments.js';
import type { DryRunPlan } from '../types/index.js';

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

/** Reusable `dryRun` parameter for write tools. */
export const dryRunParam = z
  .boolean()
  .default(false)
  .describe(
    'Check everything and report what would happen, without changing anything (no send, move, delete or create)',
  );

/** Tool result for a dry run that passed every check. */
export function dryRunResult(plan: DryRunPlan) {
  const text = [
    `[DRY RUN] ${plan.summary}`,
    ...(plan.fromMessage?.length ? [delimitUntrusted(plan.fromMessage.join('\n'))] : []),
    ...plan.notes.map((n) => `- ${n}`),
    'Nothing was changed.',
  ];
  return { content: [{ type: 'text' as const, text: text.join('\n') }] };
}

/** Tool result for a dry run that found a problem a real run would hit. */
export function dryRunFailure(err: unknown) {
  const message = err instanceof Error ? err.message : String(err);
  return {
    isError: true,
    content: [
      { type: 'text' as const, text: `[DRY RUN] Would fail: ${message}. Nothing was changed.` },
    ],
  };
}
