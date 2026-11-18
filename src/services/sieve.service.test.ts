import type { AccountConfig } from '../types/index.js';
import SieveService, {
  encodeOAuthBearer,
  encodePlainAuth,
  encodeXOAuth2,
  MAX_SIEVE_SCRIPT_BYTES,
  parseCapabilities,
  parseListScripts,
  resolveSieveEndpoint,
  tokenizeResponseText,
} from './sieve.service.js';
import type { FakeSieveServer } from './sieve-fake-server.test-helper.js';
import {
  DEFAULT_GREETING,
  loopbackSieveAccount,
  startFakeSieveServer,
} from './sieve-fake-server.test-helper.js';

const service = new SieveService();
let server: FakeSieveServer | undefined;

afterEach(async () => {
  await server?.close();
  server = undefined;
});

describe('response parsing', () => {
  it('parses LISTSCRIPTS lines including ACTIVE and quoted escapes', () => {
    const lines = ['"personal"', '"vacation" ACTIVE', '"folder\\\\rules\\"draft" active'].map(
      tokenizeResponseText,
    );
    expect(parseListScripts(lines)).toEqual([
      { name: 'personal', active: false },
      { name: 'vacation', active: true },
      { name: 'folder\\rules"draft', active: true },
    ]);
  });

  it('parses capabilities', () => {
    const caps = parseCapabilities(
      [
        '"IMPLEMENTATION" "Dovecot Pigeonhole"',
        '"SASL" "plain OAUTHBEARER"',
        '"SIEVE" "fileinto reject vacation"',
        '"NOTIFY" "mailto"',
        '"STARTTLS"',
        '"VERSION" "1.0"',
        '"MAXREDIRECTS" "4"',
      ].map(tokenizeResponseText),
    );
    expect(caps).toEqual({
      implementation: 'Dovecot Pigeonhole',
      sieveExtensions: ['fileinto', 'reject', 'vacation'],
      notifyMethods: ['mailto'],
      sasl: ['PLAIN', 'OAUTHBEARER'],
      starttls: true,
      version: '1.0',
      maxRedirects: 4,
      owner: undefined,
    });
  });

  it('keeps response codes apart from the message', () => {
    expect(tokenizeResponseText('NO (NONEXISTENT) "There is no \\"x\\""')).toEqual([
      { kind: 'atom', value: 'NO' },
      { kind: 'code', value: 'NONEXISTENT' },
      { kind: 'string', value: 'There is no "x"' },
    ]);
  });

  it('encodes the SASL initial responses', () => {
    const decode = (s: string): string => Buffer.from(s, 'base64').toString('utf8');
    expect(decode(encodePlainAuth('u@x', 'pw'))).toBe('\0u@x\0pw');
    expect(decode(encodeOAuthBearer('u@x', 'h', 4190, 'tok'))).toBe(
      'n,a=u@x,\x01host=h\x01port=4190\x01auth=Bearer tok\x01\x01',
    );
    expect(decode(encodeXOAuth2('u@x', 'tok'))).toBe('user=u@x\x01auth=Bearer tok\x01\x01');
  });
});

describe('resolveSieveEndpoint', () => {
  const base = loopbackSieveAccount(1);

  it('auto-detects the IMAP host on 4190 with STARTTLS', () => {
    expect(
      resolveSieveEndpoint({
        ...base,
        sieve: undefined,
        imap: { ...base.imap, host: 'imap.mailbox.org' },
      }),
    ).toEqual({
      kind: 'endpoint',
      endpoint: { host: 'imap.mailbox.org', port: 4190, security: 'starttls', configured: false },
    });
  });

  it.each(['imap.gmail.com', 'outlook.office365.com', 'imap.mail.me.com', 'imap.fastmail.com'])(
    'answers "not supported" for %s without a sieve block',
    (host) => {
      const result = resolveSieveEndpoint({
        ...base,
        sieve: undefined,
        imap: { ...base.imap, host },
      });
      expect(result.kind).toBe('unsupported');
      expect(result.kind !== 'endpoint' && result.reason).toMatch(/not supported.*local rules/i);
    },
  );

  it('honours an explicit block even for a known provider', () => {
    const result = resolveSieveEndpoint({
      ...base,
      imap: { ...base.imap, host: 'imap.gmail.com' },
      sieve: { enabled: true, host: 'sieve.example.com', tls: true, starttls: false },
    });
    expect(result).toMatchObject({
      kind: 'endpoint',
      endpoint: { host: 'sieve.example.com', port: 4190, security: 'tls' },
    });
  });

  it('reports a disabled block', () => {
    expect(
      resolveSieveEndpoint({
        ...base,
        sieve: { enabled: false, tls: false, starttls: true },
      }).kind,
    ).toBe('disabled');
  });
});

