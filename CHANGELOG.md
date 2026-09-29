# Changelog

All notable changes to **this fork** ([Fe2-O3/email-mcp](https://github.com/Fe2-O3/email-mcp)) are recorded in this file.

- This fork starts its **own version line at 0.1.0** (2026-09-28). The package was previously frozen at the upstream development version `0.3.0`.
- Everything at or before the fork point (2026-08-21, `7fe8916`) is inherited upstream history. For the original project's releases — v0.1.0 through **v0.5.1** — see the **[codefuturist/email-mcp releases page](https://github.com/codefuturist/email-mcp/releases)** and their changelog.
- The format loosely follows [Keep a Changelog](https://keepachangelog.com/); commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## [0.1.0] — 2026-09-28

First release of the hardened fork: **88 commits** past the fork point, **428 tests** green.

### Ported from upstream v0.5.1

- **TLS servername repair for IP-literal IMAP hosts** ([upstream 70d4215](https://github.com/codefuturist/email-mcp/commit/70d4215de07920252f672923cf3cd48aad7a0189)) — imapflow sets `servername = false` for IP-literal hosts, which Node's `tls.connect()` rejects; every IMAP connection to an IP address died before authentication. All three construction sites now route through `createImapClient()`.
- **`config validate`** ([upstream bf09dcc](https://github.com/codefuturist/email-mcp/commit/bf09dcc1f087279812fe307647bf8e52198becd8)) — syntax, schema, did-you-mean typo detection, and cross-setting consistency checks; exit 1 on errors (CI-friendly). Adapted to this fork's settings sections.
- **Dependency set aligned with upstream v0.5.1** — imapflow 1.7 → 2.0.8, nodemailer 9 → 10, vitest 4 → 5, zod 4.4 → 4.6, `@clack/prompts` 1.7 → 1.8, MCP SDK/server/node minors, dev-tool bumps.
- **Factory schema defaults** (same upstream commit as `config validate`) — a static object default was one shared instance across parses; mutating one parsed config poisoned later loads.

### Fixed — open upstream issues (all still open on the upstream tracker)

| Issue(s) | Fix |
|---|---|
| [#12](https://github.com/codefuturist/email-mcp/issues/12) | `download_attachment` gained `savePath` — writes to disk, returns path, size, sha256 |
| [#20](https://github.com/codefuturist/email-mcp/issues/20) [#92](https://github.com/codefuturist/email-mcp/issues/92) | Sent mail files into Sent via IMAP APPEND after SMTP send |
| [#45](https://github.com/codefuturist/email-mcp/issues/45) | `forward_email` honours the html flag |
| [#52](https://github.com/codefuturist/email-mcp/issues/52) | Attachments on forward, send, and draft paths |
| [#55](https://github.com/codefuturist/email-mcp/issues/55) | Memory leak — connection rotation (30 min) + cache eviction (5 min TTL) |
| [#57](https://github.com/codefuturist/email-mcp/issues/57) | Error/close handlers on every ImapFlow client (no more process crash) |
| [#58](https://github.com/codefuturist/email-mcp/issues/58) | GBNF-safe schemas — llama.cpp models no longer fail every call |
| [#59](https://github.com/codefuturist/email-mcp/issues/59) | `list_emails` / `search_emails` order by date, not UID |
| [#60](https://github.com/codefuturist/email-mcp/issues/60) | stdio server exits when the client closes stdin (no orphan processes) |
| [#62](https://github.com/codefuturist/email-mcp/issues/62) | Retried sends identifiable; accidental duplicates refused |
| [#66](https://github.com/codefuturist/email-mcp/issues/66) [#95](https://github.com/codefuturist/email-mcp/issues/95) | Multipart bodies decoded; richer text preferred over raw MIME |
| [#71](https://github.com/codefuturist/email-mcp/issues/71) [#91](https://github.com/codefuturist/email-mcp/issues/91) | Search failures on broken IMAP4rev2 servers fail loudly |
| [#79](https://github.com/codefuturist/email-mcp/issues/79) | `read_only` gates background services and calendar writes |
| [#96](https://github.com/codefuturist/email-mcp/issues/96) | Draft subjects RFC 2047-encoded via MailComposer |

### Fixed — local finds (no upstream issue)

- **UID-join argument overflow** — full-set UID fetches chunked at 400 per command; list/search/stats now work on 64,000+ message mailboxes (Hostinger 64k verified)
- **Login-failure visibility** — IMAP rejections surface `responseText` (auth reason) instead of a bare "Command failed"
- Output schema drift (`messageId` missing from list schema), broken-config reported as "no configuration found", IMAP STARTTLS never reaching the client, watcher skipping OAuth2 sign-in, `send_draft` dropping Bcc, same-name attachments overwriting, `reply_email` ignoring Reply-To, calendar duplicate-check/timeout/quote bugs, quota reported in wrong units, retry guard saved before send, hooks listener scoping, double reconnect emit, watcher bulk headers, named-calendar query timeout, `tcpa` account credentials
- **Idle exit** — stdio server exits after `settings.idle_exit` seconds (default 1800, 0 disables) so hosts that never close the pipe can't pin orphans

### Security

- SMTP header injection blocked (sender name via address object); constant-time token compare; OAuth watcher never uses a password as an access token; private/CGNAT IP ranges blocked in webhook dispatch (SSRF); OAuth endpoints must be HTTPS; scheduler validates emails, UUIDs, file permissions; config credentials written owner-only; webhook dispatch pinned to the validated address; HTTP token required even on loopback with bounded request bodies; draft headers sanitized; keychain invokes only `/usr/bin/security`; disclosure policy in SECURITY.md (Issues are disabled here, so bug reports go upstream)

### Added

- Sent-folder filing (IMAP APPEND), attachments on send/forward/draft, `savePath` downloads, duplicate-send guard, Reply-To awareness, Bcc on draft send, quota in MB
- `password_command` (1Password, Bitwarden, pass, shell), macOS Keychain sentinels + `keychain migrate`
- Bulk-mail classification from RFC headers; `get_email_security` (DMARC/SPF/DKIM); offline SQLite cache with retention caps (`window_days`, `max_size_mb`); connection rotation; cheap stats via STATUS+SEARCH; `find_email_folder` priority-folder search
- Streamable HTTP transport alongside stdio; three setup modes (TLS/STARTTLS/plain); clear setup errors; OAuth-aware watching

### Changed

- MCP TypeScript SDK **v2** (spec revision 2026-07-28) with structured output
- README rewritten: client guides (Claude Desktop/Code, Cursor, VS Code, Codex, OpenCode, HTTP), version history links, comparison with upstream
- Test suite grew to **428** tests (55 files), including stdio lifecycle (stdin close + idle exit) and the ported validator

[0.1.0]: https://github.com/Fe2-O3/email-mcp/releases/tag/v0.1.0
