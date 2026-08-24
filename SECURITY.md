# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x.x   | ✅ Latest  |

## Reporting a Vulnerability

**Please do not report security vulnerabilities through public GitHub
issues.**

GitHub's private vulnerability reporting is not enabled for this repository
yet. Until then:

- **Maintainers of the project:** use the maintainer's private contact
  channel, or open a draft advisory once private reporting is switched on.
- **Everyone else:** describe the issue without exploit details in a direct
  message to a maintainer, and we will follow up.

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

## Best Practices for Users

- Use app-specific passwords instead of your main account password
- Enable OAuth2 authentication where supported (Gmail, Outlook)
- Review the audit log at `~/.local/share/email-mcp/audit.jsonl`
- Use `read_only: true` in config if you only need read access
- Set a token whenever you run the HTTP server, including on loopback
- Keep email-mcp updated to the latest version
