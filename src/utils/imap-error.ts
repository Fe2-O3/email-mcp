/**
 * Turning IMAP protocol failures into messages a caller can act on.
 */

/**
 * Run an IMAP command, replacing ImapFlow's generic failure with what the
 * server actually said.
 *
 * On a tagged NO/BAD response ImapFlow throws `Error('Command failed')` and
 * puts the raw server line on `.response`. Login failures instead carry the
 * server's reason on `.responseText` — both are read here, so a refusal the
 * server explained precisely reaches the user as prose, not as "Command failed".
 *
 * Errors carrying no server response, such as a socket reset, are passed
 * through untouched: rewriting those would obscure the real cause.
 *
 * @param operation what was being attempted, phrased for a human
 * @param run the ImapFlow call
 */
export async function imapCommand<T>(operation: string, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    const e = err as { response?: unknown; responseText?: unknown };
    // Login failures put the server's reason on `responseText`, not `response`
    // — reading only `response` is why a bad password surfaced as "Command failed".
    const response =
      typeof e.response === 'string' && e.response.length > 0
        ? e.response
        : typeof e.responseText === 'string' && e.responseText.length > 0
          ? e.responseText
          : undefined;
    if (response === undefined) throw err;

    // Strip the leading command tag ("6 NO ", "a7 BAD ") so it reads as prose.
    const detail = response.replace(/^\S+\s+(NO|BAD)\s+/i, '').trim();
    throw new Error(`${operation} rejected by server: ${detail || response}`, { cause: err });
  }
}
