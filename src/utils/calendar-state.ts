/**
 * One-shot calendar processing state.
 *
 * Tracks which emails have already been auto-processed for calendar/reminder
 * creation via the hook system. Once an email is marked as processed, the
 * auto-trigger is suppressed — the user must explicitly instruct the AI to
 * create further events or reminders for that email.
 *
 * Manual tool calls (add_to_calendar, create_reminder) always work regardless
 * of this state — it only gates the automatic hook trigger.
 */

import { chmod, mkdir, open, readFile, rename, rm, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { CALENDAR_STATE_FILE } from '../config/xdg.js';

const LOCK_FILE = `${CALENDAR_STATE_FILE}.lock`;

export type CalendarAction = 'event' | 'reminder' | 'both' | 'skipped';

export interface ProcessedEntry {
  processedAt: string;
  action: CalendarAction;
  title?: string;
}

interface StateFile {
  processedEmails: Record<string, ProcessedEntry>;
}

function stateKey(accountName: string, emailId: string): string {
  return `${accountName.replace(/\s+/g, '_')}__${emailId}`;
}

async function readState(): Promise<StateFile> {
  let raw: string;
  try {
    raw = await readFile(CALENDAR_STATE_FILE, 'utf8');
  } catch (err) {
    // Only "no file yet" means "nothing processed". Any other failure must not
    // look like an empty history: the next write would erase it.
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { processedEmails: {} };
    throw err;
  }
  return JSON.parse(raw) as StateFile;
}

async function writeState(state: StateFile): Promise<void> {
  await mkdir(dirname(CALENDAR_STATE_FILE), { recursive: true, mode: 0o700 });
  // Temp file then rename: a reader never sees a half-written file. Owner-only,
  // because it holds account names, mail ids and event titles.
  const tmp = `${CALENDAR_STATE_FILE}.tmp-${process.pid}-${Date.now()}`;
  try {
    await writeFile(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(tmp, CALENDAR_STATE_FILE);
  } catch (err) {
    await rm(tmp, { force: true });
    throw err;
  }
  await chmod(CALENDAR_STATE_FILE, 0o600);
}

/**
 * Acquire a file-based lock, execute fn, then release.
 * Uses exclusive file creation (O_CREAT | O_EXCL) to prevent concurrent writes.
 */
async function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  await mkdir(dirname(LOCK_FILE), { recursive: true, mode: 0o700 });

  const acquire = async (retries: number): Promise<Awaited<ReturnType<typeof open>>> => {
    try {
      return await open(LOCK_FILE, 'wx');
    } catch {
      if (retries <= 0) {
        // Stale lock fallback — force acquire after retries exhausted
        return open(LOCK_FILE, 'w');
      }
      return new Promise<Awaited<ReturnType<typeof open>>>((resolve) => {
        setTimeout(() => {
          resolve(acquire(retries - 1));
        }, 50);
      });
    }
  };

  const lockHandle = await acquire(20);

  try {
    return await fn();
  } finally {
    await lockHandle.close();
    await unlink(LOCK_FILE).catch(() => {});
  }
}

/** Returns true if this email has already been auto-processed by the hook system. */
export async function isCalendarProcessed(accountName: string, emailId: string): Promise<boolean> {
  const state = await readState();
  return stateKey(accountName, emailId) in state.processedEmails;
}

/** Marks an email as processed so the hook auto-trigger won't fire again. */
export async function markCalendarProcessed(
  accountName: string,
  emailId: string,
  action: CalendarAction,
  title?: string,
): Promise<void> {
  await withStateLock(async () => {
    const state = await readState();
    state.processedEmails[stateKey(accountName, emailId)] = {
      processedAt: new Date().toISOString(),
      action,
      title,
    };
    await writeState(state);
  });
}

/** Returns all processed entries (for inspection/debugging). */
export async function listCalendarProcessed(): Promise<{ key: string; entry: ProcessedEntry }[]> {
  const state = await readState();
  return Object.entries(state.processedEmails).map(([key, entry]) => ({ key, entry }));
}
