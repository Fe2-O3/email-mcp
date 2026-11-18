// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * Folders that delete_mailbox and rename_mailbox refuse.
 *
 * The server and every other mail client file into INBOX and the special-use folders (RFC 6154,
 * and RFC 8457 for \Important). Deleting one loses its mail; renaming one leaves the other
 * clients filing into a folder that no longer exists.
 */

import type { ImapFlow, ListResponse } from 'imapflow';

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

/**
 * The folder a name means once padding is gone: no surrounding spaces, no
 * leading "./", no leading, trailing or doubled hierarchy delimiter. " Sent",
 * "Sent/", "/Sent" and "Sent//" all mean Sent to the check below, so none of
 * them slips past it.
 */
export function normalizeMailboxPath(mailboxPath: string, delimiter: string): string {
  let name = mailboxPath.trim();
  if (delimiter === '/') {
    while (name.startsWith('./')) name = name.slice(2);
  }
  if (!delimiter) return name;
  return name
    .split(delimiter)
    .filter((part) => part.length > 0)
    .join(delimiter);
}

function protectedRole(mb: ListResponse): string | undefined {
  return PROTECTED_SPECIAL_USE.find((f) => mb.specialUse === f || mb.flags?.has(f));
}

/**
 * Refuse to delete or rename INBOX, a special-use or standard folder, or a
 * parent of one (on most servers the children go with the parent). Returns the
 * listed folder the name resolves to, if any, and the folders under it.
 */
export default async function assertMailboxRemovable(
  client: ImapFlow,
  mailboxPath: string,
  action: 'delete' | 'rename',
): Promise<{ listed?: ListResponse; children: ListResponse[] }> {
  const done = action === 'delete' ? 'deleted' : 'renamed';
  const mailboxes = await client.list();
  const anyDelimiter = mailboxes.find((mb) => mb.delimiter)?.delimiter ?? '/';
  const clean = normalizeMailboxPath(mailboxPath, anyDelimiter);
  if (!clean) {
    throw new Error('Mailbox name must not be empty');
  }
  const target = serverPath(client, clean);
  if (target === 'INBOX') {
    throw new Error(`INBOX cannot be ${done}.`);
  }
  // Compared without case: a provider that matches folder names case-insensitively
  // would otherwise act on "[gmail]/trash".
  const lower = target.toLowerCase();
  const listed = mailboxes.find((mb) => mb.path.toLowerCase() === lower);
  const role = listed ? protectedRole(listed) : undefined;
  if (role) {
    throw new Error(`"${mailboxPath}" is a special-use folder (${role}) and cannot be ${done}.`);
  }
  const delimiter = listed?.delimiter ?? anyDelimiter;
  if (isCommonName(target, client.namespace?.prefix, delimiter)) {
    throw new Error(`"${mailboxPath}" is a standard mail folder and cannot be ${done}.`);
  }
  const under = `${lower}${delimiter.toLowerCase()}`;
  const children = mailboxes.filter((mb) => mb.path.toLowerCase().startsWith(under));
  for (const child of children) {
    const childRole = protectedRole(child);
    if (
      childRole ||
      isCommonName(child.path, client.namespace?.prefix, child.delimiter ?? delimiter)
    ) {
      throw new Error(
        `"${mailboxPath}" contains the protected folder "${child.path}"${childRole ? ` (${childRole})` : ''}, so it cannot be ${done}.`,
      );
    }
  }
  return { listed, children };
}
