// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * A server's reply to a failed login can quote what the client sent: the password, the OAuth2
 * access token, or the SASL blob that carried them. Error text from a connection goes through
 * here before it is printed, returned by a tool or logged.
 */

import type { AccountConfig } from '../types/index.js';

export const REDACTED = '[redacted]';

export const MAX_ERROR_TEXT_LENGTH = 300;

const TRUNCATION_MARKER = '…';

// Matches the OAuth token-endpoint redaction.
const SECRET_SHAPE_MIN_CHARS = 8;

export interface SentCredentials {
  user: string;
  secrets: readonly (string | undefined)[];
}

type Span = [start: number, end: number];

interface SecretShapes {
  /** Cut out wherever they occur. */
  long: RegExp[];
  /** Shorter than SECRET_SHAPE_MIN_CHARS: they match the server's own words, so they are never cut. */
  short: RegExp[];
}

// RFC 6750 b64token.
const BEARER_TOKEN = /\bBearer\s+([\w.~+/-]+=*)/giu;

// Every XOAUTH2 blob is longer than this.
const BASE64_RUN = /[A-Za-z0-9+/]{20,}={0,2}/gu;

const XOAUTH2_BEARER = 'auth=Bearer ';

// RFC 5530 §3. imapflow's `getStatusCode` uppercases the response code and keeps only its first
// atom, so the sent-credential shapes cannot see a secret a server put there, whole or cut. A
// fixed vocabulary keeps any other server-chosen text out of the message too.
const REGISTERED_RESPONSE_CODES: ReadonlySet<string> = new Set([
  'UNAVAILABLE',
  'AUTHENTICATIONFAILED',
  'AUTHORIZATIONFAILED',
  'EXPIRED',
  'PRIVACYREQUIRED',
  'CONTACTADMIN',
  'NOPERM',
  'INUSE',
  'EXPUNGEISSUED',
  'CORRUPTION',
  'SERVERBUG',
  'CLIENTBUG',
  'CANNOT',
  'LIMIT',
  'OVERQUOTA',
  'ALREADYEXISTS',
  'NONEXISTENT',
]);

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function exactPattern(text: string): string {
  return text.replace(/[\\^$.*+?()[\]{}|]/gu, '\\$&');
}

function hexDigitsInEitherCase(percentEscape: string): string {
  return percentEscape.replace(/[A-F]/gu, (digit) => `[${digit}${digit.toLowerCase()}]`);
}

/** Encoders write an escape's hex digits in uppercase and an echo can write each in either case. */
function percentEncodedPattern(encoded: string): string {
  return exactPattern(encoded).replace(/%[0-9A-F]{2}/gu, hexDigitsInEitherCase);
}

/**
 * The base64 characters that depend only on the secret, for each of the three byte offsets it
 * can start at inside a longer encoded text ("user:password" for HTTP Basic, a SASL blob with any
 * prefix). The characters at each end also carry bits of the bytes around it, so they are left out.
 */
function base64Alignments(secret: string): string[] {
  const bytes = Buffer.from(secret, 'utf8');
  return [0, 1, 2].map((offset) => {
    const encoded = Buffer.concat([Buffer.alloc(offset), bytes]).toString('base64');
    const first = Math.ceil((8 * offset) / 6);
    const end = Math.floor((8 * (offset + bytes.length)) / 6);
    return encoded.slice(first, end);
  });
}

interface Shape {
  /** Length of the text it matches, not of its pattern, whose escapes are longer. */
  length: number;
  /**
   * The plain and JSON forms of a long secret, which a server may echo in another case. Never a
   * short shape (it would withhold whole messages that hold common words) and never an encoded
   * form, whose case is part of what it says.
   */
  anyCase: boolean;
}

