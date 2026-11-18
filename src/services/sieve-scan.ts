/**
 * Risky-action scanner for Sieve scripts (RFC 5228 and extensions).
 *
 * The script is tokenized the way a Sieve server reads it: comments vanish,
 * quoted and `text:` strings become values (escapes and dot-stuffing undone),
 * and identifiers are compared case-insensitively. So a `redirect` inside a
 * comment or a string is not an action, while `REDIRECT/*x*\/"a@b"` is.
 *
 * Rules, in order of how bad a miss would be:
 *   block  redirect / notify / report to a target not on `sieve.allowed_redirects`,
 *          or to a target that cannot be read with certainty (variables, lists);
 *          pipe and execute (server programs); filter unless its program is on
 *          `sieve.allowed_programs`; an include whose name is dynamic; an include of
 *          a server-wide (global) script, which cannot be read here; a script that
 *          does not tokenize or has an unclosed string list.
 *   warn   vacation, reject, ereject, discard, allowlisted forwards and filters,
 *          include (its target is scanned too), fileinto to a missing folder,
 *          an extension this scanner does not know.
 *
 * False alarms are acceptable; misses are not. When in doubt this blocks.
 */

import { isAllowedRedirect } from '../safety/redirect-allowlist.js';

export type FindingSeverity = 'block' | 'warn';

export interface SieveFinding {
  severity: FindingSeverity;
  /** The Sieve action, lowercased (redirect, vacation, …), or "parse". */
  action: string;
  line: number;
  message: string;
  /** Forward target, folder or included script, when there is one. */
  target?: string;
  /** Script the finding is in, when includes were followed. */
  script?: string;
}

export interface SieveInclude {
  name: string;
  global: boolean;
  optional: boolean;
  line: number;
}

export interface SieveScan {
  findings: SieveFinding[];
  includes: SieveInclude[];
  /** Folders named by fileinto (decoded), for an existence check. */
  fileinto: { folder: string; line: number }[];
  blocked: boolean;
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

type TokenKind = 'identifier' | 'tag' | 'string' | 'number' | 'punct';

interface Token {
  kind: TokenKind;
  /** Identifiers and tags lowercased; strings decoded. */
  value: string;
  line: number;
}

export class SieveParseError extends Error {
  constructor(
    message: string,
    readonly line: number,
  ) {
    super(`line ${line}: ${message}`);
    this.name = 'SieveParseError';
  }
}

const MULTILINE_START = /^text:[ \t]*(?:#[^\n]*)?\r?\n/i;

export function tokenizeSieve(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  let line = 1;
  const countLines = (text: string): number => text.split('\n').length - 1;
  // `text:` plus spaces and an optional comment, through the end of its line.
  const headerAt = (at: number): string => {
    const nl = source.indexOf('\n', at);
    return source.slice(at, nl < 0 ? source.length : nl + 1);
  };

  while (i < source.length) {
    const ch = source[i] as string;
    const rest = source.slice(i, i + 2);

    if (ch === '\n') {
      line += 1;
      i += 1;
    } else if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
    } else if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
    } else if (rest === '/*') {
      const end = source.indexOf('*/', i + 2);
      if (end < 0) throw new SieveParseError('unterminated /* comment', line);
      line += countLines(source.slice(i, end));
      i = end + 2;
    } else if (ch === '"') {
      const startLine = line;
      let value = '';
      i += 1;
      let closed = false;
      while (i < source.length) {
        const c = source[i] as string;
        if (c === '\\' && i + 1 < source.length) {
          const next = source[i + 1] as string;
          if (next === '\n') line += 1;
          value += next;
          i += 2;
        } else if (c === '"') {
          closed = true;
          i += 1;
          break;
        } else {
          if (c === '\n') line += 1;
          value += c;
          i += 1;
        }
      }
      if (!closed) throw new SieveParseError('unterminated quoted string', startLine);
      tokens.push({ kind: 'string', value, line: startLine });
    } else if (
      (ch === 't' || ch === 'T') &&
      source.slice(i, i + 5).toLowerCase() === 'text:' &&
      MULTILINE_START.test(headerAt(i))
    ) {
      const startLine = line;
      const header = MULTILINE_START.exec(headerAt(i))?.[0] ?? '';
      i += header.length;
      line += 1;
      const lines: string[] = [];
      let closed = false;
      while (i < source.length) {
        const nl = source.indexOf('\n', i);
        const raw = nl < 0 ? source.slice(i) : source.slice(i, nl);
        i = nl < 0 ? source.length : nl + 1;
        line += nl < 0 ? 0 : 1;
        const text = raw.replace(/\r$/, '');
        if (text === '.') {
          closed = true;
          break;
        }
        lines.push(text.startsWith('.') ? text.slice(1) : text);
      }
      if (!closed) throw new SieveParseError('unterminated text: block', startLine);
      tokens.push({ kind: 'string', value: lines.join('\n'), line: startLine });
    } else if (ch === ':') {
      const match = /^:([A-Za-z_][A-Za-z0-9_]*)/.exec(source.slice(i, i + 256));
      if (!match) throw new SieveParseError('stray ":"', line);
      tokens.push({ kind: 'tag', value: (match[1] as string).toLowerCase(), line });
      i += match[0].length;
    } else if (/[A-Za-z_]/.test(ch)) {
      const match = /^[A-Za-z_][A-Za-z0-9_]*/.exec(source.slice(i, i + 256)) as RegExpExecArray;
      tokens.push({ kind: 'identifier', value: match[0].toLowerCase(), line });
      i += match[0].length;
    } else if (/[0-9]/.test(ch)) {
      const match = /^[0-9]+[KMGkmg]?/.exec(source.slice(i, i + 64)) as RegExpExecArray;
      tokens.push({ kind: 'number', value: match[0], line });
      i += match[0].length;
    } else if (';,[](){}'.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch, line });
      i += 1;
    } else {
      throw new SieveParseError(`unexpected character ${JSON.stringify(ch)}`, line);
    }
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// String values
// ---------------------------------------------------------------------------

