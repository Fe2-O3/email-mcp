/**
 * Audit logger — append-only JSON Lines log for all write operations.
 *
 * Logs are stored at the XDG data directory:
 *   ~/.local/share/email-mcp/audit.log
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { xdg } from '../config/xdg.js';
import { mcpLog } from '../logging.js';

import type { AuditEntry } from '../types/index.js';

const AUDIT_LOG_PATH = path.join(xdg.data, 'audit.log');

/** Fields redacted from audit params to protect sensitive data. */
const REDACTED_FIELDS = new Set(['password', 'body', 'bodyText', 'bodyHtml', 'content_base64']);

function redactParams(params: Record<string, unknown>): Record<string, unknown> {
  const cleaned: Record<string, unknown> = {};
  Object.entries(params).forEach(([key, value]) => {
    if (REDACTED_FIELDS.has(key)) {
      cleaned[key] = '[REDACTED]';
    } else if (value && typeof value === 'object' && !Array.isArray(value)) {
      cleaned[key] = redactParams(value as Record<string, unknown>);
    } else {
      cleaned[key] = value;
    }
  });
  return cleaned;
}

async function ensureLogDir(): Promise<void> {
  // The log holds recipients and subjects: owner-only folder and file.
  await fs.mkdir(path.dirname(AUDIT_LOG_PATH), { recursive: true, mode: 0o700 });
}

/** True after a failed write, so a full disk prints one warning, not one per action. */
let warned = false;

/**
 * Append a single audit entry to the log file.
 * Creates the directory and file if they don't exist.
 *
 * Never throws. The record is a side effect of an action that has already
 * happened, so a full or unwritable folder must not turn a finished send, move
 * or delete into a reported failure (the caller would retry it). The first
 * failure of a streak prints one warning to stderr.
 */
async function log(
  tool: string,
  account: string,
  params: Record<string, unknown>,
  result: 'ok' | 'error',
  error?: string,
): Promise<void> {
  try {
    await ensureLogDir();

    const entry: AuditEntry = {
      ts: new Date().toISOString(),
      tool,
      account,
      params: redactParams(params),
      result,
      ...(error ? { error } : {}),
    };

    const line = `${JSON.stringify(entry)}\n`;
    await fs.appendFile(AUDIT_LOG_PATH, line, { encoding: 'utf-8', mode: 0o600 });
    warned = false;
    // `mode` only applies when the file is created; tighten an older, wider one.
    try {
      await fs.chmod(AUDIT_LOG_PATH, 0o600);
    } catch {
      // The entry is already written; a failed tighten must not fail the action.
    }
  } catch (err) {
    if (!warned) {
      warned = true;
      const reason = err instanceof Error ? err.message : String(err);
      void mcpLog(
        'warning',
        'audit',
        `The audit log could not be written (${reason}). The action itself went ahead. Check the disk and the permissions of ${AUDIT_LOG_PATH}.`,
      );
    }
  }
}

const audit = { log, AUDIT_LOG_PATH } as const;

export default audit;
