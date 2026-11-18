/**
 * The forwarding allowlist: `sieve.allowed_redirects` in config.toml.
 *
 * A silent forwarding rule leaks every future email. A model can be steered by
 * the content of an email, so a `confirm: true` argument protects nothing. The
 * only thing that can allow a forward is this list, and only a human edits it:
 * no MCP tool reads-modifies-writes config.toml, and no tool argument bypasses
 * the list. Sieve `redirect` / `notify mailto:` and the local-rule forward action
 * all check here.
 *
 * Entries are exact addresses (`alice@example.com`) or exact domains
 * (`example.com` or `@example.com`). A domain does not cover its subdomains, and
 * wildcards are refused, so the list says exactly what it allows.
 */

const DOMAIN =
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
// RFC 5322 dot-atom characters. Quoted local parts are refused: they are rare,
// and refusing a real address is the safe failure.
const LOCAL_PART = /^[a-z0-9!#$%&'+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'+/=?^_`{|}~-]+)*$/;

export type AllowlistEntry = { kind: 'address'; value: string } | { kind: 'domain'; value: string };

/**
 * True when every character is plain ASCII. Checked BEFORE lowercasing: the Kelvin
 * sign (U+212A) lowercases to a plain "k", so "work.example" spelled with it
 * would otherwise pass as the allowed domain.
 */
function isAscii(value: string): boolean {
  for (let i = 0; i < value.length; i += 1) {
    if (value.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}

/** Splits a plain `local@domain` address, lowercased; null for anything else. */
export function parsePlainAddress(raw: string): { local: string; domain: string } | null {
  let value = raw.trim();
  if (value.startsWith('<') && value.endsWith('>')) value = value.slice(1, -1).trim();
  if (!isAscii(value)) return null;
  value = value.toLowerCase();
  const at = value.lastIndexOf('@');
  if (at <= 0 || at === value.length - 1) return null;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  if (local.length > 64 || !LOCAL_PART.test(local) || !DOMAIN.test(domain)) return null;
  return { local, domain };
}

/** Parses one allowlist entry, or returns the reason it is refused. */
export function parseAllowlistEntry(raw: string): AllowlistEntry | { error: string } {
  if (!isAscii(raw)) return { error: `"${raw}": only plain ASCII characters are allowed` };
  const value = raw.trim().toLowerCase();
  if (value === '') return { error: 'empty entry' };
  if (value.includes('*')) {
    return { error: `"${raw}": wildcards are not allowed; list an address or a bare domain` };
  }
  if (value.startsWith('@')) {
    const domain = value.slice(1);
    return DOMAIN.test(domain)
      ? { kind: 'domain', value: domain }
      : { error: `"${raw}" is not a valid domain` };
  }
  if (value.includes('@')) {
    const parsed = parsePlainAddress(value);
    return parsed
      ? { kind: 'address', value: `${parsed.local}@${parsed.domain}` }
      : { error: `"${raw}" is not a plain email address` };
  }
  return DOMAIN.test(value)
    ? { kind: 'domain', value }
    : { error: `"${raw}" is neither an email address nor a domain` };
}

/**
 * True only when `target` is one plain address that the list allows. Anything
 * this cannot read with certainty (a display name, several addresses, a
 * variable) is not allowed.
 */
export function isAllowedRedirect(target: string, allowlist: readonly string[]): boolean {
  const parsed = parsePlainAddress(target);
  if (!parsed) return false;
  const address = `${parsed.local}@${parsed.domain}`;
  return allowlist.some((raw) => {
    const entry = parseAllowlistEntry(raw);
    if ('error' in entry) return false;
    return entry.kind === 'address' ? entry.value === address : entry.value === parsed.domain;
  });
}
