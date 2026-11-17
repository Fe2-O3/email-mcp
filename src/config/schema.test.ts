import {
  AccountConfigSchema,
  AppConfigFileSchema,
  ImapConfigSchema,
  SettingsSchema,
  SmtpConfigSchema,
} from './schema.js';

const validImap = { host: 'imap.example.com' };
const validSmtp = { host: 'smtp.example.com' };

function validAccount(overrides = {}) {
  return {
    name: 'test',
    email: 'user@example.com',
    password: 'secret',
    imap: validImap,
    smtp: validSmtp,
    ...overrides,
  };
}

describe('ImapConfigSchema', () => {
  it('applies default port of 993', () => {
    const result = ImapConfigSchema.parse({ host: 'imap.example.com' });
    expect(result.port).toBe(993);
  });

  it('rejects port 0', () => {
    expect(() => ImapConfigSchema.parse({ host: 'imap.example.com', port: 0 })).toThrow();
  });

  it('rejects port 65536', () => {
    expect(() => ImapConfigSchema.parse({ host: 'imap.example.com', port: 65536 })).toThrow();
  });

  it('accepts valid port', () => {
    const result = ImapConfigSchema.parse({ host: 'imap.example.com', port: 143 });
    expect(result.port).toBe(143);
  });
});

describe('SmtpConfigSchema', () => {
  it('applies default port of 465', () => {
    const result = SmtpConfigSchema.parse({ host: 'smtp.example.com' });
    expect(result.port).toBe(465);
  });

  it('rejects port 0', () => {
    expect(() => SmtpConfigSchema.parse({ host: 'smtp.example.com', port: 0 })).toThrow();
  });

  it('rejects port 65536', () => {
    expect(() => SmtpConfigSchema.parse({ host: 'smtp.example.com', port: 65536 })).toThrow();
  });

  it('applies pool defaults', () => {
    const result = SmtpConfigSchema.parse({ host: 'smtp.example.com' });
    expect(result.pool).toEqual({
      enabled: true,
      max_connections: 1,
      max_messages: 100,
    });
  });
});

describe('AccountConfigSchema', () => {
  it('accepts valid minimal config with password', () => {
    const result = AccountConfigSchema.parse(validAccount());
    expect(result.name).toBe('test');
    expect(result.email).toBe('user@example.com');
  });

  it('accepts valid config with oauth2 instead of password', () => {
    const result = AccountConfigSchema.parse(
      validAccount({
        password: undefined,
        oauth2: {
          provider: 'google',
          client_id: 'id',
          client_secret: 'secret',
          refresh_token: 'token',
        },
      }),
    );
    expect(result.oauth2?.provider).toBe('google');
  });

  it('accepts a per-account outbound attachment limit', () => {
    const result = AccountConfigSchema.parse(validAccount({ max_attachment_mb: 40 }));
    expect(result.max_attachment_mb).toBe(40);
  });

  it('rejects a non-positive per-account outbound attachment limit', () => {
    expect(() => AccountConfigSchema.parse(validAccount({ max_attachment_mb: 0 }))).toThrow();
  });

  it('rejects when neither password nor oauth2 provided', () => {
    expect(() => AccountConfigSchema.parse(validAccount({ password: undefined }))).toThrow(
      'password or oauth2',
    );
  });

  it('rejects missing name', () => {
    expect(() => AccountConfigSchema.parse(validAccount({ name: '' }))).toThrow();
  });

  it('rejects invalid email format', () => {
    expect(() => AccountConfigSchema.parse(validAccount({ email: 'not-an-email' }))).toThrow();
  });

  it('rejects missing imap', () => {
    expect(() => AccountConfigSchema.parse({ ...validAccount(), imap: undefined })).toThrow();
  });

  it('rejects missing smtp', () => {
    expect(() => AccountConfigSchema.parse({ ...validAccount(), smtp: undefined })).toThrow();
  });
});

