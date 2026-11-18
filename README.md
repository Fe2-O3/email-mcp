<div align="center">

# IMAP Wizard

<img src="docs/assets/banner.svg" alt="IMAP Wizard: email MCP server with 51 core tools plus an opt-in verification tool, 912 tests green, 18 upstream bugs fixed" width="100%">

**Give your AI assistant your email, on your terms.**
A local [MCP](https://modelcontextprotocol.io) server that lets Claude, Codex,
Cursor, VS Code, OpenCode or any MCP client read, search, send and organize mail
over plain IMAP and SMTP. No cloud service in the middle.

[![release](https://img.shields.io/github/v/release/Fe2-O3/imap-wizard?label=release&color=8B5CF6&style=flat-square)](https://github.com/Fe2-O3/imap-wizard/releases)
[![License: LGPL v3](https://img.shields.io/badge/License-LGPL%20v3-blue.svg?style=flat-square)](LICENSE)
[![tests](https://img.shields.io/badge/tests-912%20passing-22c55e?style=flat-square)](#development)
[![Node.js 22.13+](https://img.shields.io/badge/Node.js-22.13+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![MCP SDK v2](https://img.shields.io/badge/MCP-SDK%20v2-8B5CF6?style=flat-square)](https://modelcontextprotocol.io)

<a href="#quick-start">Quick start</a> ·
<a href="#why-this-one">Why this one</a> ·
<a href="#safety-and-privacy">Safety</a> ·
<a href="#what-it-can-do">Tools</a> ·
<a href="#configuration">Config</a> ·
<a href="#troubleshooting">Troubleshooting</a> ·
<a href="#relationship-to-upstream">Upstream</a>

</div>

> **A fork, credited.** IMAP Wizard is a fork of
> [codefuturist/email-mcp](https://github.com/codefuturist/email-mcp) by
> [@codefuturist](https://github.com/codefuturist), under the same
> [LGPL-3.0-or-later](LICENSE) license. It keeps upstream's design and history,
> fixes bugs upstream still has, and adds safety
> features. The package and command are called `imap-wizard`. See
> [Relationship to upstream](#relationship-to-upstream).

---

## Quick start

You need **Node.js 22.13+** (24 recommended).

```bash
npx -y imap-wizard account add   # wizard; auto-detects common providers
npx -y imap-wizard test          # checks IMAP and SMTP for every account
npx -y imap-wizard install       # registers the server with detected MCP clients
```

Or add it to a client by hand. Claude Code:

```bash
claude mcp add email -- npx -y imap-wizard stdio
```

Claude Desktop, Cursor and most other clients take the same JSON shape:

```json
{
  "mcpServers": {
    "email": {
      "command": "npx",
      "args": ["-y", "imap-wizard", "stdio"]
    }
  }
}
```

Prefer a global command? `npm i -g imap-wizard`, then run `imap-wizard account add`
and so on. To build from source instead:

```bash
git clone https://github.com/Fe2-O3/imap-wizard.git
cd imap-wizard
pnpm install && pnpm build
node dist/main.js account add
```

and point the client at `node /absolute/path/to/imap-wizard/dist/main.js stdio`.

Ask your assistant *"What's unread in my inbox?"* to check it works.
Setup for other clients is under [More clients](#more-clients).

> [!NOTE]
> An existing `~/.config/email-mcp` config keeps working unchanged.

---

## What you can ask for

| Say this | What runs |
|---|---|
| "What's unread and older than a week?" | `list_emails`, sorted by date |
| "Find the Acme invoice from this month and save the PDF to my Downloads folder" | `search_emails`, `get_email`, `download_attachment` with `savePath` |
| "Reply to that thread: Thursday works, cc billing" | `reply_email` (honours Reply-To, files the reply into Sent) |
| "Is this sender legit?" | `get_email_security` (DMARC, SPF, DKIM results from the headers) |
| "Triage my inbox and skip the newsletters" | `triage_inbox` prompt, plus bulk-mail flags read from headers |
| "Move last month's receipts into Receipts" | `search_emails`, then `bulk_action` |

---

## Why this one

- **Bugs fixed that upstream still has.** As of upstream v0.6.0: duplicate
  sends on retry, `read_only` not stopping background mail, stdio processes
  that never exit, "Re: RE:" subjects stacking, and Sent copies rejected by
  strict servers. Several others we fixed first have since been fixed upstream
  too. [Full list with upstream status](#relationship-to-upstream).
- **Reading never changes your mailbox.** `get_email` fetches with IMAP
  `BODY.PEEK`, so mail you read stays unread unless you ask (`markRead: true`).
- **A real read-only mode.** With `read_only = true`, write tools are not
  registered at all, so the assistant cannot even see them.
- **Works on big mailboxes.** UID fetches are sent in chunks of 400, so a
  mailbox with tens of thousands of messages does not overflow the server's
  command limit.
- **No plaintext passwords required.** Use the macOS Keychain, Linux
  `secret-tool`, a `password_command` (1Password, Bitwarden, `pass`), or OAuth2.
- **Local and inspectable.** A local process talks straight to your mail
  provider. No proxy, no telemetry, no account to create.

---

## Safety and privacy

| Control | Default | What it does |
|---|---|---|
| Non-destructive reads | always | `get_email` uses `BODY.PEEK`; marking read is an explicit `markRead: true` |
| `read_only` | off | Hides every write tool and stops background services. `markRead` is refused |
| Send rate limit | 10 per minute per account | `settings.rate_limit` |
| Audit log | on | Writes are logged, with sensitive fields redacted, to `~/.local/share/email-mcp/audit.log` |
| Duplicate-send guard | on | A retried send is recognized and refused unless you pass `allow_duplicate` |
| HTTP transport token | required | `http` mode generates a bearer token, even on loopback |
| Verification-code tool | off | `get_verification_code` is only registered when you enable it; it never reads your clipboard |
| Encrypted logins | enforced | A config with `tls = false` and `starttls = false` to a non-loopback host is refused at load. Credentials in server error text are replaced with `[redacted]` |
| Untrusted-content markers | always | Email text in tool output is wrapped in `<<<UNTRUSTED_EXTERNAL_CONTENT>>>` markers that tell the model it is data, not instructions |
| Safe file saving | always | `download_attachment` and `export_email` save only to absolute paths, never overwrite an existing file, and refuse system folders, hidden folders, the home folder itself and this app's own folders |
| Protected mailboxes | always | `delete_mailbox` and `rename_mailbox` refuse INBOX, Sent, Drafts, Trash, Junk and archive folders |
| Smaller tool list | `toolset = "full"` | `"core"` (21 tools) or `"minimal"` (8 tools) sends the model fewer tools; useful for local models |
| Body cache (`read_through`) | **off** | Message bodies are only stored on disk if you turn it on. [Details](#local-body-cache-opt-in) |

What is stored on disk by default: your `config.toml` (written owner-only), the
audit log, and a local SQLite mirror of message **headers and flags** for INBOX
over the last 90 days (`settings.cache.enabled`, on by default; set it to
`false` to turn the mirror off). Message bodies are not stored unless you enable
`read_through`.

To report a vulnerability, follow [SECURITY.md](SECURITY.md). Please do not post
exploits in public.

---

## What it can do

**51 tools** (26 read, 25 write) plus **1 opt-in tool**, **7 prompts** and
**6 resources**. In read-only mode only the 26 read tools are registered.

Fewer tools, if your client or model struggles with a long list:

| `settings.toolset` | Tools (write mode / read-only) | What's in it |
|---|---|---|
| `"full"` (default) | 51 / 26 | Everything below |
| `"core"` | 21 / 10 | Minimal, plus `get_emails`, mark, move, delete, labels, drafts, `forward_email`, `download_attachment`, `export_email` |
| `"minimal"` | 8 / 6 | `list_accounts` `list_mailboxes` `list_emails` `search_emails` `get_email` `get_thread` `send_email` `reply_email` |

Prompts and resources are available in every toolset. Env var: `MCP_EMAIL_TOOLSET`.

| Group | Tools |
|---|---|
| **Read mail** | `list_accounts` `list_mailboxes` `list_emails` `search_emails` `get_email` `get_emails` `get_email_status` `get_thread` `download_attachment` `export_email` `find_email_folder` `extract_contacts` `get_email_stats` `get_email_security` `check_health` `list_templates` |
| **Calendar (read)** | `extract_calendar` `analyze_email_for_scheduling` `list_calendars` `list_events` `list_reminders` `check_calendar_permissions` |
| **Watcher (read)** | `get_watcher_status` `list_presets` `get_hooks_config` `check_notification_setup` |
| **Send** *(write)* | `send_email` `reply_email` `forward_email` `save_draft` `send_draft` `apply_template` |
| **Schedule** *(write)* | `schedule_email` `list_scheduled` `cancel_scheduled` |
| **Organize** *(write)* | `move_email` `delete_email` `mark_email` `bulk_action` `create_mailbox` `rename_mailbox` `delete_mailbox` |
| **Labels** *(write)* | `list_labels` `add_label` `remove_label` `create_label` `delete_label` |
| **Calendar and alerts** *(write)* | `add_to_calendar` `create_reminder` `configure_alerts` `test_notification` |
| **Opt-in** | `get_verification_code` (needs `settings.verification.enabled = true`) |

**Prompts:** `triage_inbox` `summarize_thread` `compose_reply`
`draft_from_context` `extract_action_items` `summarize_meetings` `cleanup_inbox`

**Resources:** `email://accounts` `email://{account}/mailboxes`
`email://{account}/unread` `email://{account}/stats` `email://templates`
`email://scheduled`

Also included: multi-account support, Streamable HTTP transport, an IMAP IDLE
watcher with optional AI triage through MCP sampling (off by default), provider
auto-detection for Gmail, Outlook, Yahoo, iCloud, Fastmail, Proton Mail Bridge,
Zoho and GMX, and a terminal CLI (`list`, `read`, `search`, `send` and more).

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Diagram: AI clients speak MCP over stdio or HTTP to a local server, which runs IMAP, SMTP, a SQLite cache, a watcher, hooks and a scheduler" width="100%">
</p>

---

## Configuration

Config lives at `~/.config/email-mcp/config.toml` (`node dist/main.js config path`
prints it). The `account add` wizard writes it for you. A typical file:

```toml
[settings]
read_only = false   # true hides every write tool
toolset = "full"    # "core" or "minimal" for a shorter tool list
rate_limit = 10     # max sends per minute per account

[[accounts]]
name = "personal"
email = "you@example.com"
full_name = "Your Name"
password = "use_keychain:personal"   # stored in the OS keychain

[accounts.imap]
host = "imap.example.com"
port = 993
tls = true

[accounts.smtp]
host = "smtp.example.com"
port = 465
tls = true
```

Check any edit with `node dist/main.js config validate`. It names the bad line,
suggests fixes for typo'd keys, and exits `1` on errors, so it also works in CI.

<details>
<summary><strong>Password options</strong></summary>

<br>

- **OS keychain:** `password = "use_keychain:<name>"`. macOS uses Keychain,
  Linux uses `secret-tool` (libsecret). `node dist/main.js keychain migrate`
  moves existing plaintext passwords over.
- **Password command:** `password_command = "op read 'op://Private/mail/password'"`
  (or `bw get password ...`, `pass show ...`). It runs once at startup, must
  print the password to stdout, and is killed after 10 seconds. It wins over
  `password` if both are set.
- **OAuth2:** an `[accounts.oauth2]` block instead of a password.
- **Plaintext:** allowed, written readable only by you. `config show` masks it.

</details>

<details>
<summary><strong>Environment-variable setup (single account, no config file)</strong></summary>

<br>

Set `MCP_EMAIL_ADDRESS`, `MCP_EMAIL_PASSWORD` (or `MCP_EMAIL_PASSWORD_COMMAND`),
`MCP_EMAIL_IMAP_HOST` and `MCP_EMAIL_SMTP_HOST`. Settings have matching
variables, for example `MCP_EMAIL_READ_ONLY=true`, `MCP_EMAIL_RATE_LIMIT`,
`MCP_EMAIL_IDLE_EXIT` and `MCP_EMAIL_SEND_MAX_ATTACHMENT_MB`.

</details>

<details>
<summary><strong>Other settings worth knowing</strong></summary>

<br>

| Setting | Default | Meaning |
|---|---|---|
| `settings.idle_exit` | `0` (off) | Seconds without a request before the stdio server exits. A backstop for clients that never close the pipe |
| `settings.send.max_attachment_mb` | `25` | Cap on attachments per message. Known providers may lower it; an account-level `max_attachment_mb` overrides |
| `settings.cache.enabled` | `true` | Local header-and-flags mirror (`mailboxes = ["INBOX"]`, `window_days = 90`, `max_size_mb = 500`) |
| `settings.watcher.enabled` | `false` | IMAP IDLE watcher for new mail, with optional hooks and alerts |
| `settings.verification.enabled` | `false` | Registers `get_verification_code` |

</details>

### Local body cache (opt-in)

> Merged on the development branch, **off by default**, and not yet in a tagged
> release.

With `read_through = true`, `get_email` keeps a decoded copy of each message it
reads. A message's body never changes for a given mailbox generation and UID, so
a repeat read only asks the server for current flags, then answers from disk.
Flags are always live, and a message that was moved or deleted is still reported
as not found.

```toml
[settings.cache]
read_through = true    # default false
offline_reads = true   # serve cached bodies, with a warning, when the server is unreachable
body_max_mb = 200      # LRU budget for cached bodies
body_messages = 500    # background backfill: newest N messages per synced mailbox (0 = off)
```

Measured with [`scripts/bench-get-email.ts`](scripts/bench-get-email.ts) on one
real account (30 INBOX messages, 60 samples): a cached read took **174 ms** at
p50 versus **714 ms** for a live read. Your numbers will depend on your
provider and network.

Bodies over 256 KB are never cached. The cache file is
`~/.cache/email-mcp/cache.db` (mode `0600`). Delete it while the server is
stopped to clear it. See [SECURITY.md](SECURITY.md) before turning this on, and
pair it with full-disk encryption.

---

## More clients

<details>
<summary><strong>Cursor</strong> (<code>~/.cursor/mcp.json</code>)</summary>

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["/absolute/path/to/imap-wizard/dist/main.js", "stdio"]
    }
  }
}
```
</details>

<details>
<summary><strong>VS Code (GitHub Copilot)</strong></summary>

```json
{
  "mcp": {
    "servers": {
      "email": {
        "type": "stdio",
        "command": "node",
        "args": ["/absolute/path/to/imap-wizard/dist/main.js", "stdio"]
      }
    }
  }
}
```
</details>

<details>
<summary><strong>Codex</strong> (<code>~/.codex/config.toml</code>)</summary>

```toml
[mcp_servers.email]
command = "node"
args = ["/absolute/path/to/imap-wizard/dist/main.js", "stdio"]
```
</details>

<details>
<summary><strong>OpenCode</strong> (<code>~/.config/opencode/opencode.json</code>)</summary>

Raise the timeout: a full-text search over a very large mailbox can take longer
than the 60-second default.

```json
{
  "mcp": {
    "email": {
      "type": "local",
      "command": ["node", "/absolute/path/to/imap-wizard/dist/main.js", "stdio"],
      "enabled": true,
      "timeout": 180000
    }
  }
}
```
</details>

<details>
<summary><strong>Streamable HTTP</strong></summary>

```bash
node dist/main.js http --port 8080
```

On first run it generates a bearer token, prints it once, and saves it to
`~/.config/email-mcp/http-token`. Send it with every request:

```json
{
  "mcpServers": {
    "email": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:8080/mcp",
      "headers": { "Authorization": "Bearer <your token>" }
    }
  }
}
```

It refuses to bind a non-loopback address without a token.
</details>

---

## Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| `MCP error -32001: Request timed out` | Your client stops waiting after 60 s; a full-text search on a huge mailbox can take longer | Raise the client timeout (`180000` in OpenCode) |
| Setup says the config file is invalid | A TOML syntax or key error | `node dist/main.js config validate` names the line and key |
| Login fails | Wrong password, or the provider needs an app password | The error now shows the server's own reason; run `node dist/main.js test` |
| Search returns nothing on a server you know has mail | Some servers return malformed SEARCH replies | This build fails loudly instead of reporting zero results; check the error |
| A server process keeps running after you quit | Your client never closes the pipe | Set `settings.idle_exit = 1800`, or close the client cleanly |
| `Cannot find module .../nodemailer/...` after an update | The old server process is still running | Restart your client (in Claude Code: `/mcp`, then reconnect) |

---

## Relationship to upstream

This project began as a fork of
[codefuturist/email-mcp](https://github.com/codefuturist/email-mcp) at commit
`7fe8916` (2026-08-21) and started its own version line at
[v0.1.0](https://github.com/Fe2-O3/imap-wizard/releases/tag/v0.1.0)
(2026-09-28). Upstream continues to ship its own releases; this fork adopts
upstream changes one at a time, with credit, rather than merging wholesale.
The review of upstream's v0.4 and v0.5 features is in
[docs/upstream-v0.5-draft.md](docs/upstream-v0.5-draft.md), and every change is
in the [CHANGELOG](CHANGELOG.md).

<details>
<summary><strong>Upstream issues fixed here</strong>, with upstream's own status as of v0.6.0 (checked 2026-11-17)</summary>

<br>

| Issue | Problem | Fix in this fork | Upstream v0.6.0 |
|---|---|---|---|
| [#12](https://github.com/codefuturist/email-mcp/issues/12) | Attachments only returned as base64 | `savePath` writes to disk and returns path, size and SHA-256 | Partly: a server-wide download folder on main, no per-call path |
| [#20](https://github.com/codefuturist/email-mcp/issues/20) [#54](https://github.com/codefuturist/email-mcp/issues/54) [#92](https://github.com/codefuturist/email-mcp/issues/92) | Sent mail never saved to Sent | IMAP APPEND into Sent after every send, on by default | Partly: opt-in, off by default |
| [#45](https://github.com/codefuturist/email-mcp/issues/45) | `forward_email` ignores `html` | Honoured | Fixed |
| [#52](https://github.com/codefuturist/email-mcp/issues/52) | No attachments on send | Attachments on send, forward and draft | Partly: `send_draft` still drops them |
| [#55](https://github.com/codefuturist/email-mcp/issues/55) | Memory leak in long-running process | Connections rotate every 30 minutes; caches evicted | Open (no rotation found; unverified) |
| [#57](https://github.com/codefuturist/email-mcp/issues/57) | Socket timeout crashes the process | Error and close handlers on every IMAP client | Fixed on main after v0.6.0 |
| [#58](https://github.com/codefuturist/email-mcp/issues/58) | Every call fails on llama.cpp models | Grammar-safe (GBNF) schemas | Fixed (via zod update) |
| [#59](https://github.com/codefuturist/email-mcp/issues/59) | Results ordered by UID | Ordered by date across the whole match set | Partly: only the current page is re-sorted |
| [#60](https://github.com/codefuturist/email-mcp/issues/60) | stdio server never exits | Exits when the client closes stdin; optional idle exit | Open |
| [#62](https://github.com/codefuturist/email-mcp/issues/62) | Retries send duplicates | Retried sends recognized and refused | Open |
| [#66](https://github.com/codefuturist/email-mcp/issues/66) [#95](https://github.com/codefuturist/email-mcp/issues/95) | Raw MIME instead of the body | Decoded bodies; richer multipart part preferred | Fixed |
| [#71](https://github.com/codefuturist/email-mcp/issues/71) [#91](https://github.com/codefuturist/email-mcp/issues/91) | Silent zero results on broken servers | A malformed (non-array) search reply fails loudly | Partly: the imapflow update avoids the Strato case |
| [#79](https://github.com/codefuturist/email-mcp/issues/79) | `read_only` does not gate background work | Calendar writes and background services gated | Open |
| [#96](https://github.com/codefuturist/email-mcp/issues/96) | Non-ASCII draft subjects not encoded | Drafts built with MailComposer (RFC 2047) | Fixed |
| [#102](https://github.com/codefuturist/email-mcp/issues/102) | Replies stack "Re: RE:" and "Fwd: FW:" | Any case and common locales (AW, SV, WG) recognised | Open |
| [#116](https://github.com/codefuturist/email-mcp/issues/116) | Sent copy rejected by strict servers (bare LF) | Line endings normalised to CRLF before APPEND | Open |

Upstream status was read from upstream's source, not from whether the issue
is closed: most of these issues are still open on GitHub even where the code
has been fixed.

Plus fixes with no upstream issue: chunked UID fetches for large mailboxes,
visible login-failure reasons, STARTTLS reaching the IMAP client, OAuth2 in the
watcher, Bcc on `send_draft`, Reply-To on `reply_email`, and more. Security
hardening covers SMTP header injection, constant-time token checks, webhook SSRF
blocking, HTTPS-only OAuth endpoints, owner-only config files, and bounded HTTP
request bodies. See the [CHANGELOG](CHANGELOG.md).

</details>

---

## Development

```bash
pnpm install
pnpm check             # Biome lint and format
pnpm typecheck
pnpm test              # unit tests (912 across 88 files)
pnpm test:integration  # against a throwaway GreenMail server (needs Docker)
pnpm smoke             # every tool against a real configured account
```

`package.json` requires Node 22.13+; development and CI use Node 24. Contributions: see
[CONTRIBUTING.md](CONTRIBUTING.md) and the
[Code of Conduct](CODE_OF_CONDUCT.md).

<details>
<summary><strong>CLI reference</strong></summary>

```text
imap-wizard [command]

  stdio                     Run as MCP server over stdio (default)
  http                      Run as MCP server over Streamable HTTP
  account list|add|edit|delete
  setup                     Alias for 'account add'
  test [account]            Test IMAP and SMTP connections
  install [status|remove]   Register with MCP clients
  config show|edit|validate|path|init
  keychain status|migrate|remove
  scheduler check|list|install|uninstall|status
  list | read <id> | search <query> | mailboxes
  flag <id> | delete <id> | attach <id> <file> | reply <id> | send
  notify                    Test and diagnose desktop notifications
  help
```

Email commands take `--account NAME` (default: the first account). Read commands
support `--json`. `delete` asks for confirmation unless you pass `--yes`.

</details>

---

## Credits

Built on [email-mcp](https://github.com/codefuturist/email-mcp) by
[@codefuturist](https://github.com/codefuturist). This fork also incorporates
work from upstream contributors:

| Contributor | Incorporated |
|---|---|
| [@rsilvestre](https://github.com/rsilvestre) | [`password_command`](https://github.com/codefuturist/email-mcp/pull/82), [stats resource fix](https://github.com/codefuturist/email-mcp/pull/93), [`find_email_folder` speed-up](https://github.com/codefuturist/email-mcp/pull/94) |
| [@b0j-an](https://github.com/b0j-an) | [Attachments on send](https://github.com/codefuturist/email-mcp/pull/77), [Sent folder copy](https://github.com/codefuturist/email-mcp/pull/78) |
| [@majkelooo](https://github.com/majkelooo) | [stdio exit fix](https://github.com/codefuturist/email-mcp/pull/61), [Sent folder filing](https://github.com/codefuturist/email-mcp/pull/80) |
| [@Seger85](https://github.com/Seger85) | [Sender authentication signals](https://github.com/codefuturist/email-mcp/pull/70), [IMAP error handling](https://github.com/codefuturist/email-mcp/pull/64), [HTTP session lifecycle](https://github.com/codefuturist/email-mcp/pull/63) |
| [@ElectricCookie](https://github.com/ElectricCookie) | [Attachment download directory](https://github.com/codefuturist/email-mcp/pull/65) |
| [@Fe2-O3](https://github.com/Fe2-O3) | [GBNF-safe schemas](https://github.com/codefuturist/email-mcp/pull/74) |

Ported from upstream: the [TLS servername repair](https://github.com/codefuturist/email-mcp/commit/70d4215de07920252f672923cf3cd48aad7a0189)
and [`config validate`](https://github.com/codefuturist/email-mcp/commit/bf09dcc1f087279812fe307647bf8e52198becd8).
Thanks also to everyone who filed the upstream issues listed above.

Adapted from [Mailoo](https://github.com/Bitfloo/mailoo) by Bitfloo (LGPL-3.0-or-later): the plain-text login guard, credential redaction in error text, and the tool catalog baseline test. See [NOTICE](NOTICE).

## License

[LGPL-3.0-or-later](LICENSE), the same license as upstream.