/**
 * Undoes the encoded-character extension (RFC 5228 §2.4.2.4): `${hex:..}` and
 * `${unicode:..}`. Applied whether or not the script requires the extension:
 * without it the text stays literal and is no valid address anyway.
 */
export function decodeEncodedCharacters(value: string): string {
  return value.replace(
    /\$\{(hex|unicode):([\s0-9a-fA-F]*)\}/gi,
    (whole, kind: string, body: string) => {
      const parts = body.trim().split(/\s+/).filter(Boolean);
      try {
        if (kind.toLowerCase() === 'hex') {
          return Buffer.from(
            parts.map((p) => (p.length % 2 ? `0${p}` : p)).join(''),
            'hex',
          ).toString('utf8');
        }
        return String.fromCodePoint(...parts.map((p) => parseInt(p, 16)));
      } catch {
        return whole;
      }
    },
  );
}

const hasVariable = (value: string): boolean => value.includes('${');

/** Splits at the first `sep` only; the rest stays whole instead of being cut off. */
function splitFirst(text: string, sep: string): [string, string] {
  const at = text.indexOf(sep);
  return at < 0 ? [text, ''] : [text.slice(0, at), text.slice(at + 1)];
}

/**
 * False when a mailto: URI has a second `?`, or a query pair with a second `=`.
 * A server reads those as part of a value, so what it does with them cannot be
 * told from here; the caller blocks.
 */
export function mailtoIsReadable(uri: string): boolean {
  const body = uri.replace(/^mailto:/i, '');
  const [, query] = splitFirst(body, '?');
  if (query.includes('?')) return false;
  return query
    .split('&')
    .filter(Boolean)
    .every((pair) => splitFirst(pair, '=')[1].includes('=') === false);
}