describe('ManageSieve commands over a real socket', () => {
  it('lists, gets and reports status', async () => {
    server = await startFakeSieveServer((cmd) => {
      if (cmd.line === 'LISTSCRIPTS') return '"main" ACTIVE\r\n{5}\r\nother\r\nOK\r\n';
      if (cmd.line === 'GETSCRIPT "main"') return '{6}\r\nkeep;\n\r\nOK\r\n';
      return 'NO "unexpected"\r\n';
    });
    const account = loopbackSieveAccount(server.port);
    const status = await service.status(account);
    expect(status).toMatchObject({
      available: true,
      active: 'main',
      scripts: [
        { name: 'main', active: true },
        { name: 'other', active: false },
      ],
      capabilities: { implementation: 'fake', version: '1.0' },
    });
    await expect(service.withSession(account, (s) => s.getScript('main'))).resolves.toBe('keep;\n');
    expect(server.received[0]?.line).toBe(
      `AUTHENTICATE "PLAIN" "${encodePlainAuth('user@example.com', 's3cret-password')}"`,
    );
  });

  it('uploads with a non-synchronizing literal of the exact byte length', async () => {
    server = await startFakeSieveServer(() => 'OK (WARNINGS) "line 1: odd but fine"\r\n');
    const content = 'fileinto "Zażółć";\r\n';
    const result = await service.withSession(loopbackSieveAccount(server.port), (s) =>
      s.putScript('ż', content),
    );
    expect(result).toEqual({ warnings: 'line 1: odd but fine' });
    expect(server.received[1]).toEqual({
      line: `PUTSCRIPT "ż" {${Buffer.byteLength(content)}+}`,
      literal: content,
    });
  });

  it('reads a multi-line NO literal fully and keeps the connection usable', async () => {
    const detail = 'line 2: error: unknown command "redirct".\r\nline 9: error: parse failed.';
    server = await startFakeSieveServer((cmd) => {
      if (cmd.line.startsWith('PUTSCRIPT')) {
        return `NO {${Buffer.byteLength(detail)}}\r\n${detail}\r\n`;
      }
      return '"x"\r\nOK\r\n';
    });
    const outcome = await service.withSession(loopbackSieveAccount(server.port), async (s) => {
      const error = await s.putScript('a', 'redirct;').catch((err: Error) => err.message);
      return { error, after: await s.listScripts() };
    });
    expect(outcome.error).toContain('line 9: error: parse failed.');
    expect(outcome.after).toEqual([{ name: 'x', active: false }]);
  });

  it('uses CHECKSCRIPT when VERSION is advertised and returns the whole message', async () => {
    const detail = 'line 1: error: unknown command "foo".\r\nerror: validation failed.';
    server = await startFakeSieveServer((cmd) =>
      cmd.line.startsWith('CHECKSCRIPT')
        ? `NO {${Buffer.byteLength(detail)}}\r\n${detail}\r\n`
        : undefined,
    );
    const result = await service.withSession(loopbackSieveAccount(server.port), (s) =>
      s.checkScript('foo;'),
    );
    expect(result).toEqual({ supported: true, ok: false, message: detail, warnings: undefined });
    expect(server.received[1]).toEqual({ line: 'CHECKSCRIPT {4+}', literal: 'foo;' });
  });

  it('does not send CHECKSCRIPT to a server without VERSION', async () => {
    server = await startFakeSieveServer(() => undefined, '"SASL" "PLAIN"\r\nOK "old server"\r\n');
    const result = await service.withSession(loopbackSieveAccount(server.port), (s) =>
      s.checkScript('keep;'),
    );
    expect(result.supported).toBe(false);
    expect(server.received.map((c) => c.line)).toEqual([expect.stringMatching(/^AUTHENTICATE/)]);
  });

  it('keeps the response code on errors', async () => {
    server = await startFakeSieveServer(() => 'NO (NONEXISTENT) "There is no script"\r\n');
    await expect(
      service.withSession(loopbackSieveAccount(server.port), (s) => s.getScript('nope')),
    ).rejects.toMatchObject({ code: 'NONEXISTENT', command: 'GETSCRIPT' });
  });
});

