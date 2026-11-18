/**
 * A short, safe reason for a failed osascript / execFile call.
 *
 * Node's own error message is "Command failed: osascript -e <whole script>",
 * and the script carries email text (subject, location, body excerpt, ICS
 * UID). Nothing from the script may reach a tool result, so a failed command
 * gives its stderr, cut to 200 characters, or a fixed phrase.
 */
export default function osascriptFailure(err: unknown): string {
  const e = err as { message?: unknown; stderr?: unknown; killed?: unknown; signal?: unknown };
  if (e?.killed === true || e?.signal === 'SIGTERM') return 'the script timed out';
  const message = typeof e?.message === 'string' ? e.message : '';
  if (!message.startsWith('Command failed')) {
    return message.replace(/\s+/g, ' ').trim().slice(0, 200) || 'the script failed';
  }
  const stderr = typeof e?.stderr === 'string' ? e.stderr.replace(/\s+/g, ' ').trim() : '';
  return stderr ? stderr.slice(0, 200) : 'the script failed';
}
