/**
 * Which mailbox an account name stands for. Scheduled mail, local rules and
 * the local mirror are filed under the name alone; when the name is pointed at
 * another server or login, what was filed under it belongs to a different
 * mailbox and must not act on, or be served for, the new one.
 */

import crypto from 'node:crypto';

/** The IMAP server, port and login of an account, hashed: the same mailbox gives the same value. */
export default function accountFingerprint(account: {
  username: string;
  imap: { host: string; port: number };
}): string {
  const identity = `${account.imap.host.trim().toLowerCase()}:${account.imap.port}\n${account.username.trim().toLowerCase()}`;
  return crypto.createHash('sha256').update(identity).digest('hex').slice(0, 32);
}
