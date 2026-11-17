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
