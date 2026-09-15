# Email MCP Server

> The email server your AI assistant actually needs. Fixed, hardened, and shipped.

[![License: LGPL v3](https://img.shields.io/badge/License-LGPL%20v3-blue.svg?style=flat-square)](LICENSE)
[![MCP SDK v2](https://img.shields.io/badge/MCP-SDK%20v2-8B5CF6?style=flat-square)](https://modelcontextprotocol.io)
[![Node.js 22+](https://img.shields.io/badge/Node.js-22+-339933?style=flat-square&logo=node.js&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://typescriptlang.org)

A hardened fork of [codefuturist/email-mcp](https://github.com/codefuturist/email-mcp) with **75 commits** of fixes, security hardening, and new features. Built on **MCP TypeScript SDK v2** (spec revision 2026-07-28).

**49 tools. 7 prompts. 6 resources. One server.**

---

## Why This Fork?

The upstream email-mcp is a great project with a comprehensive feature set. But it has **30+ open issues**, unmerged PRs since May 2026, and several critical bugs that break real-world usage. This fork fixes them all.

| | Upstream | This Fork |
|---|:---:|:---:|
| **Sent mail saved** | ❌ Never | ✅ IMAP APPEND |
| **Attachments on send** | ❌ | ✅ Forward, send, draft |
| **Save to disk** | ❌ Base64 only | ✅ `savePath` param |
| **llama.cpp compatible** | ❌ Schema crashes | ✅ GBNF-safe |
| **Date ordering** | ❌ UID-based | ✅ Sort by date |
| **Multipart bodies** | ❌ Raw MIME | ✅ Decoded, richer text |
| **Stdio orphan fix** | ❌ 232 processes | ✅ Clean exit |
| **Duplicate send guard** | ❌ | ✅ Identifiable retries |
| **Memory leak (6 days)** | ❌ OOM crash | ✅ Connection rotation |
| **Private IP SSRF** | ❌ | ✅ Blocked |
| **Keychain support** | ❌ Plain text | ✅ macOS Keychain |

**75 commits ahead of upstream. Every open bug issue resolved.**

---

## Quick Start

### 1. Build

```bash
git clone https://github.com/Fe2-O3/imap-wizard.git
cd imap-wizard
pnpm install && pnpm build
```

### 2. Add an account

```bash
node dist/main.js account add
```

The wizard auto-detects your email provider (Gmail, Outlook, Yahoo, iCloud, Hostinger, Fastmail, ProtonMail, Zoho, GMX) and configures IMAP/SMTP settings.

### 3. Test

```bash
node dist/main.js test
```

### 4. Connect your AI client

<details>
<summary><strong>Claude Desktop</strong></summary>

Edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

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
<summary><strong>Claude Code</strong></summary>

```bash
claude mcp add email -- node /absolute/path/to/imap-wizard/dist/main.js stdio
```
</details>

<details>
<summary><strong>Cursor</strong></summary>

Edit `~/.cursor/mcp.json`:

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

Add to `settings.json`:

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
<summary><strong>Codex</strong></summary>

Add to `~/.codex/config.toml`:

```toml
[mcp_servers.email]
command = "node"
args = ["/absolute/path/to/imap-wizard/dist/main.js", "stdio"]
```
</details>

<details>
<summary><strong>Streamable HTTP (networked)</strong></summary>

```bash
node dist/main.js http --port 8080
```

Then configure your client:

```json
{
  "mcpServers": {
    "email": {
      "type": "streamable-http",
      "url": "http://127.0.0.1:8080/mcp"
    }
  }
}
```
</details>

---

## What's Fixed

Every fix links to the upstream issue it resolves.

### Critical Bugs

| Issue | Problem | Fix |
|---|---|---|
| [#12](https://github.com/codefuturist/email-mcp/issues/12) | `download_attachment` returns base64, no disk save | Added `savePath` parameter — writes file to disk, returns path + size + sha256 |
| [#20](https://github.com/codefuturist/email-mcp/issues/20) [#54](https://github.com/codefuturist/email-mcp/issues/54) [#92](https://github.com/codefuturist/email-mcp/issues/92) | Sent mail never saved to Sent folder | Files sent messages into Sent via IMAP APPEND after SMTP send |
| [#45](https://github.com/codefuturist/email-mcp/issues/45) | `forward_email` ignores html flag | Honours the html flag on forward_email |
| [#52](https://github.com/codefuturist/email-mcp/issues/52) | send_email / send_draft do not support attachments | Attachments on forward, send, and draft paths |
| [#57](https://github.com/codefuturist/email-mcp/issues/57) | Unhandled error event crashes process on socket timeout | Attach error/close handlers to every ImapFlow client |
| [#58](https://github.com/codefuturist/email-mcp/issues/58) | Every tool call fails on llama.cpp models | Drop lookahead regex from recipient validation (GBNF-safe schemas) |
| [#59](https://github.com/codefuturist/email-mcp/issues/59) | Ordering by UID instead of date | Order list_emails and search_emails by date across the whole match set |
| [#60](https://github.com/codefuturist/email-mcp/issues/60) | stdio server never exits when client closes stdin (232 orphaned processes) | Exit stdio server when the client closes stdin |
| [#62](https://github.com/codefuturist/email-mcp/issues/62) | send_email retried call indistinguishable from new email | Make retried sends identifiable and refuse accidental duplicates |
| [#66](https://github.com/codefuturist/email-mcp/issues/66) [#95](https://github.com/codefuturist/email-mcp/issues/95) | get_email returns raw MIME / misses real body | Decode message bodies; fetch both halves of multipart/alternative and prefer the richer text |
| [#71](https://github.com/codefuturist/email-mcp/issues/71) [#91](https://github.com/codefuturist/email-mcp/issues/91) | Search returns zero results on broken IMAP4rev2 (Strato) | Fail loudly when a server's SEARCH answers with garbage |
| [#96](https://github.com/codefuturist/email-mcp/issues/96) | Non-ASCII characters in save_draft subject not RFC 2047 encoded | Build drafts via MailComposer to encode headers and body |
| [#79](https://github.com/codefuturist/email-mcp/issues/79) | read_only does not gate background services | Keep calendar writes behind readOnly gate |
| [#55](https://github.com/codefuturist/email-mcp/issues/55) | Memory leak in long-running process (OOM after 6 days) | Connection rotation (30min) + cache eviction (5min TTL) |

### Security Hardening

| Area | What Changed |
|---|---|
| **Header injection** | Encode sender name via address object to prevent SMTP header injection |
| **Timing attacks** | Constant-time token compare via hash to hide length |
| **OAuth token misuse** | Never use password as OAuth access token in watcher |
| **Private IP SSRF** | Block 169.254, CGNAT and other private ranges via webhook guard |
| **OAuth endpoint** | Enforce HTTPS for OAuth endpoints |
| **Scheduler security** | Validate emails, UUID schedule_id, secure file perms |
| **Config permissions** | Write credentials readable only by their owner |
| **Webhook dispatch** | Pin webhook dispatch to validated address; resolve and range-check destinations |
| **HTTP security** | Require a token even on loopback; bound request bodies |
| **Draft headers** | Sanitize draft headers and harden remaining services |
| **Security reporting** | Private vulnerability reporting enabled via GitHub Security Advisories |

### New Features

| Feature | Description |
|---|---|
| **MCP SDK v2** | Migrated to MCP TypeScript SDK v2 (spec revision 2026-07-28) with structured output |
| **Streamable HTTP** | Networked transport mode alongside stdio |
| **Offline cache** | Local SQLite mirror for offline-capable email access |
| **Sender authentication** | Expose DMARC/SPF/DKIM signals via `get_email_security` |
| **Attachment savePath** | Save attachments to disk instead of flooding base64 into context |
| **Sent folder filing** | IMAP APPEND after send, reply, forward, and draft send |
| **Attachment support** | Carry attachments on forward, send, and draft paths |
| **Duplicate send guard** | Make retried sends identifiable and refuse accidental duplicates |
| **Reply-To awareness** | Reply goes to Reply-To header when present |
| **Bcc handling** | Send Bcc recipients when sending a saved draft |
| **Quota display** | Report quota in MB not KB |
| **Connection rotation** | IMAP connections rotate every 30 minutes to prevent buffer accumulation |
| **Cache eviction** | Label strategy caches evicted after 5 minutes to prevent unbounded growth |
| **password_command** | Resolve passwords via external command (1Password, Bitwarden, pass, Keychain) |
| **Stats resource fix** | Use STATUS + SEARCH instead of full envelope fetch for cheap mailbox counters |
| **find_email_folder perf** | Search likely folders first (INBOX, Sent, Drafts) and stop at first match |

---

## Features

### 49 Tools

| Category | Tools |
|---|---|
| **Read (14)** | `list_accounts` `list_mailboxes` `list_emails` `get_email` `get_emails` `get_email_status` `search_emails` `download_attachment` `find_email_folder` `extract_contacts` `get_thread` `list_templates` `get_email_stats` `check_health` |
| **Write (9)** | `send_email` `reply_email` `forward_email` `save_draft` `send_draft` `apply_template` `schedule_email` `list_scheduled` `cancel_scheduled` |
| **Manage (7)** | `move_email` `delete_email` `mark_email` `bulk_action` `create_mailbox` `rename_mailbox` `delete_mailbox` |
| **Labels (5)** | `list_labels` `add_label` `remove_label` `create_label` `delete_label` |
| **Watcher (6)** | `get_watcher_status` `list_presets` `get_hooks_config` `configure_alerts` `check_notification_setup` `test_notification` |
| **Calendar (6)** | `extract_calendar` `analyze_email_for_scheduling` `add_to_calendar` `create_reminder` `list_calendars` `check_calendar_permissions` |
| **Security (1)** | `get_email_security` |

### 7 Prompts

`triage_inbox` `summarize_thread` `compose_reply` `draft_from_context` `extract_action_items` `summarize_meetings` `cleanup_inbox`

### 6 Resources

| URI | Description |
|---|---|
| `email://accounts` | Configured accounts |
| `email://{account}/mailboxes` | Folder tree |
| `email://{account}/unread` | Unread summary |
| `email://templates` | Email templates |
| `email://{account}/stats` | Statistics snapshot |
| `email://scheduled` | Pending scheduled emails |

---

## Configuration

### Accounts

Located at `~/.config/email-mcp/config.toml`:

```toml
[settings]
rate_limit = 10  # max emails per minute per account

[[accounts]]
name = "personal"
email = "you@gmail.com"
full_name = "Your Name"
password = "use_keychain:personal"  # macOS Keychain

[accounts.imap]
host = "imap.gmail.com"
port = 993
tls = true

[accounts.smtp]
host = "smtp.gmail.com"
port = 465
tls = true
```

### Password Command

Instead of storing passwords in plaintext, resolve them from an external command at startup:

```toml
[[accounts]]
name = "personal"
email = "you@gmail.com"

# macOS Keychain
password_command = "security find-generic-password -s email-mcp-personal -w"

# Bitwarden CLI
# password_command = "bw get password personal-email"

# 1Password CLI
# password_command = "op read 'op://Private/personal-email/password'"

# pass (Unix password manager)
# password_command = "pass show email/personal"
```

- The command runs once at startup via `/bin/sh -c`, in parallel across accounts
- Your vault must already be unlocked (no interactive prompts)
- The command is killed after 10 seconds
- Password must go to stdout; anything on stderr may appear in error messages
- If both `password` and `password_command` are set, `password_command` wins
- Rotating the password requires restarting the server

### macOS Keychain

Passwords are stored in macOS Keychain using sentinel values:

```toml
password = "use_keychain:my-account-name"
```

```bash
node dist/main.js keychain status    # show which accounts use keychain
node dist/main.js keychain migrate   # move all passwords to keychain
```

### Provider Auto-Detection

| Provider | Domains |
|---|---|
| Gmail | gmail.com |
| Outlook / Hotmail | outlook.com, hotmail.com, live.com |
| Yahoo Mail | yahoo.com, ymail.com |
| iCloud | icloud.com, me.com, mac.com |
| Fastmail | fastmail.com |
| ProtonMail Bridge | proton.me, protonmail.com |
| Zoho Mail | zoho.com |
| GMX | gmx.com, gmx.de, gmx.net |

---

## CLI

```
email-mcp [command]

Commands:
  stdio                     Run as MCP server over stdio (default)
  http                      Run as MCP server over Streamable HTTP
  account list              List all configured accounts
  account add               Add a new email account interactively
  account edit [name]       Edit an existing account
  account delete [name]     Remove an account
  test                      Test connections for all or a specific account
  install                   Register with MCP clients interactively
  install status            Show registration status
  install remove            Unregister from MCP clients
  config show               Show config (passwords masked)
  config edit               Edit global settings
  config path               Print config file path
  config init               Create template config
  keychain status           Show keychain migration status
  keychain migrate          Move all passwords to macOS Keychain
  keychain remove [name]    Remove a password from Keychain
  scheduler check           Process pending scheduled emails
  scheduler list            Show all scheduled emails
  scheduler install         Install OS-level scheduler (launchd/crontab)
  scheduler uninstall       Remove OS-level scheduler
  scheduler status          Show scheduler installation status
  help                      Show help
```

---

## Architecture

```
src/
├── main.ts                — Entry point and subcommand routing
├── server.ts              — MCP server factory
├── logging.ts             — MCP protocol logging bridge
├── app.ts                 — Streamable HTTP server
├── cli/
│   ├── account-commands.ts — Account CRUD with Keychain support
│   ├── keychain-commands.ts — Keychain status/migrate/remove
│   ├── http.ts            — Streamable HTTP server
│   └── scheduler.ts       — Scheduler CLI
├── config/
│   ├── xdg.ts             — XDG Base Directory paths
│   ├── schema.ts          — Zod validation schemas
│   └── loader.ts          — Config loader with Keychain resolution
├── connections/
│   └── manager.ts         — Lazy persistent IMAP/SMTP with connection rotation
├── services/
│   ├── imap.service.ts    — IMAP operations (date ordering, multipart fix, cache eviction)
│   ├── smtp.service.ts    — SMTP operations (sent folder filing, dedup, attachments)
│   ├── watcher.service.ts — IMAP IDLE watcher with auto-reconnect
│   ├── hooks.service.ts   — AI triage + static rules
│   ├── scheduler.service.ts — Email scheduling
│   ├── cache/             — Offline-capable local SQLite mirror
│   └── ...
├── security/
│   └── keychain.ts        — macOS Keychain wrapper
├── safety/                — Audit trail, rate limiter, webhook guard
├── tools/                 — MCP tool definitions (49)
├── prompts/               — MCP prompt definitions (7)
├── resources/             — MCP resource definitions (6)
└── types/                 — Shared TypeScript types
```

---

## Development

```bash
pnpm install
pnpm typecheck   # type check
pnpm check       # lint and format
pnpm build       # build
```

### Testing

```bash
pnpm test              # unit tests
pnpm test:integration  # against a throwaway GreenMail server (Docker required)
pnpm smoke             # every MCP tool against a real configured account
```

---

## Security

See [SECURITY.md](SECURITY.md) for the full security policy and reporting instructions.

**Private vulnerability reporting is enabled.** Go to the Security tab → Report a vulnerability.

---

## Acknowledgments

Built on top of the excellent work by [@codefuturist](https://github.com/codefuturist) on [email-mcp](https://github.com/codefuturist/email-mcp). The upstream project provides a comprehensive MCP email server with 49 tools, 7 prompts, and 6 resources.

### Contributors Whose Work Was Incorporated

This fork incorporates fixes and features from the following upstream contributors. Thank you for your work.

| Contributor | What Was Incorporated |
|---|---|
| **[@rsilvestre](https://github.com/rsilvestre)** | [`password_command`](https://github.com/codefuturist/email-mcp/pull/82) (resolve passwords via external command), [stats resource fix](https://github.com/codefuturist/email-mcp/pull/93) (cheap mailbox counters), [`find_email_folder` perf](https://github.com/codefuturist/email-mcp/pull/94) (stop at first match, search likely folders first) |
| **[@b0j-an](https://github.com/b0j-an)** | [Attachment support on send](https://github.com/codefuturist/email-mcp/pull/77) (carry attachments on forward, send, and draft paths), [Sent folder copy](https://github.com/codefuturist/email-mcp/pull/78) (file sent messages after send/reply/forward) |
| **[@majkelooo](https://github.com/majkelooo)** | [Stdio exit fix](https://github.com/codefuturist/email-mcp/pull/61) (exit server when client closes stdin), [Sent folder filing](https://github.com/codefuturist/email-mcp/pull/80) (archive sent messages) |
| **[@Seger85](https://github.com/Seger85)** | [Sender authentication signals](https://github.com/codefuturist/email-mcp/pull/70) (DMARC/SPF/DKIM exposure), [IMAP error handling](https://github.com/codefuturist/email-mcp/pull/64) (safe error/close event handling), [HTTP session lifecycle](https://github.com/codefuturist/email-mcp/pull/63) (bound Streamable HTTP sessions) |
| **[@ElectricCookie](https://github.com/ElectricCookie)** | [Attachment download dir](https://github.com/codefuturist/email-mcp/pull/65) (save downloads to configured directory) |
| **[@Fe2-O3](https://github.com/Fe2-O3)** | [GBNF-safe schemas](https://github.com/codefuturist/email-mcp/pull/74) (remove lookahead regex that breaks llama.cpp) |
| **[@adi-singh13](https://github.com/adi-singh13)** | [AgentMail provider](https://github.com/codefuturist/email-mcp/pull/49) (alternative email provider — not incorporated, different protocol) |

### Issue Reporters

Thanks to everyone who filed issues that identified bugs fixed in this fork: [#12](https://github.com/codefuturist/email-mcp/issues/12), [#20](https://github.com/codefuturist/email-mcp/issues/20), [#45](https://github.com/codefuturist/email-mcp/issues/45), [#52](https://github.com/codefuturist/email-mcp/issues/52), [#55](https://github.com/codefuturist/email-mcp/issues/55), [#57](https://github.com/codefuturist/email-mcp/issues/57), [#58](https://github.com/codefuturist/email-mcp/issues/58), [#59](https://github.com/codefuturist/email-mcp/issues/59), [#60](https://github.com/codefuturist/email-mcp/issues/60), [#62](https://github.com/codefuturist/email-mcp/issues/62), [#66](https://github.com/codefuturist/email-mcp/issues/66), [#71](https://github.com/codefuturist/email-mcp/issues/71), [#79](https://github.com/codefuturist/email-mcp/issues/79), [#91](https://github.com/codefuturist/email-mcp/issues/91), [#92](https://github.com/codefuturist/email-mcp/issues/92), [#95](https://github.com/codefuturist/email-mcp/issues/95), [#96](https://github.com/codefuturist/email-mcp/issues/96).


---

## License

[LGPL-3.0-or-later](LICENSE)
