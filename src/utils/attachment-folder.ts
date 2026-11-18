/**
 * The folder one message's saved attachments go into. UIDs are numbered per mailbox, so the
 * mailbox is part of the name (with a short hash, so "a/b" and "a_b" stay apart): two
 * messages with the same UID in different folders never share a folder.
 */

import { createHash } from 'node:crypto';

const safe = (text: string): string => text.replace(/[^a-zA-Z0-9-_]/g, '_');

export default function attachmentFolderName(
  account: string,
  mailbox: string,
  emailId: string,
): string {
  const hash = createHash('sha256').update(mailbox).digest('hex').slice(0, 8);
  return `${safe(account)}-${safe(mailbox).slice(0, 40)}-${hash}-${safe(emailId)}`;
}
