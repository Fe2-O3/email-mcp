/**
 * A small line diff for previews: `-` removed, `+` added, two spaces unchanged.
 * Long unchanged runs are folded to a count. Above a size cap it reports a
 * whole-script replacement instead of spending quadratic time.
 */

const CONTEXT = 2;
const MAX_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.replace(/\r\n/g, '\n').replace(/\n$/, '').split('\n');
}

export function lineDiff(before: string, after: string): string[] {
  const a = splitLines(before);
  const b = splitLines(after);
  if (a.length * b.length > MAX_CELLS) {
    return [`- (all ${a.length} old lines)`, `+ (all ${b.length} new lines)`];
  }

  // Longest common subsequence table, filled from the end.
  const cols = b.length + 1;
  const lcs = new Uint32Array((a.length + 1) * cols);
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      lcs[i * cols + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * cols + j + 1] as number) + 1
          : Math.max(lcs[(i + 1) * cols + j] as number, lcs[i * cols + j + 1] as number);
    }
  }

  const raw: string[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      raw.push(`  ${a[i]}`);
      i += 1;
      j += 1;
    } else if (
      i < a.length &&
      (j >= b.length || (lcs[(i + 1) * cols + j] as number) >= (lcs[i * cols + j + 1] as number))
    ) {
      // Removals before additions, as in a unified diff.
      raw.push(`- ${a[i]}`);
      i += 1;
    } else {
      raw.push(`+ ${b[j]}`);
      j += 1;
    }
  }

  // Fold unchanged runs, keeping a little context around each change.
  const changed = raw.map((line) => !line.startsWith('  '));
  const keep = raw.map((_line, k) =>
    changed.slice(Math.max(0, k - CONTEXT), k + CONTEXT + 1).some(Boolean),
  );
  const out: string[] = [];
  let folded = 0;
  raw.forEach((line, k) => {
    if (keep[k]) {
      if (folded > 0) out.push(`  … (${folded} unchanged line${folded === 1 ? '' : 's'})`);
      folded = 0;
      out.push(line);
    } else {
      folded += 1;
    }
  });
  if (folded > 0) out.push(`  … (${folded} unchanged line${folded === 1 ? '' : 's'})`);
  return out;
}
