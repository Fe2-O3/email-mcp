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

/**
 * Node socket and DNS codes that mean "the server could not be reached or the
 * link dropped", as opposed to "the server answered and said no".
 */
const NODE_CONNECTIVITY_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EPIPE',
]);

/** ImapFlow's own codes for a connection that is closed, missing or timed out. */
const IMAPFLOW_CONNECTIVITY_CODES = new Set([
  'EConnectionClosed',
  'NoConnection',
  'ETIMEOUT',
  'GREETING_TIMEOUT',
  'ClosedAfterConnectTLS',
  'ClosedAfterConnectText',
]);

/**
 * Whether an error means the server was unreachable, walking `cause` chains.
 *
 * Deliberately narrow: it gates serving cached mail as a stand-in for the
 * server, so a login failure, a missing message or a permission error must
 * never match — those are answers from a reachable server and must surface.
 */
export function isConnectivityError(err: unknown): boolean {
  const chain: Array<{ code?: unknown; authenticationFailed?: unknown }> = [];
  let current: unknown = err;
  // Bounded so a cyclic `cause` cannot loop forever.
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth += 1) {
    chain.push(current as { code?: unknown; authenticationFailed?: unknown });
    current = (current as { cause?: unknown }).cause;
  }

  if (chain.some((e) => e.authenticationFailed === true)) return false;
  return chain.some(
    (e) =>
      typeof e.code === 'string' &&
      (NODE_CONNECTIVITY_CODES.has(e.code) || IMAPFLOW_CONNECTIVITY_CODES.has(e.code)),
  );
}
