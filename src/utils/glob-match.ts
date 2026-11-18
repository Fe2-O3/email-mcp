/**
 * Glob-like patterns for rule matching: `*` is any run of characters, `|`
 * separates alternatives, matching is case-insensitive and whole-value.
 * Shared by the config.toml hook rules and the local rules.
 *
 * Matching is done by a linear scan with one backtrack point, never by a
 * regular expression: a pattern such as `*a*a*a*a*b` made the regular
 * expression backtrack for seconds against a long subject and froze the
 * process. The scan costs at most (pattern length) x (value length) steps.
 */

/** Split a pattern into its `|` alternatives, trimmed, lowercased, with runs of `*` collapsed. */
function alternatives(pattern: string): string[] {
  return pattern
    .split('|')
    .map((p) => p.trim().toLowerCase().replace(/\*+/g, '*'))
    .filter(Boolean);
}

/** Whole-value glob match of one alternative against a value (both already lowercased). */
function globMatch(pattern: string, value: string): boolean {
  let p = 0;
  let v = 0;
  let starP = -1;
  let starV = 0;
  while (v < value.length) {
    if (p < pattern.length && pattern[p] === '*') {
      starP = p;
      starV = v;
      p += 1;
    } else if (p < pattern.length && pattern[p] === value[v]) {
      p += 1;
      v += 1;
    } else if (starP !== -1) {
      // Let the last star swallow one more character and try again.
      starV += 1;
      v = starV;
      p = starP + 1;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p += 1;
  return p === pattern.length;
}

/**
 * True when one `|` alternative of the pattern can match any value, so the
 * condition filters nothing: only `*`, `@` and `.` (such as `*`, `**`, `*@*`).
 */
export function isCatchAllPattern(pattern: string): boolean {
  return alternatives(pattern).some((alt) => /^[*@.\s]*$/.test(alt) && alt.includes('*'));
}

/** Test whether a value matches a glob pattern (case-insensitive). */
export function matchesPattern(pattern: string, value: string): boolean {
  const lowered = value.toLowerCase();
  return alternatives(pattern).some((alt) => globMatch(alt, lowered));
}
