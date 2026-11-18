import { sanitizeInline, stripControlChars } from './sanitize-text.js';

describe('stripControlChars', () => {
  it('removes C0, DEL, C1 (including the 8-bit escape) and bidi controls', () => {
    const dirty = `a\u001b[31mb\u009b[0mc\u0007d\u007fe‮f⁦g⁩h‎i`;
    expect(stripControlChars(dirty)).toBe('a[31mb[0mcdefghi');
  });

  it('keeps newline and tab only when asked, and ordinary text always', () => {
    expect(stripControlChars('a\n\tb\r')).toBe('ab');
    expect(stripControlChars('a\n\tb\r', true)).toBe('a\n\tb');
    expect(stripControlChars('Grüße 日本語 😀')).toBe('Grüße 日本語 😀');
  });
});

describe('sanitizeInline', () => {
  it('turns line breaks into spaces and caps the length', () => {
    expect(sanitizeInline('a\r\nb\nc\rd')).toBe('a b c d');
    expect(sanitizeInline('x'.repeat(600))).toHaveLength(500);
    expect(sanitizeInline('abcdef', 3)).toBe('abc');
  });
});
