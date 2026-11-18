// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * Folders that delete_mailbox and rename_mailbox refuse.
 *
 * The server and every other mail client file into INBOX and the special-use folders (RFC 6154,
 * and RFC 8457 for \Important). Deleting one loses its mail; renaming one leaves the other
 * clients filing into a folder that no longer exists.
 */

import type { ImapFlow } from 'imapflow';

export const PROTECTED_SPECIAL_USE = [
  '\\Trash',
  '\\Sent',
  '\\Drafts',
  '\\Junk',
  '\\Archive',
  '\\All',
  '\\Flagged',
  '\\Important',
];

/**
 * Names providers use for these folders. Matched against the whole path (below the namespace
 * prefix or INBOX.), never the last segment alone: "Projects/Archive" is the user's own folder.
 * They back up the server's own special-use flags for servers that do not send any.
 */
const COMMON_NAMES = new Set(
  [
    'Sent',
    'Sent Items',
    'Sent Mail',
    'Sent Messages',
    'Trash',
    'Deleted',
    'Deleted Items',
    'Deleted Messages',
    'Bin',
    'Drafts',
    'Junk',
    'Junk E-mail',
    'Junk Email',
    'Spam',
    'Archive',
    'Archives',
    'All Mail',
  ].map((n) => n.toLowerCase()),
);

const GMAIL_PREFIXES = ['[gmail]/', '[google mail]/'];

function isCommonName(path: string, prefix: string | undefined, delimiter: string): boolean {
  let name = path.toLowerCase();
  const p = prefix?.toLowerCase();
  if (p && name.startsWith(p)) name = name.slice(p.length);
  if (name.startsWith(`inbox${delimiter}`)) name = name.slice(6);
  name = name.replaceAll(delimiter, '/');
  const gmail = GMAIL_PREFIXES.find((g) => name.startsWith(g));
  if (gmail) name = name.slice(gmail.length);
  return COMMON_NAMES.has(name);
}

/** The path imapflow sends: INBOX in any case, and the personal namespace prefix prepended. */
function serverPath(client: ImapFlow, mailboxPath: string): string {
  if (mailboxPath.toUpperCase() === 'INBOX') return 'INBOX';
  const prefix = client.namespace?.prefix;
  return prefix && !mailboxPath.startsWith(prefix) ? `${prefix}${mailboxPath}` : mailboxPath;
}

export default async function assertMailboxRemovable(
  client: ImapFlow,
  mailboxPath: string,
  action: 'delete' | 'rename',
): Promise<void> {
  const done = action === 'delete' ? 'deleted' : 'renamed';
  const target = serverPath(client, mailboxPath);
  if (target === 'INBOX') {
    throw new Error(`INBOX cannot be ${done}.`);
  }
  // Compared without case: a provider that matches folder names case-insensitively
  // would otherwise act on "[gmail]/trash".
  const lower = target.toLowerCase();
  const mailboxes = await client.list();
  const listed = mailboxes.find((mb) => mb.path.toLowerCase() === lower);
  const role = listed
    ? PROTECTED_SPECIAL_USE.find((f) => listed.specialUse === f || listed.flags?.has(f))
    : undefined;
  if (role) {
    throw new Error(`"${mailboxPath}" is a special-use folder (${role}) and cannot be ${done}.`);
  }
  const delimiter = listed?.delimiter ?? mailboxes.find((mb) => mb.delimiter)?.delimiter ?? '/';
  if (isCommonName(target, client.namespace?.prefix, delimiter)) {
    throw new Error(`"${mailboxPath}" is a standard mail folder and cannot be ${done}.`);
  }
}