/** Every address a mailto: URI sends to: the path and the to/cc/bcc header fields. */
export function mailtoRecipients(uri: string): string[] {
  const body = uri.replace(/^mailto:/i, '');
  const [path, query] = splitFirst(body, '?');
  const decode = (s: string): string => {
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  const recipients = path
    .split(',')
    .map((a) => decode(a).trim())
    .filter(Boolean);
  query
    .split('&')
    .filter(Boolean)
    .forEach((pair) => {
      const [key, value] = splitFirst(pair, '=');
      if (/^(to|cc|bcc)$/i.test(decode(key))) {
        recipients.push(
          ...decode(value)
            .split(',')
            .map((a) => a.trim())
            .filter(Boolean),
        );
      }
    });
  return recipients;
}

// ---------------------------------------------------------------------------
// Scanner
// ---------------------------------------------------------------------------

interface Argument {
  tag?: string;
  /** Strings in this argument (a string, or each item of a string list). */
  strings: string[];
  line: number;
}

/** Arguments of the command starting at `start`: tags, strings, lists, up to ; { } or a test. */
function readArguments(
  tokens: Token[],
  start: number,
  tagsWithValue: ReadonlySet<string>,
): Argument[] {
  const args: Argument[] = [];
  let i = start;
  let pendingTag: string | undefined;
  const flushTag = (): void => {
    if (pendingTag !== undefined)
      args.push({ tag: pendingTag, strings: [], line: tokens[i]?.line ?? 0 });
    pendingTag = undefined;
  };
  while (i < tokens.length) {
    const t = tokens[i] as Token;
    if (
      t.kind === 'punct' &&
      (t.value === ';' || t.value === '{' || t.value === '}' || t.value === ')' || t.value === ',')
    ) {
      break;
    }
    if (t.kind === 'tag') {
      flushTag();
      if (tagsWithValue.has(t.value)) pendingTag = t.value;
      else args.push({ tag: t.value, strings: [], line: t.line });
      i += 1;
    } else if (t.kind === 'string' || t.kind === 'number') {
      args.push({
        tag: pendingTag,
        strings: t.kind === 'string' ? [t.value] : [],
        line: t.line,
      });
      pendingTag = undefined;
      i += 1;
    } else if (t.kind === 'punct' && t.value === '[') {
      const strings: string[] = [];
      const { line } = t;
      i += 1;
      // A string list holds only strings and commas. Anything else means the
      // bracket was never closed: refuse, and never read on to the end of the file.
      while (i < tokens.length) {
        const item = tokens[i] as Token;
        if (item.kind === 'punct' && item.value === ']') break;
        if (item.kind === 'string') strings.push(item.value);
        else if (!(item.kind === 'punct' && item.value === ',')) {
          throw new SieveParseError('unclosed string list', line);
        }
        i += 1;
      }
      if (i >= tokens.length) throw new SieveParseError('unclosed string list', line);
      i += 1;
      args.push({ tag: pendingTag, strings, line });
      pendingTag = undefined;
    } else {
      // An identifier or parenthesis: a test begins (execute used as a test).
      break;
    }
  }
  flushTag();
  return args;
}

const NO_TAG_VALUES: ReadonlySet<string> = new Set();
const REDIRECT_TAGS: ReadonlySet<string> = new Set(['notify', 'ret', 'by', 'bymode']);
const NOTIFY_TAGS: ReadonlySet<string> = new Set([
  'from',
  'importance',
  'options',
  'message',
  'method',
  'id',
]);
const FILEINTO_TAGS: ReadonlySet<string> = new Set(['flags', 'specialuse', 'mailboxid']);
// Known keyword values of redirect-dsn and deliverby; anything else is checked as an address.
const REDIRECT_KEYWORDS = new Set([
  'success',
  'failure',
  'delay',
  'never',
  'full',
  'hdrs',
  'notify',
  'return',
]);

export interface ScanOptions {
  /** Programs `filter` may run: `sieve.allowed_programs` in config.toml. Default: none. */
  allowedPrograms?: readonly string[];
  /**
   * Block an include of a server-wide (global) script. True by default: such a
   * script cannot be read over ManageSieve. Off only for a read of a script that
   * is already live and is not being changed.
   */
  blockGlobalIncludes?: boolean;
}

/**
 * Extensions this scanner knows. A `require` of anything else is warned about,
 * because a server-specific extension can add commands that send mail or run
 * programs under a name the scanner has no rule for.
 */
const KNOWN_EXTENSIONS: ReadonlySet<string> = new Set([
  'fileinto',
  'reject',
  'ereject',
  'envelope',
  'encoded-character',
  'vacation',
  'vacation-seconds',
  'subaddress',
  'relational',
  'regex',
  'copy',
  'include',
  'variables',
  'body',
  'environment',
  'date',
  'index',
  'imap4flags',
  'imapflags',
  'mailbox',
  'mboxmetadata',
  'servermetadata',
  'editheader',
  'duplicate',
  'enotify',
  'notify',
  'foreverypart',
  'mime',
  'extracttext',
  'spamtest',
  'spamtestplus',
  'virustest',
  'ihave',
  'error',
  'special-use',
  'mailboxid',
  'fcc',
  'redirect-dsn',
  'redirect-deliverby',
  'vnd.dovecot.debug',
  'vnd.dovecot.duplicate',
  'vnd.dovecot.environment',
  // Handled as commands below (blocked, or checked against the allowlists).
  'vnd.dovecot.pipe',
  'vnd.dovecot.execute',
  'vnd.dovecot.filter',
  'vnd.dovecot.report',
]);

const isKnownExtension = (name: string): boolean =>
  KNOWN_EXTENSIONS.has(name) || name.startsWith('comparator-');

export function scanSieveScript(
  source: string,
  allowlist: readonly string[],
  options: ScanOptions = {},
): SieveScan {
  const allowedPrograms = options.allowedPrograms ?? [];
  const findings: SieveFinding[] = [];
  const includes: SieveInclude[] = [];
  const fileinto: { folder: string; line: number }[] = [];
  const add = (finding: SieveFinding): void => {
    findings.push(finding);
  };

  let tokens: Token[];
  try {
    tokens = tokenizeSieve(source);
  } catch (err) {
    const line = err instanceof SieveParseError ? err.line : 0;
    add({
      severity: 'block',
      action: 'parse',
      line,
      message: `The script could not be read, so it cannot be checked for forwarding (${err instanceof Error ? err.message : String(err)})`,
    });
    return { findings, includes, fileinto, blocked: true };
  }

  /** Checks one forward target; returns nothing, records a finding. */
  const checkForward = (action: string, raw: string, line: number, how: string): void => {
    const target = decodeEncodedCharacters(raw).trim();
    if (hasVariable(target)) {
      add({
        severity: 'block',
        action,
        line,
        target,
        message: `${how} to a target built from variables (${target}); it cannot be checked against sieve.allowed_redirects`,
      });
    } else if (isAllowedRedirect(target, allowlist)) {
      add({
        severity: 'warn',
        action,
        line,
        target,
        message: `${how} to ${target} (allowed by sieve.allowed_redirects in config.toml)`,
      });
    } else {
      add({
        severity: 'block',
        action,
        line,
        target,
        message: `${how} to ${target}, which is not in sieve.allowed_redirects. Only a person editing config.toml can allow it`,
      });
    }
  };

  const scanTokens = (): void => {
    tokens.forEach((token, index) => {
      if (token.kind !== 'identifier') return;
      const { line } = token;
      switch (token.value) {
        case 'redirect': {
          const args = readArguments(tokens, index + 1, REDIRECT_TAGS);
          if (args.some((a) => a.tag === 'list')) {
            add({
              severity: 'block',
              action: 'redirect',
              line,
              message:
                'Forwards to an external list (redirect :list); its members cannot be checked',
            });
          }
          const copy = args.some((a) => a.tag === 'copy') ? ' a copy' : '';
          const targets = args.flatMap((a) =>
            a.tag && REDIRECT_TAGS.has(a.tag)
              ? a.strings.filter((s) => !REDIRECT_KEYWORDS.has(s.trim().toLowerCase()))
              : a.strings,
          );
          if (targets.length === 0 && !args.some((a) => a.tag === 'list')) {
            add({
              severity: 'block',
              action: 'redirect',
              line,
              message: 'redirect without a readable target address',
            });
          }
          targets.forEach((t) => {
            checkForward('redirect', t, line, `Forwards${copy}`);
          });
          break;
        }
        case 'notify': {
          const args = readArguments(tokens, index + 1, NOTIFY_TAGS);
          const methods = args
            .filter((a) => a.tag === undefined || a.tag === 'method')
            .flatMap((a) => a.strings);
          // The old draft put the address in :options.
          const legacy = args
            .filter((a) => a.tag === 'options')
            .flatMap((a) => a.strings)
            .filter((s) => s.includes('@'));
          if (methods.length === 0 && legacy.length === 0) {
            add({
              severity: 'block',
              action: 'notify',
              line,
              message: 'notify without a readable method; where it sends cannot be checked',
            });
          }
          methods.forEach((raw) => {
            const method = decodeEncodedCharacters(raw).trim();
            if (hasVariable(method)) {
              add({
                severity: 'block',
                action: 'notify',
                line,
                target: method,
                message: `Sends a notification to a target built from variables (${method})`,
              });
            } else if (/^mailto:/i.test(method)) {
              const recipients = mailtoRecipients(method);
              if (!mailtoIsReadable(method)) {
                add({
                  severity: 'block',
                  action: 'notify',
                  line,
                  target: method,
                  message: `notify ${method} has a second "?" or "=" in its fields; where it sends cannot be told`,
                });
              }
              if (recipients.length === 0) {
                add({
                  severity: 'block',
                  action: 'notify',
                  line,
                  target: method,
                  message: `notify ${method} has no readable recipient`,
                });
              }
              recipients.forEach((r) => {
                checkForward('notify', r, line, 'Sends a notification with message details');
              });
            } else if (/^[a-z][a-z0-9+.-]*:/i.test(method) || legacy.length === 0) {
              add({
                severity: 'block',
                action: 'notify',
                line,
                target: method,
                message: `Sends a notification through ${method}; only mailto: to an allowlisted address can be checked`,
              });
            }
          });
          legacy.forEach((r) => {
            checkForward('notify', r, line, 'Sends a notification with message details');
          });
          break;
        }
        case 'report': {
          // vnd.dovecot.report sends a report message to an address.
          const args = readArguments(tokens, index + 1, NO_TAG_VALUES);
          const strings = args.flatMap((a) => a.strings);
          // The address is the last string. It is always checked, even without an @
          // (a bare name is a local user), along with any other string that has one.
          const last = strings.at(-1);
          const addresses = strings.filter(
            (s, i) =>
              i === strings.length - 1 ||
              decodeEncodedCharacters(s).includes('@') ||
              hasVariable(s),
          );
          if (addresses.length === 0 || last === undefined) {
            add({
              severity: 'block',
              action: 'report',
              line,
              message: 'report sends a message to an address that cannot be read',
            });
          }
          addresses.forEach((a) => {
            checkForward('report', a.replace(/^mailto:/i, ''), line, 'Sends a report');
          });
          break;
        }
        case 'pipe':
        case 'execute':
          add({
            severity: 'block',
            action: token.value,
            line,
            message: `${token.value} hands the message to a program on the server; what it does cannot be checked`,
          });
          break;
        case 'filter': {
          const args = readArguments(tokens, index + 1, NO_TAG_VALUES);
          const program = decodeEncodedCharacters(
            args.find((a) => a.tag === undefined && a.strings.length > 0)?.strings[0] ?? '',
          ).trim();
          if (program === '' || hasVariable(program)) {
            add({
              severity: 'block',
              action: 'filter',
              line,
              target: program || undefined,
              message:
                'filter passes the message through a program on the server, and the program name cannot be read; what it does cannot be checked',
            });
          } else if (allowedPrograms.some((p) => p.trim() === program)) {
            add({
              severity: 'warn',
              action: 'filter',
              line,
              target: program,
              message: `filter passes the message through the server program "${program}" (allowed by sieve.allowed_programs in config.toml)`,
            });
          } else {
            add({
              severity: 'block',
              action: 'filter',
              line,
              target: program,
              message: `filter passes the message through the server program "${program}", which is not in sieve.allowed_programs. Only a person editing config.toml can allow it`,
            });
          }
          break;
        }
        case 'require': {
          const args = readArguments(tokens, index + 1, NO_TAG_VALUES);
          args
            .flatMap((a) => a.strings)
            .forEach((raw) => {
              const name = decodeEncodedCharacters(raw).trim().toLowerCase();
              if (!isKnownExtension(name)) {
                add({
                  severity: 'warn',
                  action: 'require',
                  line,
                  target: name,
                  message: `Uses the extension "${name}", which this scanner does not know; commands it adds are not checked`,
                });
              }
            });
          break;
        }
        case 'vacation':
          add({
            severity: 'warn',
            action: 'vacation',
            line,
            message: 'Sends automatic replies to senders (vacation)',
          });
          break;
        case 'reject':
        case 'ereject':
          add({
            severity: 'warn',
            action: token.value,
            line,
            message: `Bounces mail back to the sender (${token.value})`,
          });
          break;
        case 'discard':
          add({
            severity: 'warn',
            action: 'discard',
            line,
            message: 'Silently deletes matching mail (discard)',
          });
          break;
        case 'fileinto': {
          const args = readArguments(tokens, index + 1, FILEINTO_TAGS);
          const positional = args.filter((a) => a.tag === undefined).flatMap((a) => a.strings);
          const folder = positional.at(-1);
          if (folder !== undefined)
            fileinto.push({ folder: decodeEncodedCharacters(folder), line });
          break;
        }
        case 'include': {
          const args = readArguments(tokens, index + 1, NO_TAG_VALUES);
          const global = args.some((a) => a.tag === 'global');
          const optional = args.some((a) => a.tag === 'optional');
          const names = args.filter((a) => a.tag === undefined).flatMap((a) => a.strings);
          if (names.length === 0) {
            add({
              severity: 'block',
              action: 'include',
              line,
              message: 'include without a readable script name',
            });
          }
          names.forEach((raw) => {
            const name = decodeEncodedCharacters(raw);
            if (hasVariable(name)) {
              add({
                severity: 'block',
                action: 'include',
                line,
                target: name,
                message: `Includes a script whose name is built from variables (${name}); it cannot be checked`,
              });
            } else {
              includes.push({ name, global, optional, line });
            }
          });
          break;
        }
        default:
          break;
      }
    });
  };

  try {
    scanTokens();
  } catch (err) {
    if (!(err instanceof SieveParseError)) throw err;
    add({
      severity: 'block',
      action: 'parse',
      line: err.line,
      message: `The script could not be read, so it cannot be checked for forwarding (${err.message})`,
    });
  }

  return { findings, includes, fileinto, blocked: findings.some((f) => f.severity === 'block') };
}

/** How deep includes are followed before the scan gives up (and blocks). */
export const MAX_INCLUDE_DEPTH = 8;

/**
 * Scans a script and every personal script it includes, fetched with `fetch`
 * (null when it does not exist). Global scripts belong to the server admin and
 * cannot be read over ManageSieve: they are reported, not followed.
 */
export async function scanWithIncludes(
  name: string,
  source: string,
  allowlist: readonly string[],
  fetch: (scriptName: string) => Promise<string | null>,
  options: ScanOptions = {},
): Promise<SieveScan> {
  const blockGlobal = options.blockGlobalIncludes ?? true;
  const all: SieveScan = { findings: [], includes: [], fileinto: [], blocked: false };
  const seen = new Set<string>();

  const visit = async (scriptName: string, text: string, depth: number): Promise<void> => {
    seen.add(scriptName);
    const scan = scanSieveScript(text, allowlist, options);
    all.findings.push(...scan.findings.map((f) => ({ ...f, script: scriptName })));
    all.includes.push(...scan.includes);
    all.fileinto.push(...scan.fileinto);
    for (const inc of scan.includes) {
      if (inc.global) {
        all.findings.push({
          severity: blockGlobal ? 'block' : 'warn',
          action: 'include',
          line: inc.line,
          target: inc.name,
          script: scriptName,
          message: blockGlobal
            ? `Includes the server's global script "${inc.name}". ManageSieve cannot read a global script, so what it does cannot be checked. Remove the include, or ask the server administrator`
            : `Includes the server's global script "${inc.name}", which cannot be read here`,
        });
      } else if (!seen.has(inc.name)) {
        if (depth >= MAX_INCLUDE_DEPTH) {
          all.findings.push({
            severity: 'block',
            action: 'include',
            line: inc.line,
            target: inc.name,
            script: scriptName,
            message: `Includes are nested more than ${MAX_INCLUDE_DEPTH} deep; "${inc.name}" was not checked`,
          });
        } else {
          // eslint-disable-next-line no-await-in-loop -- includes are followed one at a time
          const included = await fetch(inc.name);
          if (included === null) {
            all.findings.push({
              severity: 'warn',
              action: 'include',
              line: inc.line,
              target: inc.name,
              script: scriptName,
              message: `Includes "${inc.name}", which does not exist${inc.optional ? ' (optional)' : ''}; it will be checked when it is saved`,
            });
          } else {
            all.findings.push({
              severity: 'warn',
              action: 'include',
              line: inc.line,
              target: inc.name,
              script: scriptName,
              message: `Includes "${inc.name}" (checked below)`,
            });
            // eslint-disable-next-line no-await-in-loop -- includes are followed one at a time
            await visit(inc.name, included, depth + 1);
          }
        }
      }
    }
  };

  await visit(name, source, 0);
  all.blocked = all.findings.some((f) => f.severity === 'block');
  return all;
}

/** One line per finding, for tool text. */
export function describeFindings(findings: readonly SieveFinding[]): string[] {
  return findings.map((f) => {
    const where = f.script ? `${f.script}, line ${f.line}` : `line ${f.line}`;
    return `${f.severity === 'block' ? 'BLOCKED' : 'RISKY'} (${where}): ${f.message}`;
  });
}
