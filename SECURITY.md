# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x.x   | ✅ Latest  |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub issues.**

Use one of these private channels:

- **GitHub Private Vulnerability Reporting** — Enabled on this repository.
  Go to the **Security** tab → **Report a vulnerability** to submit a private
  advisory. GitHub will notify the maintainers directly.
- **Email** — If you prefer email, send details to the maintainer's private
  contact channel. Do not include exploit code in the initial report.

You should receive an acknowledgement within a few days. If the issue is
confirmed, a fix will be released as soon as possible.

## Security Considerations

email-mcp handles sensitive email credentials and message content. The
project includes several security measures:

- **Credential file permissions** — the config file that stores account
  secrets is written readable only by its owner.
- **HTTP transport authentication** — HTTP mode requires a bearer token,
  compared in constant time; the server refuses to bind a non-loopback
  interface without one.
- **Webhook destination checks** — alert webhook URLs are validated when
  configured and again at dispatch, resolved through DNS with private,
  loopback and link-local destinations refused, and redirects are never
  followed.
- **Audit logging** — write operations are logged with automatic redaction
  of sensitive fields (passwords, tokens, message bodies).
- **Rate limiting** — configurable rate limits on send operations
  (default: 10/minute).
- **Read-only mode** — disables all write tools, including alert
  configuration and notification testing.
- **Input validation** — all tool inputs are validated with Zod schemas;
  request bodies over the size cap are refused.
- **Connection rotation** — IMAP connections are rotated every 30 minutes
  to prevent buffer accumulation and stale state.
- **Cache eviction** — label strategy caches are evicted after 5 minutes
  to prevent unbounded growth.

## Best Practices for Users

- Use app-specific passwords instead of your main account password
- Enable OAuth2 authentication where supported (Gmail, Outlook)
- Review the audit log at `~/.local/share/email-mcp/audit.jsonl`
- Use `read_only: true` in config if you only need read access
- Set a token whenever you run the HTTP server, including on loopback
- Keep email-mcp updated to the latest version