function secretShapes(sent: SentCredentials): SecretShapes {
  const shapes = new Map<string, Shape>();
  const add = (pattern: string, length: number, anyCase = false): void => {
    const known = shapes.get(pattern);
    shapes.set(pattern, { length, anyCase: anyCase || (known?.anyCase ?? false) });
  };
  sent.secrets
    .filter((secret): secret is string => typeof secret === 'string' && secret.length > 0)
    .forEach((secret) => {
      add(exactPattern(secret), secret.length, true);
      // A server or provider that quotes the secret inside JSON escapes " and \.
      const jsonEscaped = JSON.stringify(secret).slice(1, -1);
      if (jsonEscaped !== secret) add(exactPattern(jsonEscaped), jsonEscaped.length, true);
      [
        // AUTH LOGIN
        base64(secret),
        // AUTH PLAIN, without and with an authorization identity
        base64(`\0${sent.user}\0${secret}`),
        base64(`${sent.user}\0${sent.user}\0${secret}`),
        // XOAUTH2
        base64(`user=${sent.user}\u0001auth=Bearer ${secret}\u0001\u0001`),
      ].forEach((shape) => {
        add(exactPattern(shape), shape.length);
      });
      // Too short a middle would match unrelated base64; the whole-text forms above still apply.
      base64Alignments(secret)
        .filter((middle) => middle.length >= SECRET_SHAPE_MIN_CHARS)
        .forEach((middle) => {
          add(exactPattern(middle), middle.length);
        });
      // encodeURIComponent throws on a lone surrogate; U+FFFD is what UTF-8 put on the wire for it.
      const encoded = encodeURIComponent(secret.replace(/\p{Cs}/gu, '\uFFFD'));
      add(percentEncodedPattern(encoded), encoded.length);
    });
  const result: SecretShapes = { long: [], short: [] };
  shapes.forEach(({ length, anyCase }, pattern) => {
    result[length < SECRET_SHAPE_MIN_CHARS ? 'short' : 'long'].push(
      new RegExp(pattern, anyCase && length >= SECRET_SHAPE_MIN_CHARS ? 'iu' : 'u'),
    );
  });
  return result;
}

/** A lookahead match is empty, so the scan steps on one character and finds overlapping echoes. */
function echoesOf(text: string, shape: RegExp): Span[] {
  const scan = new RegExp(`(?=(${shape.source}))`, shape.ignoreCase ? 'giu' : 'gu');
  return Array.from(
    text.matchAll(scan),
    (match): Span => [match.index, match.index + (match[1] ?? '').length],
  );
}

// A token endpoint's answer, quoted in an error: its tokens were never sent, so no shape knows them.
const JSON_TOKEN_VALUE = /"(?:access_token|refresh_token|id_token)"\s*:\s*"((?:[^"\\]|\\.)*)"/giu;

function jsonTokenSpans(text: string): Span[] {
  return [...text.matchAll(JSON_TOKEN_VALUE)]
    .filter((match) => (match[1] ?? '').length > 0)
    .map((match): Span => {
      const end = match.index + match[0].length - 1;
      return [end - (match[1] ?? '').length, end];
    });
}

function bearerSpans(text: string): Span[] {
  return [...text.matchAll(BEARER_TOKEN)].map((match): Span => {
    const end = match.index + match[0].length;
    return [end - (match[1] ?? '').length, end];
  });
}

/** Catches an XOAUTH2 blob whose token the caller never saw, such as one nodemailer refreshed. */
function xoauth2BlobSpans(text: string): Span[] {
  return [...text.matchAll(BASE64_RUN)]
    .filter((match) => Buffer.from(match[0], 'base64').toString('latin1').includes(XOAUTH2_BEARER))
    .map((match): Span => [match.index, match.index + match[0].length]);
}

function mergeSpans(spans: Span[]): Span[] {
  return [...spans]
    .sort((a, b) => a[0] - b[0])
    .reduce<Span[]>((merged, [start, end]) => {
      const last = merged.at(-1);
      if (last && start <= last[1]) {
        last[1] = Math.max(last[1], end);
      } else {
        merged.push([start, end]);
      }
      return merged;
    }, []);
}

function capped(text: string): string {
  if (text.length <= MAX_ERROR_TEXT_LENGTH) return text;
  return `${text.slice(0, MAX_ERROR_TEXT_LENGTH - TRUNCATION_MARKER.length)}${TRUNCATION_MARKER}`;
}

function insideAMarker([start, end]: Span, markers: readonly number[]): boolean {
  return markers.some((at) => at <= start && end <= at + REDACTED.length);
}

/**
 * Text that holds a short shape anywhere is withheld whole, and so is text whose pieces around a
 * cut spell a secret with the marker between (a secret `AA[redacted]ZZ` around a cut token).
 * Redacts before capping: a cut through a secret would leave a prefix no shape matches.
 */
export function redactSentCredentials(text: string, sent: SentCredentials): string {
  const shapes = secretShapes(sent);
  if (shapes.short.some((shape) => shape.test(text))) return REDACTED;
  const spans = mergeSpans([
    ...shapes.long.flatMap((shape) => echoesOf(text, shape)),
    ...bearerSpans(text),
    ...jsonTokenSpans(text),
    ...xoauth2BlobSpans(text),
  ]);
  // Spans index the original text, so one marker cannot form or split another match.
  let redacted = '';
  let cursor = 0;
  const markers: number[] = [];
  spans.forEach(([start, end]) => {
    redacted += text.slice(cursor, start);
    markers.push(redacted.length);
    redacted += REDACTED;
    cursor = end;
  });
  redacted += text.slice(cursor);
  const spelled = [...shapes.long, ...shapes.short].flatMap((shape) => echoesOf(redacted, shape));
  if (spelled.some((echo) => !insideAMarker(echo, markers))) return REDACTED;
  return capped(redacted);
}

