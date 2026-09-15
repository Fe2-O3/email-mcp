# Email MCP Server (imap-wizard)

[![license](https://img.shields.io/github/license/Fe2-O3/email-mcp.svg?style=flat-square)](LICENSE)
[![npm version](https://img.shields.io/npm/v/@codefuturist/email-mcp.svg?style=flat-square)](https://www.npmjs.com/package/@codefuturist/email-mcp)

A hardened fork of [codefuturist/email-mcp](https://github.com/codefuturist/email-mcp) with 50+ bug fixes, security hardening, and new features on top of the upstream `modernize/sdk-v2-2026-07-28` branch.

Built on **MCP TypeScript SDK v2** (spec revision 2026-07-28). Serves over **stdio** for local clients or **Streamable HTTP** for networked access.

> **Upstream status:** The original maintainer has not merged any PRs since May 2026.
> This fork ships the fixes that are sitting in the upstream issue and PR backlog,
> plus additional hardening and features.

## What's Different

This fork fixes **20+ open upstream issues** and adds security, reliability, and feature improvements that are not in the published npm package.

### Bugs Fixed

| Upstream Issue | Fix | Commit |
|---|---|---|
| [#12](https://github.com/codefuturist/email-mcp/issues/12) `download_attachment` returns base64, no disk save | Added `savePath` parameter — writes file to disk, returns path + size + sha256 | `e3dae2b` |
| [#20](https://github.com/codefuturist/email-mcp/issues/20), [#54](https://github.com/codefuturist/email-mcp/issues/54), [#92](https://github.com/codefuturist/email-mcp/issues/92) Sent mail never saved to Sent folder | Files sent messages into Sent via IMAP APPEND after SMTP send | `2759a5f`, `093de64` |
| [#45](https://github.com/codefuturist/email-mcp/issues/45) `forward_email` ignores html flag | Honours the html flag on forward_email | `105f52f` |
| [#52](https://github.com/codefuturist/email-mcp/issues/52) send_email / send_draft do not support attachments | Attachments on forward, send, and draft paths | `50da135` |
| [#57](https://github.com/codefuturist/email-mcp/issues/57) Unhandled error event crashes process on socket timeout | Attach error/close handlers to every ImapFlow client | `1b145eb` |
| [#58](https://github.com/codefuturist/email-mcp/issues/58) Every tool call fails on llama.cpp models | Drop lookahead regex from recipient validation (GBNF-safe schemas) | `0d731f6` |
| [#59](https://github.com/codefuturist/email-mcp/issues/59) Ordering by UID instead of date | Order list_emails and search_emails by date across the whole match set | `a8c55f0` |
| [#60](https://github.com/codefuturist/email-mcp/issues/60) stdio server never exits when client closes stdin (orphaned processes) | Exit stdio server when the client closes stdin | `552d016` |
| [#62](https://github.com/codefuturist/email-mcp/issues/62) send_email retried call indistinguishable from new email | Make retried sends identifiable and refuse accidental duplicates | `ae6afa2` |
| [#66](https://github.com/codefuturist/email-mcp/issues/66), [#95](https://github.com/codefuturist/email-mcp/issues/95) get_email returns raw MIME / misses real body | Decode message bodies; fetch both halves of multipart/alternative and prefer the richer text | `439a1e5`, `3149e51` |
| [#71](https://github.com/codefuturist/email-mcp/issues/71), [#91](https://github.com/codefuturist/email-mcp/issues/91) Search returns zero results on broken IMAP4rev2 (Strato) | Fail loudly when a server's SEARCH answers with garbage | `1927a74` |
| [#96](https://github.com/codefuturist/email-mcp/issues/96) Non-ASCII characters in save_draft subject not RFC 2047 encoded | Build drafts via MailComposer to encode headers and body | `71b10df` |
| [#79](https://github.com/codefuturist/email-mcp/issues/79) read_only does not gate background services | Keep calendar writes behind readOnly gate | `f05f7ab` |
| [#81](https://github.com/codefuturist/email-mcp/issues/81) SIEVE filter editing | Not addressed (feature request) | — |
| [#10](https://github.com/codefuturist/email-mcp/issues/10) messageId missing from emailMetaSchema | Add messageId to schema to fix list_emails / search_emails rejection | `e3dae2b` |

### Security Hardening

| Area | What Changed | Commit |
|---|---|---|
| Header injection | Encode sender name via address object to prevent SMTP header injection | `7455f40` |
| Token timing attacks | Constant-time token compare via hash to hide length | `e936590` |
| OAuth token misuse | Never use password as OAuth access token in watcher | `edd640b` |
| Private IP SSRF | Block 169.254, CGNAT and other private ranges via webhook guard | `77f2aaa` |
| OAuth endpoint | Enforce HTTPS for OAuth endpoints | `519a305` |
| Scheduler security | Validate emails, UUID schedule_id, secure file perms | `3344c5d` |
| Config permissions | Write credentials readable only by their owner | `881f52c` |
| Webhook dispatch | Pin webhook dispatch to the validated address; resolve and range-check destinations | `d901ba3`, `044b4c7` |
| HTTP security | Require a token even on loopback; bound request bodies | `c8695bc`, `d5f3165` |
| Draft headers | Sanitize draft headers and harden remaining services | `f993dc5` |

### New Features

| Feature | Description | Commit |
|---|---|---|
| **MCP SDK v2** | Migrated to MCP TypeScript SDK v2 (spec revision 2026-07-28) with structured output | `a309a67` |
| **Streamable HTTP** | Networked transport mode alongside stdio | `9a04f65` |
| **Offline cache** | Local mirror for offline-capable email access | `29106e8` |
| **Sender authentication** | Expose DMARC/SPF/DKIM signals via `get_email_security` | `f09e06e` |
| **Attachment savePath** | Save attachments to disk instead of flooding base64 into context | `e3dae2b` |
| **Sent folder filing** | IMAP APPEND after send, reply, forward, and draft send | `2759a5f`, `093de64` |
| **Attachment support** | Carry attachments on forward, send, and draft paths | `50da135` |
| **Duplicate send guard** | Make retried sends identifiable and refuse accidental duplicates | `ae6afa2` |
| **Reply-To awareness** | Reply goes to Reply-To header when present | `52aa1dd` |
| **Bcc handling** | Send Bcc recipients when sending a saved draft | `1515fa0` |
| **Quota display** | Report quota in MB not KB | `e4ae358` |
| **Calendar fixes** | Fail closed on duplicate check; escape JSON in AppleScript; media type filtering | `ed8c442`, `d59ce82`, `6919aa1` |

## Install

Requires Node.js >= 22.

```bash
# From this fork (local checkout)
cd imap-wizard && pnpm install && pnpm build

# Or run directly
node dist/main.js setup
```

### Configure Your MCP Client

**Claude Desktop** — edit `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["/path/to/imap-wizard/dist/main.js", "stdio"]
    }
  }
}
```

**Claude Code:**

```bash
claude mcp add email -- node /path/to/imap-wizard/dist/main.js stdio
```

**Cursor** — edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "email": {
      "command": "node",
      "args": ["/path/to/imap-wizard/dist/main.js", "stdio"]
    }
  }
}
```

**VS Code (GitHub Copilot)** — add to `settings.json`:

```json
{
  "mcp": {
    "servers": {
      "email": {
        "type": "stdio",
        "command": "node",
        "args": ["/path/to/imap-wizard/dist/main.js", "stdio"]
      }
    }
  }
}
```

**Codex** — add to `~/.codex/config.toml`:

```toml
[mcp_servers.email]
command = "node"
args = ["/path/to/imap-wizard/dist/main.js", "stdio"]
```

**Streamable HTTP (networked):**

```bash
node dist/main.js http --port 8080
```

## Usage

### Setup

```bash
# Add an email account interactively
node dist/main.js account add

# Test connections
node dist/main.js test            # all accounts
node dist/main.js test personal   # specific account
```

### Configuration

Located at `~/.config/email-mcp/config.toml`:

```toml
[settings]
rate_limit = 10  # max emails per minute per account

[[accounts]]
name = "personal"
email = "you@gmail.com"
full_name = "Your Name"
password = "use_keychain:personal"  # or plain text

[accounts.imap]
host = "imap.gmail.com"
port = 993
tls = true

[accounts.smtp]
host = "smtp.gmail.com"
port = 465
tls = true
```

### Keychain Support

Passwords are stored in macOS Keychain using sentinel values:

```toml
password = "use_keychain:my-account-name"
```

```bash
node dist/main.js keychain status    # show which accounts use keychain
node dist/main.js keychain migrate   # move all passwords to keychain
```

### CLI Commands

```
node dist/main.js [command]

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

## API

### Tools (49)

#### Read (14)

| Tool | Description |
|------|-------------|
| `list_accounts` | List all configured email accounts |
| `list_mailboxes` | List folders with unread counts and special-use flags |
| `list_emails` | Paginated email listing with date, sender, subject, and flag filters |
| `get_email` | Read full email content with attachment metadata |
| `get_emails` | Fetch full content of multiple emails in a single call (max 20) |
| `get_email_status` | Get read/flag/label state without fetching the body |
| `search_emails` | Search by keyword across subject, sender, and body |
| `download_attachment` | Download attachment by filename, optionally save to disk with `savePath` |
| `find_email_folder` | Discover the real folder(s) an email resides in |
| `extract_contacts` | Extract unique contacts from recent email headers |
| `get_thread` | Reconstruct a conversation thread via References/In-Reply-To |
| `list_templates` | List available email templates |
| `get_email_stats` | Email analytics — volume, top senders, daily trends |
| `check_health` | Connection health, latency, quota, and IMAP capabilities |

#### Write (9)

| Tool | Description |
|------|-------------|
| `send_email` | Send a new email (plain text or HTML, CC/BCC, attachments) |
| `reply_email` | Reply with proper threading (In-Reply-To, References) |
| `forward_email` | Forward with original content quoted (respects html flag) |
| `save_draft` | Save an email draft to the Drafts folder |
| `send_draft` | Send an existing draft and remove from Drafts |
| `apply_template` | Apply a template with variable substitution |
| `schedule_email` | Schedule an email for future delivery |
| `list_scheduled` | List scheduled emails by status |
| `cancel_scheduled` | Cancel a pending scheduled email |

#### Manage (7)

| Tool | Description |
|------|-------------|
| `move_email` | Move email between folders |
| `delete_email` | Move to Trash or permanently delete |
| `mark_email` | Mark as read/unread, flag/unflag |
| `bulk_action` | Batch operation on up to 100 emails |
| `create_mailbox` | Create a new mailbox folder |
| `rename_mailbox` | Rename an existing mailbox folder |
| `delete_mailbox` | Permanently delete a mailbox and contents |

#### Labels (5)

| Tool | Description |
|------|-------------|
| `list_labels` | Discover available labels (auto-detects provider strategy) |
| `add_label` | Add a label to an email |
| `remove_label` | Remove a label from an email |
| `create_label` | Create a new label |
| `delete_label` | Delete a label |

#### Watcher & Alerts (6)

| Tool | Description |
|------|-------------|
| `get_watcher_status` | Show IMAP IDLE connections, monitored folders, last-seen UIDs |
| `list_presets` | List available AI triage presets |
| `get_hooks_config` | Show current hooks configuration |
| `configure_alerts` | Update alert/notification settings at runtime |
| `check_notification_setup` | Diagnose desktop notification support |
| `test_notification` | Send a test notification |

#### Calendar & Reminders (6)

| Tool | Description |
|------|-------------|
| `extract_calendar` | Extract ICS/iCalendar events from an email |
| `analyze_email_for_scheduling` | Detect events and reminder-worthy content |
| `add_to_calendar` | Add an email event to the local calendar |
| `create_reminder` | Create a reminder from an email |
| `list_calendars` | List all available local calendars |
| `check_calendar_permissions` | Check whether the local calendar is accessible |

#### Security (1)

| Tool | Description |
|------|-------------|
| `get_email_security` | Expose DMARC/SPF/DKIM sender authentication signals |

### Prompts (7)

| Prompt | Description |
|--------|-------------|
| `triage_inbox` | Categorize and prioritize unread emails |
| `summarize_thread` | Summarize a conversation thread |
| `compose_reply` | Draft a context-aware reply |
| `draft_from_context` | Compose from provided context |
| `extract_action_items` | Extract actionable tasks |
| `summarize_meetings` | Summarize calendar events from emails |
| `cleanup_inbox` | Suggest emails to archive, delete, or unsubscribe |

### Resources (6)

| Resource | URI | Description |
|----------|-----|-------------|
| Accounts | `email://accounts` | Configured accounts |
| Mailboxes | `email://{account}/mailboxes` | Folder tree |
| Unread | `email://{account}/unread` | Unread summary |
| Templates | `email://templates` | Email templates |
| Stats | `email://{account}/stats` | Statistics snapshot |
| Scheduled | `email://scheduled` | Pending scheduled emails |

## Architecture

```
src/
├── main.ts                — Entry point and subcommand routing
├── server.ts              — MCP server factory
├── logging.ts             — MCP protocol logging bridge
├── app.ts                 — Streamable HTTP server
├── cli/                   — Interactive CLI commands
│   ├── account-commands.ts — Account CRUD with Keychain support
│   ├── keychain-commands.ts — Keychain status/migrate/remove
│   ├── http.ts            — Streamable HTTP server
│   └── scheduler.ts       — Scheduler CLI
├── config/                — Configuration layer
│   ├── xdg.ts             — XDG Base Directory paths
│   ├── schema.ts          — Zod validation schemas
│   └── loader.ts          — Config loader with Keychain resolution
├── connections/
│   └── manager.ts         — Lazy persistent IMAP/SMTP with OAuth2
├── services/              — Business logic
│   ├── imap.service.ts    — IMAP operations (with date ordering, multipart fix)
│   ├── smtp.service.ts    — SMTP operations (with sent folder filing, dedup)
│   ├── watcher.service.ts — IMAP IDLE watcher
│   ├── hooks.service.ts   — AI triage + static rules
│   ├── scheduler.service.ts — Email scheduling
│   ├── cache/             — Offline-capable local mirror
│   └── ...
├── security/
│   └── keychain.ts        — macOS Keychain wrapper
├── safety/                — Audit trail, rate limiter, webhook guard
├── tools/                 — MCP tool definitions (49)
├── prompts/               — MCP prompt definitions (7)
├── resources/             — MCP resource definitions (6)
└── types/                 — Shared TypeScript types
```

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

## Acknowledgments

This fork is built on top of the excellent work by [@codefuturist](https://github.com/codefuturist) on [email-mcp](https://github.com/codefuturist/email-mcp). The upstream project provides a comprehensive MCP email server with 49 tools, 7 prompts, and 6 resources.


## License

[LGPL-3.0-or-later](LICENSE)
