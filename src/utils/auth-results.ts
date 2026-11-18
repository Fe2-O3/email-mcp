/**
 * Sender authentication signals, parsed from headers the server has already
 * fetched - no extra IMAP round trip.
 *
 * Two rules govern the verdicts:
 * - absent means none. A missing Authentication-Results header is not a
 *   passing check, and collapsing absence into any other verdict makes
 *   triage worse rather than better.
 * - only header-shaped lines count. A forged-looking "spf=pass" inside a
 *   display name or body never matches the key of a real header line.
 * - a sender can add Authentication-Results headers of its own, so only the
 *   topmost one (the receiving server adds its header last, on top) and headers
 *   whose authserv-id is the account's own mail host are trusted. See
 *   `selectTrustedAuthResults`. For SPF and DMARC a trusted fail beats a pass.
 */

export type AuthVerdict =
  | 'pass'
  | 'fail'
  | 'softfail'
  | 'neutral'
  | 'none'
  | 'temperror'
  | 'permerror';

/** Pull every Authentication-Results value out of a raw RFC 5322 header block. */
export function extractAuthenticationResults(headerBlock: string): string[] {
  const values: string[] = [];
  const lines = headerBlock.split(/\r?\n/);
  let current: string | null = null;

  for (const line of lines) {
    if (/^[ \t]/.test(line)) {
      // Folded continuation belongs to whichever header is open.
      if (current !== null) current += ` ${line.trim()}`;
      continue;
    }
    if (current !== null) {
      values.push(current);
      current = null;
    }
    const m = /^authentication-results:[ \t]*(.*)$/i.exec(line);
    if (m) current = m[1];
  }
  if (current !== null) values.push(current);

  return values.filter((v) => v.length > 0);
}

const KNOWN_VERDICTS = new Set([
  'pass',
  'fail',
  'softfail',
  'neutral',
  'none',
  'temperror',
  'permerror',
]);

function verdictFor(results: string[], mechanism: RegExp, failWins = false): AuthVerdict {
  let found: AuthVerdict | undefined;
  let passed = false;
  for (const value of results) {
    const m = new RegExp(`${mechanism.source}[ \t]*=[ \t]*([a-z]+)`, 'i').exec(value);
    if (!m) continue;
    const v = m[1].toLowerCase();
    if (!KNOWN_VERDICTS.has(v)) continue;
    if (v === 'pass') {
      if (!failWins) return 'pass';
      passed = true;
    } else if (failWins && v === 'fail') {
      return 'fail';
    } else {
      found ??= v as AuthVerdict;
    }
  }
  return passed ? 'pass' : (found ?? 'none');
}

/** The authserv-id (who wrote the header), or undefined when the value starts straight in on results. */
export function authservId(value: string): string | undefined {
  const head = value.split(';', 1)[0]?.trim() ?? '';
  if (head === '' || head.includes('=')) return undefined;
  return head.split(/\s+/, 1)[0]?.toLowerCase();
}

/**
 * Splits Authentication-Results values (topmost first, as `extractAuthenticationResults`
 * returns them) into the ones to believe and the rest. Trusted: the topmost, and any
 * whose authserv-id is one of the account's own mail hosts (equal, or one a subdomain of
 * the other). Everything else may have been written by the sender.
 */
export function selectTrustedAuthResults(
  values: string[],
  ownHosts: string[],
): { trusted: string[]; unverified: string[] } {
  const hosts = ownHosts.map((h) => h.trim().toLowerCase()).filter(Boolean);
  const isOwn = (id: string | undefined): boolean =>
    id !== undefined && hosts.some((h) => id === h || id.endsWith(`.${h}`) || h.endsWith(`.${id}`));
  const trusted: string[] = [];
  const unverified: string[] = [];
  values.forEach((value, index) => {
    if (index === 0 || isOwn(authservId(value))) trusted.push(value);
    else unverified.push(value);
  });
  return { trusted, unverified };
}

export interface AuthSignals {
  spf: AuthVerdict;
  /** Pass when ANY DKIM signature passes; otherwise the first verdict seen. */
  dkim: AuthVerdict;
  dkimSignatures: number;
  dmarc: AuthVerdict;
}

/** Collapse every Authentication-Results value into one verdict set. */
export function parseAuthSignals(results: string[]): AuthSignals {
  const dkim = verdictFor(results, /dkim/i);
  const dkimSignatures = results.reduce(
    (n, value) => n + (value.match(/dkim[ \t]*=/gi)?.length ?? 0),
    0,
  );
  return {
    spf: verdictFor(results, /spf/i, true),
    dkim,
    dkimSignatures,
    dmarc: verdictFor(results, /dmarc/i, true),
  };
}