/**
 * nodemailer's EAUTH carries the server line in `message` and `response`, imapflow's in
 * `response` and `responseText`; callers print, return, audit or queue `message`. `response`,
 * `responseText` and `cause` stay off on purpose.
 *
 * imapflow words every refused LOGIN or AUTHENTICATE as "Command failed", so that message is
 * rebuilt from the refusal flag, the tagged NO or BAD and, only when it is a registered one, the
 * response code, leaving out the server's free text. imapflow's own AuthenticationFailure
 * ("Already logged out", Exchange's "Authentication failed") sets the flag without a tagged
 * status and keeps its message.
 */
export function redactedError(err: unknown, sent: SentCredentials): Error {
  if (!(err instanceof Error)) return new Error(redactSentCredentials(String(err), sent));
  const { code, responseCode, command, authenticationFailed, responseStatus, serverResponseCode } =
    err as Error & {
      code?: string;
      responseCode?: number;
      command?: string;
      authenticationFailed?: boolean;
      responseStatus?: string;
      serverResponseCode?: string;
    };
  let { message } = err;
  if (authenticationFailed === true && (responseStatus === 'NO' || responseStatus === 'BAD')) {
    message = 'Login refused by the server';
    if (serverResponseCode && REGISTERED_RESPONSE_CODES.has(serverResponseCode)) {
      message += ` (${serverResponseCode})`;
    }
    // This fork keeps the server's own reason ("application-specific password required",
    // "web login required"): it is often the only thing that tells a user how to fix the
    // login. The whole message passes through redactSentCredentials below, so a secret the
    // server quotes back is still scrubbed.
    const { responseText } = err as Error & { responseText?: unknown };
    const reason =
      typeof responseText === 'string' ? responseText.replace(/^\[[^\]]*\]\s*/, '').trim() : '';
    if (reason) message += `: ${reason}`;
  }
  return Object.assign(new Error(redactSentCredentials(message, sent)), {
    code,
    responseCode,
    command,
  });
}

/**
 * What a login for this account put on the wire: the user plus every secret that could be quoted
 * back in a server's error reply (password, OAuth2 access and refresh token, client secret).
 * Not part of the upstream file: Mailoo tracks issued tokens in its own auth module, while this
 * fork reads the access token cached on the account's oauth2 config.
 */
export function sentCredentials(account: AccountConfig): SentCredentials {
  return {
    user: account.username,
    secrets: [
      account.password,
      account.oauth2?.accessToken,
      account.oauth2?.refreshToken,
      account.oauth2?.clientSecret,
    ],
  };
}

// ---------------------------------------------------------------------------
// Secrets of every configured account, for code that has no account at hand
// ---------------------------------------------------------------------------

const knownSecrets = new Set<string>();

/**
 * Remembers an account's secrets so `redactKnownSecrets` can cut them out of server text where
 * the account is not known (IMAP command errors). Secrets shorter than the shape minimum are
 * left out: they match the server's own words and would blank unrelated errors; the per-account
 * `redactedError` path still handles those.
 */
export function registerKnownSecrets(account: AccountConfig): void {
  sentCredentials(account).secrets.forEach((secret) => {
    if (typeof secret === 'string' && secret.length >= SECRET_SHAPE_MIN_CHARS) {
      knownSecrets.add(secret);
    }
  });
}

/** Refreshed OAuth2 tokens kept for redaction; old ones still show up in late error text. */
const MAX_ISSUED_TOKENS = 64;
const issuedTokens = new Set<string>();

/**
 * Remembers one secret issued after start-up, such as a refreshed OAuth2 access token or a rotated
 * refresh token, so server text is scrubbed of it too. The newest {@link MAX_ISSUED_TOKENS} are
 * kept, so a server running for months does not grow this without bound.
 */
export function registerKnownSecret(secret: string): void {
  if (secret.length < SECRET_SHAPE_MIN_CHARS || knownSecrets.has(secret)) return;
  issuedTokens.delete(secret);
  issuedTokens.add(secret);
  if (issuedTokens.size > MAX_ISSUED_TOKENS) {
    const oldest = issuedTokens.values().next().value;
    if (oldest !== undefined) issuedTokens.delete(oldest);
  }
}

/** Cuts every remembered secret (and the forms it takes on the wire) out of server-supplied text. */
export function redactKnownSecrets(text: string): string {
  if (knownSecrets.size === 0 && issuedTokens.size === 0) return text;
  return redactSentCredentials(text, { user: '', secrets: [...knownSecrets, ...issuedTokens] });
}
