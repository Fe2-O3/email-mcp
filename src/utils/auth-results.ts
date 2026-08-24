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

function verdictFor(results: string[], mechanism: RegExp): AuthVerdict {
  let found: AuthVerdict | undefined;
  for (const value of results) {
    const m = new RegExp(`${mechanism.source}[ \t]*=[ \t]*([a-z]+)`, 'i').exec(value);
    if (!m) continue;
    const v = m[1].toLowerCase();
    if (!KNOWN_VERDICTS.has(v)) continue;
    if (v === 'pass') return 'pass';
    found ??= v as AuthVerdict;
  }
  return found ?? 'none';
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
    spf: verdictFor(results, /spf/i),
    dkim,
    dkimSignatures,
    dmarc: verdictFor(results, /dmarc/i),
  };
}
