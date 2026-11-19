# Changelog

All notable changes to **this fork** ([Fe2-O3/imap-wizard](https://github.com/Fe2-O3/imap-wizard)) are recorded in this file.

- This fork starts its **own version line at 0.1.0** (2026-09-28). The package was previously frozen at the upstream development version `0.3.0`.
- Everything at or before the fork point (2026-08-21, `7fe8916`) is inherited upstream history. For the original project's releases — v0.1.0 through **v0.5.1** — see the **[codefuturist/email-mcp releases page](https://github.com/codefuturist/email-mcp/releases)** and their changelog.
- The format loosely follows [Keep a Changelog](https://keepachangelog.com/); commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## [Unreleased]

### Added

- Pick what your AI can do. Setup shows one screen of tick boxes sorted by risk: read (always on), drafts, send, tidy up, delete, calendar, filter rules, reports, templates, alerts, and the sign-in code catcher. Every feature is listed. Safe ones start ticked (read, drafts, tidy up, calendar: 29 tools instead of 62); send, delete, rules and the code catcher start off. Ticking templates adds an example template; ticking the code catcher turns it on.
- Bulk actions can delete only when the "Delete mail" box is ticked.
- New `imap-wizard tools` command to change the choice later (`show`, `set drafts,send`, `reset`). It edits only the one `tools` line in config.toml, so comments stay.
- The log now says why the server stopped, for example "the MCP client closed the connection". Clients often call any stop "unexpected", so this tells a normal stop from a crash.
- `imap-wizard install` now also sets up Claude Code, VS Code, Codex and OpenCode.
- Setup ends by offering to connect the server to your AI app. Say no and it shows the `npx` commands to run later.
- New `settings.tools` setting (env `MCP_EMAIL_TOOLS`). When set it wins over `toolset`. The `full`, `core` and `minimal` presets and `read_only` work as before.

### Changed

- Setup no longer asks three SMTP "pool" questions. It uses one connection for up to 100 messages, which suits normal mailboxes. You can still change `[accounts.smtp.pool]` in config.toml.
- The end of setup used to show a config snippet that ran a global `imap-wizard` command most people do not have. It now uses `npx`.
- Less log noise. A background sync cut off by shutdown is logged as info, not a warning. Node's "SQLite is an experimental feature" notice is no longer printed on every start; other warnings still are.

## [0.3.6] — 2026-11-18

A safety and reliability release. A full review of the app by several models found about 120 problems; this release fixes most of them. Some behavior is stricter than before; see **Changed**.

### Changed (stricter than before)

- A one-message tool given a UID range or list (`1:*`, `1,2`) is refused instead of acting on many messages.
- `delete_mailbox` refuses a folder that still holds mail. `send_draft` only sends messages from the Drafts folder, then moves them to Trash.
- Local rules refuse catch-all patterns and moves into special-use folders (Trash, Junk, Drafts, Sent, Archive) or watched folders, and check labels. Old catch-all rules still load and run, with a warning.
- Sieve: a script that includes a server-wide script, or runs `filter` with a program not listed in the new `[sieve] allowed_programs`, is refused. You cannot delete a script the active script includes, or a backup that is the only copy of a script.
- The alert webhook can only be set in `config.toml`; `configure_alerts` no longer takes `webhook_url` or `webhook_events`.
- The scheduler sends nothing while `read_only` is on; queued mail waits.
- `download_attachment` and `export_email` refuse file names that start with a dot and types that run when opened (`.command`, `.terminal`, `.app`, `.scpt`, `.sh`, `.plist`).
- If the writer lock cannot be used, the watcher, hooks and alerts pause until it works, instead of running in every window.
- With the account set by environment variables, `[settings]` still come from `config.toml` (a line says so), and `read_only` on in either place wins. Yes/no variables are read strictly; a value like `enabled` stops the start. Two accounts with the same name stop the start.
- An IMAP account with both `tls` and `starttls` loads with a warning and uses implicit TLS.

### Added

- `allow_duplicate` on `send_email`, `reply_email`, `forward_email` and `send_draft`; `occurrence` on `download_attachment` (and `--occurrence` on the CLI) for two attachments with the same name.
- `[sieve] allowed_programs` (env `MCP_EMAIL_SIEVE_ALLOWED_PROGRAMS`) and a per-account `append_sent` setting (off by default for Gmail, which files sent mail itself).
- Forwards carry an `X-IMAP-Wizard-Forwarded` header, and rules never forward a marked message.

### Fixed

- **Sending:** two identical sends at once now produce one send. A send that may or may not have reached the server is reported as "unknown, check Sent first" and never retried. A refused recipient no longer makes other queued sends fail. Replies say who received them and warn when Reply-To is on another domain.
- **Scheduler:** scheduled mail is never resent after the server may have taken it. A short outage no longer fails a job for good. Failed and unknown jobs are visible and can be cancelled. OAuth accounts work, and every scheduled send is in the audit log.
- **Drafts, folders, expunge:** editing a draft, deleting a folder or expunging no longer loses other mail. Permanent delete on a server without UIDPLUS works, with a warning.
- **Watcher:** an email with a bad date, a STARTTLS failure or a restart no longer stops the watcher. Mail that arrived during a gap of under an hour is caught up.
- **Connections:** the 30-minute connection rotation waits until nothing is using the connection. The 60-second mailbox wait also covers opening the mailbox. The first cache sync fetches in chunks of 500 and resumes if cut off. Move, delete, mark and bulk actions cut off by a dropped connection say the server may have done it.
- **OAuth:** one token refresh per account, bad answers refused, 30-second limit, rotated refresh tokens kept, and the mail sender rebuilt before its token runs out.
- **Cache:** an account name pointed at another server drops its old cached mail. A cache from a newer build is left alone, and a broken cache file is replaced. `account delete` removes that account's cached mail.
- **Passwords:** an account whose Keychain item or password command can't be read never logs in with the wrong text; other accounts keep working. Passwords and tokens are scrubbed from error text in more forms.
- **CLI:** `account add` no longer overwrites a config file it cannot read, and `account edit` keeps settings it does not ask about. `keychain remove` and `migrate` do nothing when you answer No. `config.toml` is written safely, with the previous copy kept as `config.toml.bak`. `scheduler uninstall` leaves other cron lines alone. `imap-wizard read` prints no terminal control codes.
- **HTTP mode:** repeated and simultaneous calls work, and SIGTERM exits cleanly.
- **Attachments:** two with the same name keep their own bytes; inline and name-only PDFs are listed and forwarded; saved files are never overwritten; one failed attachment no longer hides the others. `savePath` allows files up to 50 MB. A message body that did not download is reported instead of shown as empty.
- **Calendar:** attachments are saved only after you accept the dialog, the dialog shows the real date, and an unreadable email date no longer builds a calendar script. Calendar and Reminders lists report a refused permission instead of an empty list.
- **Rules:** edits at the same time no longer lose each other, matching can no longer freeze the app, and removing a forward address applies at once. Scheduled emails and rules stop when their account now points at a different server or login.
- **Audit log:** a full or broken audit log no longer makes a finished action look like it failed.
- `list_templates` names broken template files, and a failed batch of new mail is logged.

### Security

- Windows desktop alerts no longer run PowerShell code from an email subject.
- Tool results that contain email text are marked as untrusted, including structured results (`untrusted: true`), calendar, contacts, stats and Sieve server text. AI triage can no longer have its fence closed by a subject line.
- `get_email_security` trusts only the top authentication header and your own server's headers. `get_verification_code` fences the link and warns when its host is not the sender's.
- `get_email` with `markRead` is refused on a read-only server.
- The audit log, calendar state, attachments and cache files are owner-only (0600/0700). A `config.toml` readable by others gets a warning.
- Releases build only real version tags, outside actions are pinned to commits, and the downloaded `mcp-publisher` is checked against its sha256.

### Docs

- README covers the per-process send limit, the forward allowlist (read live from `config.toml`, for standing forwards only), what read-only mode covers, and Docker volumes for the state and data folders.

## [0.3.5] — 2026-11-18

### Added

- **Server-side filter rules (Sieve over ManageSieve):** `sieve_status`, `sieve_list_scripts`, `sieve_get_script`, `sieve_check_script`, `sieve_put_script`, `sieve_activate_script`, `sieve_delete_script`. Previews and diffs by default (`apply: true` to save), the server's CHECKSCRIPT when offered, automatic backups before replace or delete, refusal to delete the active script, `disableAll: true` needed to turn every script off. STARTTLS or implicit TLS with full certificate checks; SASL PLAIN or OAuth. Client adapted from Mailoo by Bitfloo.
- **Local rules** for providers without Sieve: `list_local_rules`, `add_local_rule`, `remove_local_rule`. Match on from, to, subject or header; move, label, flag, mark read, or forward. They run in the watcher while IMAP Wizard runs and are stored in `local-rules.json`.
- Config: `[sieve] allowed_redirects` and per-account `[accounts.sieve]` (`enabled`, `host`, `port`, `tls`, `starttls`), with `MCP_EMAIL_SIEVE_*` env vars.

### Security

- Forwarding by any rule (Sieve `redirect`, including `:copy`; local forward) is allowed only to addresses or domains in `allowed_redirects`, which a person edits in `config.toml`. No tool writes `config.toml` (enforced by a test) and no argument bypasses the check. `notify`, `report`, `pipe`, `execute` and targets the scanner cannot read for sure are blocked the same way. Included scripts are fetched and scanned too.
- Local forwards never send mail from the account itself or from the forward target, to prevent loops.

## [0.3.4] — 2026-11-18

### Added

- Attach local files by path: `send_email`, `reply_email`, `forward_email` and `save_draft` accept `path` next to `base64` (`reply_email` and `forward_email` take attachments for the first time). Reads are guarded: absolute paths and regular files only; hidden files and folders (`~/.ssh`, `.env`), system folders, `~/Library` and this app's own folders are refused, symlinks resolved first. Adapted from Mailoo by Bitfloo.
- `dryRun: true` on 11 write tools (send, reply, forward, `send_draft`, move, delete, `bulk_action`, create/rename/delete mailbox, `delete_label`) validates everything and reports what would happen, without writing. Pattern from Mailoo by Bitfloo.
- One background writer per machine: with several server processes running, only one runs the watcher, alerts and AI triage; another takes over if it dies (process gone) or hangs (no heartbeat for 120 s). Adapted from Mailoo by Bitfloo.
- `core` toolset now includes `delete_label`, `bulk_action` and `get_email_status` (24 tools; 10 in read-only).

### Fixed

- `get_verification_code` marks email-derived text as untrusted content.
- The `bcc` field of `send_email` and `save_draft` was described as CC recipients.

### Docs

- Sieve plan updated with the owner's decisions: Sieve and local rules ship together; forwarding only to a config-file allowlist that no tool can change.

## [0.3.3] — 2026-11-18

### Added

- `settings.toolset` (`"full"` default, `"core"`, `"minimal"`; env `MCP_EMAIL_TOOLSET`) sends the model a shorter tool list: 8 tools in minimal, 21 in core. Prompts and resources stay in every toolset. Grouping idea from Mailoo by Bitfloo.
- `export_email` saves a message's raw source as a `.eml` file (or returns it inline up to 5 MB). Reads with `BODY.PEEK`, so it never marks mail read. Tool shape from Mailoo by Bitfloo.
- Output schemas and structured results for `get_email`, `get_emails`, `get_thread` and `list_accounts`, so clients that generate typed tool libraries ("code mode") work better.
- Releases publish themselves: pushing a version tag runs `.github/workflows/release.yml`, which publishes to npm (trusted publishing with provenance), the MCP Registry, a multi-arch Docker image at `ghcr.io/fe2-o3/imap-wizard`, and the GitHub release.

### Security

- Email text in tool output (`get_email`, `get_emails`, `get_thread`, list and search previews) is wrapped in untrusted-content markers so a message cannot pass itself off as instructions. Structured results stay raw. Adapted from Mailoo by Bitfloo.
- `download_attachment`'s `savePath` no longer overwrites existing files or accepts relative paths. Saved files (attachments, exports, `saveEmailAttachments`) are refused in system folders, hidden folders, the home folder root and this app's own folders, including through symlinks. Path guard adapted from Mailoo by Bitfloo.
- `delete_mailbox` and `rename_mailbox` refuse INBOX and special-use folders (Sent, Drafts, Trash, Junk, Archive). Adapted from Mailoo by Bitfloo.
- Tool annotations are honest: `download_attachment` and `export_email` (write local files) and `get_email` with `markRead` are no longer marked read-only. They remain available in read-only mode as before.

### Fixed

- Waiting for a mailbox lock is bounded at 60 seconds; a stuck connection is closed and redialled instead of freezing later calls. Adapted from Mailoo by Bitfloo.
- Read-only mode now closes IMAP connections and the cache on shutdown, like write mode.

### Changed

- Node.js 22.13 or newer is supported (was 24+).
- Removed the unused GoReleaser configuration.

### Docs

- `docs/dev/sieve-plan.md`: plan for server-side filter rules (Sieve), including which providers support it.

## [0.3.2] — 2026-11-17

### Security

- **Behavior change:** an account whose IMAP or SMTP has `tls = false` and `starttls = false` to a non-loopback host is now rejected when the config loads, and by `imap-wizard config validate`. The login would cross the network in clear text. To fix a config that stops loading, set `tls = true` or `starttls = true` on the named `[accounts.imap]` / `[accounts.smtp]` section. `localhost`, `127.0.0.0/8` and `::1` stay allowed. Adapted from Mailoo by Bitfloo.
- A refused login still shows the server's own reason (for example "application-specific password required"), with any secret it quotes scrubbed.
- Error text from IMAP and SMTP connects, sends, connection tests, the watcher and the OAuth2 token endpoint now has the account's password, OAuth2 tokens and client secret replaced with `[redacted]` before it is returned or logged. Adapted from Mailoo by Bitfloo.

### Added

- `NOTICE` file with fork and attribution details; code adapted from [Mailoo](https://github.com/Bitfloo/mailoo) by Bitfloo (LGPL-3.0-or-later) is credited there and in file headers.
- A baseline test locks the registered tools, prompts and resources (names and schemas) in full and read-only mode, so accidental public API changes fail CI. Approach from Mailoo by Bitfloo.

### Fixed

- Replies and forwards no longer stack prefixes: `RE:`, `re:`, `AW:`, `SV:`, `FW:` and `WG:` are recognised in any case (upstream #102).
- Sent copies and drafts are normalised to CRLF before IMAP APPEND, so strict servers accept them (upstream #116).

### Docs

- The upstream section now shows upstream's own status for each issue as of v0.6.0, instead of implying all are still unfixed there.

## [0.3.1] — 2026-11-17

### Fixed

- MCP registry name is `io.github.Fe2-O3/imap-wizard`, matching the GitHub owner's case; the registry rejects the lowercase form.
- Dependencies updated: no known advisories in production dependencies (`pnpm audit --prod`).
- Docker images build again (lifecycle scripts skipped during install; overrides file copied).

## [0.3.0] — 2026-11-17

First npm release of this fork. 0.2.x is skipped because tags v0.2.0–v0.2.3
from the original project's history already exist in this repository.

### Added

- **Body cache for `get_email`** (opt-in, `settings.cache.read_through`, default off) — a message's body, headers and structure are immutable per (UIDVALIDITY, UID), so a repeat read costs a mailbox lock, one `UID FETCH (UID FLAGS)` and a local read; flags stay live and a moved or deleted message still reports not found. Live and cached reads build the result with the same `assembleEmail()`. Schema v2 adds the `message_body` table; bodies over 256 KB are skipped rather than truncated, and a decoder version invalidates stale rows.
- **Offline reads** (`offline_reads`, default on when `read_through` is on) — when the server is unreachable, an already-cached message is returned with a visible warning. Only genuine connectivity errors qualify; auth failures and not-found are never served from cache.
- **Bounded body backfill and budget** (`body_messages`, `body_max_mb`) — the newest mirrored messages are cached in the background one mailbox lock per message; cached bodies are LRU-evicted past `body_max_mb`, and the `max_size_mb` backstop evicts bodies before pruning message rows.

### Fixed

- **FTS reindex on flag-only resyncs** — the `message_fts_update` trigger fired on every update, rewriting the index for subject, sender and body on each flag change; it now fires only when an indexed column's value changes (migrated automatically on first open).
- **Mirror rows keyed by the sanitized mailbox name**, matching how reads look them up.

### Changed

- **BREAKING: renamed to `imap-wizard`.** The npm package is `imap-wizard` and the command is `imap-wizard`, replacing `email-mcp`. The `install` wizard's `npx`, `pnpm dlx` and global options no longer launch upstream's `@codefuturist/email-mcp`; smithery.yaml and server.json point at this fork too. The config, data and cache directories (`~/.config/email-mcp` and friends), the keychain entries, the `EMAIL_MCP_*` environment variables and the `email` key written into MCP client configs are unchanged, so existing setups keep working.
- **Idle exit now defaults to off** — `settings.idle_exit` default 1800 s → 0. The client closing stdin remains the primary exit signal, so a clean Claude/OpenCode quit still ends the server immediately; the timer is now an opt-in backstop (`idle_exit = <seconds>` or `MCP_EMAIL_IDLE_EXIT`). New configs and the config template ship `idle_exit = 0`.
- **Provider-aware outbound attachment caps** — `settings.send.max_attachment_mb` defaults to 25 MB; known provider limits can lower it, and an account-level `max_attachment_mb` can override it. The cap is checked before SMTP send, including inline and forwarded/draft attachments.
- **Opt-in verification lookup** — `get_verification_code` is registered only when `settings.verification.enabled = true`. It scans recent mail only on request; optional magic-link lookup and clipboard writes are off unless explicitly enabled/requested. The clipboard is never read or cleared, and writes are blocked in read-only mode and limited to 10 per minute.
- **Email terminal CLI** — list, read, search, mailboxes, flag, delete, attachment download, reply, and send commands reuse the IMAP/SMTP services and enforce read-only and attachment-size limits.

## [0.1.0] — 2026-09-28

First release of the hardened fork: **84 commits** past the fork point, **428 tests** green.

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

[0.3.5]: https://github.com/Fe2-O3/imap-wizard/releases/tag/v0.3.5
[0.3.4]: https://github.com/Fe2-O3/imap-wizard/releases/tag/v0.3.4
[0.3.3]: https://github.com/Fe2-O3/imap-wizard/releases/tag/v0.3.3
[0.3.2]: https://github.com/Fe2-O3/imap-wizard/releases/tag/v0.3.2
[0.3.1]: https://github.com/Fe2-O3/imap-wizard/releases/tag/v0.3.1
[0.3.0]: https://github.com/Fe2-O3/imap-wizard/releases/tag/v0.3.0
[0.1.0]: https://github.com/Fe2-O3/imap-wizard/releases/tag/v0.1.0
