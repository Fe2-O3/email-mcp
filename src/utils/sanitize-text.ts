/**
 * Cleaning for text that came from outside (mail headers, file names) and is shown on
 * one line or in a terminal.
 *
 * Removed: C0 controls and DEL, C1 controls (including the 8-bit escape U+009B), and the
 * bidirectional override and isolate characters that can make text read in another order.
 * Done by code point, with no regex holding the control characters.
 */

function isStripped(code: number, keepLayout: boolean): boolean {
  if (keepLayout && (code === 0x09 || code === 0x0a)) return false;
  return (
    code <= 0x1f ||
    (code >= 0x7f && code <= 0x9f) ||
    (code >= 0x202a && code <= 0x202e) || // embeddings and overrides
    (code >= 0x2066 && code <= 0x2069) || // isolates
    code === 0x200e ||
    code === 0x200f ||
    code === 0x061c
  );
}

/** Removes control and bidi characters. With `keepLayout`, newline and tab stay (for body text). */
export function stripControlChars(text: string, keepLayout = false): string {
  let out = '';
  for (const ch of text) {
    if (!isStripped(ch.codePointAt(0) as number, keepLayout)) out += ch;
  }
  return out;
}

/** One clean line: line breaks become spaces, controls go, length is capped. */
export function sanitizeInline(text: string, maxLength = 500): string {
  return stripControlChars(text.replace(/\r\n|[\r\n]/g, ' ')).slice(0, maxLength);
}
