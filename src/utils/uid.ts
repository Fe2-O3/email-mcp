/**
 * One message, one UID.
 *
 * ImapFlow takes a message id as an IMAP sequence set, so the text "1:*",
 * "1,2,3" or "*" names many messages (or, for "*", the newest one by position).
 * Every path that means one message parses its id here first, so a caller can
 * only ever name a single positive decimal UID.
 */

import type { ImapFlow } from 'imapflow';

/** UIDs are unsigned 32-bit numbers (RFC 9051 section 2.3.1.1). */
const MAX_UID = 4_294_967_295;

/**
 * Parse a single message UID. Accepts only a positive decimal number with no
 * sign, spaces, exponent, hex prefix or range syntax.
 */
export function parseUid(emailId: string): number {
  if (typeof emailId !== 'string' || !/^[1-9]\d*$/.test(emailId)) {
    throw new Error(
      `Email ID "${String(emailId)}" is not a numeric UID (one message only, no ranges). Get IDs from list_emails.`,
    );
  }
  const uid = Number(emailId);
  if (uid > MAX_UID) {
    throw new Error(`Email ID "${emailId}" is larger than any IMAP UID.`);
  }
  return uid;
}

/** Check a numeric UID (bulk ids, draft ids) the same way. */
export function assertUid(uid: number): number {
  if (!Number.isInteger(uid) || uid <= 0 || uid > MAX_UID) {
    throw new Error(`Email ID ${uid} is not a valid UID.`);
  }
  return uid;
}

/**
 * Which of `uids` exist in the mailbox the client has selected. A UID command
 * that names no message still gets a plain OK from the server, so a write that
 * must report honestly looks first. Caller holds the mailbox lock.
 */
export async function presentUids(client: ImapFlow, uids: number[]): Promise<Set<number>> {
  if (uids.length === 0) return new Set();
  const found = await client.search({ uid: uids.join(',') }, { uid: true });
  return new Set(Array.isArray(found) ? found : []);
}

/** Throw unless `uid` exists in the selected mailbox. Caller holds the mailbox lock. */
export async function assertUidPresent(
  client: ImapFlow,
  uid: number,
  mailbox: string,
): Promise<void> {
  const present = await presentUids(client, [uid]);
  if (!present.has(uid)) {
    throw new Error(`Email ${uid} not found in "${mailbox}". Nothing was changed.`);
  }
}