describe('SettingsSchema', () => {
  it('applies default rate_limit of 10', () => {
    const result = SettingsSchema.parse({});
    expect(result.rate_limit).toBe(10);
  });

  it('defaults the outbound attachment limit to 25 MB', () => {
    const result = SettingsSchema.parse({});
    expect(result.send.max_attachment_mb).toBe(25);
  });

  it('keeps verification lookup and magic-link lookup opt-in', () => {
    const result = SettingsSchema.parse({});
    expect(result.verification).toEqual({ enabled: false, include_magic_links: false });
  });

  it('accepts a custom outbound attachment limit', () => {
    const result = SettingsSchema.parse({ send: { max_attachment_mb: 12 } });
    expect(result.send.max_attachment_mb).toBe(12);
  });

  it('applies default read_only of false', () => {
    const result = SettingsSchema.parse({});
    expect(result.read_only).toBe(false);
  });

  it('applies default idle_exit of 0 (server lives until the client closes stdin)', () => {
    const result = SettingsSchema.parse({});
    expect(result.idle_exit).toBe(0);
  });

  it('accepts custom values', () => {
    const result = SettingsSchema.parse({ rate_limit: 5, read_only: true });
    expect(result.rate_limit).toBe(5);
    expect(result.read_only).toBe(true);
  });
});

describe('AppConfigFileSchema', () => {
  it('accepts valid config with one account', () => {
    const result = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(result.accounts).toHaveLength(1);
  });

  it('requires at least one account', () => {
    expect(() => AppConfigFileSchema.parse({ accounts: [] })).toThrow('At least one account');
  });

  it('applies settings defaults when not provided', () => {
    const result = AppConfigFileSchema.parse({ accounts: [validAccount()] });
    expect(result.settings.rate_limit).toBe(10);
    expect(result.settings.read_only).toBe(false);
  });

  it('rejects accounts with invalid email', () => {
    expect(() =>
      AppConfigFileSchema.parse({ accounts: [validAccount({ email: 'bad' })] }),
    ).toThrow();
  });
});

describe('AccountConfigSchema plain-text login guard', () => {
  const plain = { tls: false, starttls: false };

  it('rejects plain IMAP to a remote host, naming account, protocol and host', () => {
    const result = AccountConfigSchema.safeParse(
      validAccount({ imap: { host: 'imap.example.com', ...plain } }),
    );
    expect(result.success).toBe(false);
    const message = result.error?.issues.map((i) => i.message).join('\n');
    expect(message).toContain('"test"');
    expect(message).toContain('IMAP');
    expect(message).toContain('imap.example.com');
    expect(message).toContain('tls = true or starttls = true');
  });

  it('rejects plain SMTP to a remote host', () => {
    const result = AccountConfigSchema.safeParse(
      validAccount({ smtp: { host: 'smtp.example.com', ...plain } }),
    );
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.message).toContain('SMTP');
  });

  it('allows implicit TLS', () => {
    expect(AccountConfigSchema.safeParse(validAccount()).success).toBe(true);
  });

  it('allows STARTTLS', () => {
    const result = AccountConfigSchema.safeParse(
      validAccount({
        imap: { host: 'imap.example.com', tls: false, starttls: true },
        smtp: { host: 'smtp.example.com', tls: false, starttls: true },
      }),
    );
    expect(result.success).toBe(true);
  });

  it.each(['localhost', '127.0.0.1', '::1', '[::1]'])(
    'allows plain text to loopback %s',
    (host) => {
      const result = AccountConfigSchema.safeParse(
        validAccount({ imap: { host, ...plain }, smtp: { host, ...plain } }),
      );
      expect(result.success).toBe(true);
    },
  );

  it.each(['127.1', 'localhost.'])('rejects plain text to the non-literal spelling %s', (host) => {
    const result = AccountConfigSchema.safeParse(validAccount({ imap: { host, ...plain } }));
    expect(result.success).toBe(false);
  });

  it('is reported through the whole-file schema used by config validate', () => {
    const result = AppConfigFileSchema.safeParse({
      accounts: [validAccount({ imap: { host: 'imap.example.com', ...plain } })],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['accounts', 0, 'imap', 'tls']);
  });
});
