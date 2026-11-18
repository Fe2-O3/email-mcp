/**
 * The one-line warning shown when an email was served from the local cache
 * because the server could not be reached.
 */
export default function offlineNotice(email: {
  offline?: { cachedAt: string };
}): string | undefined {
  if (!email.offline) return undefined;
  return `⚠ Offline: served from local cache (cached ${email.offline.cachedAt}). Flags may be stale and the message may have been moved or deleted.`;
}

/** Warning shown when a message body (or a part of it) could not be downloaded. */
export function incompleteBodyNotice(email: { bodyIncomplete?: boolean }): string | undefined {
  if (!email.bodyIncomplete) return undefined;
  return '⚠ The message body could not be downloaded completely, so the text below may be missing or cut short. Do not treat an empty or short body as the whole message.';
}
