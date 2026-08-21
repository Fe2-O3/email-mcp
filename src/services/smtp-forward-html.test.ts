/**
 * `forward_email` silently downgraded HTML forwards to plain text, so the
 * recipient saw raw `<p>` and `<strong>` markup. SMTP returned 250 OK and the
 * Sent copy looked fine, which is why it went unnoticed.
 *
 * Two independent causes: the tool schema declared no `html` parameter, so the
 * SDK's zod parse stripped it before the handler ever saw it, and the service
 * hardcoded `text:` on the nodemailer payload.
 *
 * The escaping test is not incidental. Every header field here comes from a
 * message a stranger composed, and forwarding interpolates them into markup
 * the user then sends onward under their own name.
 *
 * Upstream: codefuturist/email-mcp#45
 */

import SmtpService from './smtp.service.js';

const sendMail = vi.fn().mockResolvedValue({ messageId: '<sent@example.invalid>' });

const original = {
  subject: 'Quarterly numbers',
  date: '2026-08-01T10:00:00Z',
  from: { name: 'Alice Example', address: 'alice@example.invalid' },
  to: [{ address: 'bob@example.invalid' }],
  bodyText: 'plain fallback',
  bodyHtml: '<p>the <strong>real</strong> content</p>',
};

function buildService(overrides: Partial<typeof original> = {}) {
  const connections = {
    getAccount: () => ({ email: 'me@example.invalid', fullName: 'Me' }),
    getSmtpTransport: async () => ({ sendMail }),
  };
  const imapService = {
    getEmail: async () => ({ ...original, ...overrides }),
  };
  return new SmtpService(
    connections as never,
    { tryConsume: () => true } as never,
    imapService as never,
  );
}

/** The single nodemailer payload produced by the last forward. */
function lastPayload(): Record<string, unknown> {
  return sendMail.mock.calls.at(-1)?.[0] as Record<string, unknown>;
}

/** The html body of that payload. */
function payloadHtml(): string {
  return lastPayload().html as string;
}

describe('forwardEmail honours the html flag', () => {
  beforeEach(() => {
    sendMail.mockClear();
  });

  it('sends an html payload, not text, when html is true', async () => {
    await buildService().forwardEmail('acct', {
      emailId: '1',
      to: ['someone@example.invalid'],
      body: '<p>See below.</p>',
      html: true,
    });

    const payload = lastPayload();
    expect(payload.html).toBeTypeOf('string');
    expect(payload.text).toBeUndefined();
    expect(payload.html).toContain('<p>See below.</p>');
  });

  it('carries the original html part through rather than the text fallback', async () => {
    await buildService().forwardEmail('acct', {
      emailId: '1',
      to: ['someone@example.invalid'],
      html: true,
    });

    expect(payloadHtml()).toContain('<strong>real</strong>');
  });

  it('escapes header fields that came from the original sender', async () => {
    await buildService({
      subject: 'Hi <script>alert(1)</script>',
      from: { name: '<img src=x onerror=alert(1)>', address: 'evil@example.invalid' },
    }).forwardEmail('acct', {
      emailId: '1',
      to: ['someone@example.invalid'],
      html: true,
    });

    const html = payloadHtml();
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;script&gt;');
  });

  it('wraps a plain-text original so its line breaks survive', async () => {
    await buildService({ bodyHtml: undefined }).forwardEmail('acct', {
      emailId: '1',
      to: ['someone@example.invalid'],
      html: true,
    });

    expect(payloadHtml()).toContain('<pre>');
  });

  it('still sends plain text when html is not set', async () => {
    await buildService().forwardEmail('acct', {
      emailId: '1',
      to: ['someone@example.invalid'],
    });

    const payload = lastPayload();
    expect(payload.text).toBeTypeOf('string');
    expect(payload.html).toBeUndefined();
    expect(payload.text).toContain('---------- Forwarded message ----------');
  });
});
