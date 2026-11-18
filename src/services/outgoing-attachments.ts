// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * Turn outgoing attachment inputs into base64 parts.
 *
 * A caller gives either inline `content` (base64) or a local file `path`. A path is read here,
 * after `assertSafeReadPath` has judged it, and handed on as base64 `content`. Nodemailer is
 * never given the path: it is also built with file and URL access disabled.
 */

import { constants as fsConstants } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';

import { assertSafeReadPath, type LocalPathOptions } from '../safety/local-paths.js';
import { safeFileName } from '../utils/save-file.js';

export interface OutgoingAttachmentInput {
  filename?: string;
  contentType?: string;
  /** Inline bytes as base64. */
  content?: string;
  /** Absolute path of a local file. */
  path?: string;
}

export interface ResolvedOutgoingAttachment {
  filename?: string;
  /** Base64. */
  content: string;
  contentType?: string;
}

export interface ResolveOutgoingAttachmentOptions {
  /** Cap on the combined base64-encoded size, in bytes. Unlimited when omitted. */
  maxEncodedBytes?: number;
  /** Passed to the read guard. Tests use it to fence a fake home. */
  guard?: Omit<LocalPathOptions, 'allowRoots' | 'within'>;
}

const encodedSize = (rawBytes: number): number => Math.ceil(rawBytes / 3) * 4;

function limitError(maxEncodedBytes: number, name: string | undefined): Error {
  const mb = Math.floor(maxEncodedBytes / (1024 * 1024));
  return new Error(
    `Attachments${name ? ` (${name})` : ''} exceed the ${mb} MB send limit (base64-encoded). ` +
      `Reduce the attachments or set max_attachment_mb for this account if its provider allows more.`,
  );
}

async function readLocalFile(
  filePath: string,
  budget: number,
  limitBytes: number | undefined,
  guard: ResolveOutgoingAttachmentOptions['guard'],
): Promise<Buffer> {
  const real = await assertSafeReadPath(filePath, guard);
  // O_NOFOLLOW refuses a final-component symlink swapped in after the check.
  // eslint-disable-next-line no-bitwise
  const fh = await fs.open(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const st = await fh.stat();
    if (!st.isFile()) throw new Error(`Refusing to read: not a regular file: ${filePath}`);
    if (limitBytes !== undefined && encodedSize(st.size) > budget) {
      throw limitError(limitBytes, path.basename(filePath));
    }
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < st.size) {
      // A single read can return short.
      // eslint-disable-next-line no-await-in-loop
      const { bytesRead } = await fh.read(buf, offset, st.size - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return buf.subarray(0, offset);
  } finally {
    await fh.close();
  }
}

export async function resolveOutgoingAttachments(
  attachments: readonly OutgoingAttachmentInput[] | undefined,
  options: ResolveOutgoingAttachmentOptions = {},
): Promise<ResolvedOutgoingAttachment[]> {
  if (!attachments?.length) return [];
  const limit = options.maxEncodedBytes;
  let used = 0;
  const out: ResolvedOutgoingAttachment[] = [];
  // eslint-disable-next-line no-restricted-syntax -- the combined cap must see each file before the next is read
  for (const att of attachments) {
    if (att.path !== undefined && att.content !== undefined) {
      throw new Error('Each attachment takes either "path" or "base64", not both');
    }
    if (att.path === undefined && att.content === undefined) {
      throw new Error('Each attachment needs either "path" (a local file) or "base64"');
    }
    let content: string;
    let filename = att.filename;
    if (att.path !== undefined) {
      // eslint-disable-next-line no-await-in-loop
      const raw = await readLocalFile(
        att.path,
        limit === undefined ? Number.POSITIVE_INFINITY : limit - used,
        limit,
        options.guard,
      );
      content = raw.toString('base64');
      filename = safeFileName(att.filename ?? path.basename(att.path), 'attachment');
    } else {
      ({ content } = att as { content: string });
    }
    used += Buffer.byteLength(content, 'utf8');
    if (limit !== undefined && used > limit) throw limitError(limit, filename);
    out.push({
      ...(filename !== undefined ? { filename } : {}),
      content,
      ...(att.contentType !== undefined ? { contentType: att.contentType } : {}),
    });
  }
  return out;
}