describe('transport safety', () => {
  it('refuses plain text to a remote host before connecting', async () => {
    const account: AccountConfig = {
      ...loopbackSieveAccount(1),
      sieve: { enabled: true, host: 'sieve.example.invalid', tls: false, starttls: false },
    };
    await expect(service.withSession(account, (s) => s.listScripts())).rejects.toThrow(
      /unencrypted/,
    );
  });

  it('refuses to log in when STARTTLS is required but not offered', async () => {
    server = await startFakeSieveServer(() => 'OK\r\n');
    const account: AccountConfig = {
      ...loopbackSieveAccount(server.port),
      sieve: { enabled: true, host: '127.0.0.1', port: server.port, tls: false, starttls: true },
    };
    await expect(service.withSession(account, (s) => s.listScripts())).rejects.toThrow(
      /did not offer STARTTLS/,
    );
    await new Promise((resolve) => {
      setTimeout(resolve, 30);
    });
    expect(server.received).toEqual([]);
  });

  it('refuses data injected before the STARTTLS handshake', async () => {
    server = await startFakeSieveServer(
      (cmd) => (cmd.line === 'STARTTLS' ? 'OK "go"\r\n"SASL" "PLAIN"\r\n' : undefined),
      `"STARTTLS"\r\n${DEFAULT_GREETING}`,
    );
    const account: AccountConfig = {
      ...loopbackSieveAccount(server.port),
      sieve: { enabled: true, host: '127.0.0.1', port: server.port, tls: false, starttls: true },
    };
    await expect(service.withSession(account, (s) => s.listScripts())).rejects.toThrow(
      /before the TLS handshake/,
    );
  });

  it('refuses a server without SASL PLAIN for a password account', async () => {
    server = await startFakeSieveServer(() => undefined, '"SASL" "GSSAPI"\r\nOK\r\n');
    await expect(
      service.withSession(loopbackSieveAccount(server.port), (s) => s.listScripts()),
    ).rejects.toThrow(/does not offer SASL PLAIN/);
  });

  it.each([
    ['for a name with a line break', 'ok\r\nDELETESCRIPT "other"', 'keep;'],
    ['for a name with U+0085', 'ok\u0085name', 'keep;'],
    ['for a name over 255 characters', 'a'.repeat(256), 'keep;'],
    ['for a script over 1 MiB', 'big', 'a'.repeat(MAX_SIEVE_SCRIPT_BYTES + 1)],
  ])('sends nothing %s', async (_label, name, content) => {
    server = await startFakeSieveServer(() => 'OK\r\n');
    await expect(
      service.withSession(loopbackSieveAccount(server.port), (s) => s.putScript(name, content)),
    ).rejects.toThrow(/name|large/i);
    expect(server.received.filter((c) => c.line.startsWith('PUTSCRIPT'))).toEqual([]);
  });
});

describe('OAuth login', () => {
  const oauthAccount = (port: number): AccountConfig => ({
    ...loopbackSieveAccount(port),
    password: undefined,
    oauth2: { provider: 'custom', clientId: 'id', clientSecret: 'cs', refreshToken: 'rt' },
  });
  const oauthService = new SieveService({ getAccessToken: async () => 'access-token-1234' });

  it('prefers OAUTHBEARER', async () => {
    server = await startFakeSieveServer(
      () => undefined,
      '"SASL" "PLAIN XOAUTH2 OAUTHBEARER"\r\nOK\r\n',
    );
    await oauthService.withSession(oauthAccount(server.port), async () => undefined);
    expect(server.received[0]?.line).toBe(
      `AUTHENTICATE "OAUTHBEARER" "${encodeOAuthBearer('user@example.com', '127.0.0.1', server.port, 'access-token-1234')}"`,
    );
  });

  it('falls back to XOAUTH2', async () => {
    server = await startFakeSieveServer(() => undefined, '"SASL" "PLAIN XOAUTH2"\r\nOK\r\n');
    await oauthService.withSession(oauthAccount(server.port), async () => undefined);
    expect(server.received[0]?.line).toBe(
      `AUTHENTICATE "XOAUTH2" "${encodeXOAuth2('user@example.com', 'access-token-1234')}"`,
    );
  });

  it('refuses when neither OAuth mechanism is offered, without sending the token', async () => {
    server = await startFakeSieveServer(() => undefined, '"SASL" "PLAIN"\r\nOK\r\n');
    await expect(
      oauthService.withSession(oauthAccount(server.port), async () => undefined),
    ).rejects.toThrow(/neither OAUTHBEARER nor XOAUTH2/);
    expect(server.received).toEqual([]);
  });

  it('answers an OAUTHBEARER failure challenge and reports the refusal redacted', async () => {
    server = await startFakeSieveServer(
      (cmd) => (cmd.line === '"AQ=="' ? 'NO "token access-token-1234 rejected"\r\n' : undefined),
      '"SASL" "OAUTHBEARER"\r\nOK\r\n',
      () => '"eyJzdGF0dXMiOiI0MDEifQ=="\r\n',
    );
    await expect(
      oauthService.withSession(oauthAccount(server.port), async () => undefined),
    ).rejects.toThrow('AUTHENTICATE failed: token [redacted] rejected');
  });
});
