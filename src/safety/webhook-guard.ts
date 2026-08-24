/**
 * Webhook destination guard.
 *
 * A webhook URL decides where notification payloads go. The synchronous
 * string checks in validation.ts catch obvious literals, but they inspect
 * the hostname as text: they never resolve it, so a name that resolves into
 * private address space passes, and they never see where a redirect lands.
 *
 * This module is the authoritative gate. It resolves every hostname and
 * range-checks every resolved address before a request may go out, and
 * treats any address inside private, loopback, link-local, or otherwise
 * non-routable space as refused. Resolution failure refuses too: an
 * unresolvable destination is not a destination.
 */

import { promises as dnsPromises } from 'node:dns';
import net from 'node:net';

export type Lookup = (hostname: string) => Promise<{ address: string; family: number }[]>;

const DEFAULT_LOOKUP: Lookup = async (hostname) =>
  dnsPromises.lookup(hostname, { all: true, verbatim: true });

/** True when the address is inside a range that must never receive webhooks. */
export function isForbiddenAddress(address: string): boolean {
  const family = net.isIP(address);

  if (family === 4) {
    return isForbiddenIPv4(address);
  }

  if (family === 6) {
    return isForbiddenIPv6(address);
  }

  // Not an IP literal the parser recognises — refuse rather than guess.
  return true;
}

function isForbiddenIPv4(address: string): boolean {
  const octets = address.split('.').map(Number);
  const [a, b] = octets;

  // Loopback and this-host ranges.
  if (a === 0 || a === 10 || a === 127) return true;
  // Link-local, which includes cloud metadata services.
  if (a === 169 && b === 254) return true;
  // Carrier-grade NAT.
  if (a === 100 && b >= 64 && b <= 127) return true;
  // RFC 1918 private space.
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  // IETF protocol assignments and benchmarking ranges.
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  // Multicast and reserved.
  if (a >= 224) return true;

  return false;
}

function isForbiddenIPv6(address: string): boolean {
  const lower = address.toLowerCase();

  // IPv4-mapped addresses arrive in either textual form depending on how the
  // URL was written ('::ffff:127.0.0.1' stays dotted, '::ffff:7f00:1' stays
  // hex). Unwrap both and re-check the embedded v4.
  const mappedDotted = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower);
  if (mappedDotted) return isForbiddenIPv4(mappedDotted[1]);

  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isForbiddenIPv4(`${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`);
  }

  const expanded = expandIPv6(lower);
  if (expanded === null) return true;

  // :: (unspecified) and ::1 (loopback).
  if (expanded === '0'.repeat(32) || expanded === `${'0'.repeat(31)}1`) return true;
  // fc00::/7 unique-local.
  if (expanded.startsWith('fc') || expanded.startsWith('fd')) return true;
  // fe80::/10 link-local.
  if (/^fe[89ab]/.test(expanded)) return true;

  return false;
}

/** Expands an IPv6 address to 32 lowercase hex chars, or null when invalid. */
function expandIPv6(address: string): string | null {
  if (!net.isIPv6(address)) return null;

  const [headRaw, ...tailParts] = address.split('::');
  const tail = tailParts.length > 0 ? tailParts.join('::').split('::')[0] : '';
  const headGroups = headRaw ? headRaw.split(':') : [];
  const tailGroups = tail ? tail.split(':') : [];

  const missing = 8 - headGroups.length - tailGroups.length;
  if (tailParts.length > 0 && missing < 0) return null;

  const zeros = Array.from({ length: Math.max(missing, 0) }, () => '0000');
  const groups = [...headGroups, ...zeros, ...tailGroups];
  if (groups.length !== 8) return null;

  for (const group of groups) {
    if (!/^[0-9a-f]{1,4}$/.test(group)) return null;
  }

  return groups.map((g) => g.padStart(4, '0')).join('');
}

/**
 * Refuses a webhook URL unless every address its hostname resolves to is
 * public. Throws with an operator-actionable message when refused.
 */
export async function assertWebhookTargetAllowed(
  url: string,
  lookup: Lookup = DEFAULT_LOOKUP,
): Promise<void> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Invalid webhook URL: ${url}`);
  }

  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`Webhook URL must use http or https protocol, got ${parsed.protocol}`);
  }

  // The FQDN form of a name carries a trailing dot ('localhost.'), which
  // resolves identically but compares differently as text. Normalise first.
  const hostname = parsed.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');

  // Literal addresses need no resolution.
  if (net.isIP(hostname) !== 0) {
    if (isForbiddenAddress(hostname)) {
      throw new Error(`Webhook URL must point to a public address: ${hostname} is not routable`);
    }
    return;
  }

  let resolved: { address: string; family: number }[];
  try {
    resolved = await lookup(hostname);
  } catch {
    throw new Error(`Webhook URL hostname does not resolve: ${hostname}`);
  }

  if (resolved.length === 0) {
    throw new Error(`Webhook URL hostname does not resolve: ${hostname}`);
  }

  for (const { address } of resolved) {
    if (isForbiddenAddress(address)) {
      throw new Error(
        `Webhook URL must point to a public address: ${hostname} resolves to ${address}, ` +
          `which is not routable`,
      );
    }
  }
}
