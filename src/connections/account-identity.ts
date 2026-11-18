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

/** The fingerprint of the account a name points at now, or undefined when there is none. */
export function currentFingerprint(
  connections: {
    getAccount: (name: string) => { username: string; imap: { host: string; port: number } };
  },
  name: string,
): string | undefined {
  try {
    return accountFingerprint(connections.getAccount(name));
  } catch {
    return undefined;
  }
}
