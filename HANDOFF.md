# Handoff: IMAP Wizard feature work

This document is for a cloud model picking up the remaining feature work.
Read AGENTS.md and README.md first for conventions and project context.

## Current state

- Fork of codefuturist/email-mcp at `7fe8916` (2026-08-21 fork point).
- 96 commits past fork point (latest: `356d02a` feat(secrets): cross-platform keychain via secret-tool on Linux).
- 430 tests, all green. Typecheck and build clean.
- Published to `Fe2-O3/email-mcp` main branch.
- Version line: v0.1.0 (2026-09-28). No version bump since.

## What is already done (do not redo)

- 17 upstream issues closed (see README comparison table): #12, #20/#92, #45, #52, #55, #57, #58, #59, #60, #62, #66/#95, #71/#91, #79, #96
- 13 security controls (SSRF, header injection, constant-time token, OAuth HTTPS, HTTP bearer token on loopback, 10MB body cap, owner-only config, etc.)
- Orphan process fix: EOF primary signal + optional idle exit (default 0)
- GBNF-safe schemas, date ordering, chunked UID fetches, SQLite mirror, keychain, password_command, HTTP transport, config validate
- Scheduler, watcher with IDLE/triage/alerts, provider-aware labels, connection rotation
- Cross-platform keychain (macOS security + Linux secret-tool)
- 430 tests including lifecycle (stdin close + idle exit)

## What is missing (implement these)

### 1. Per-provider outbound attachment size limits (small)

**What:** Upstream added per-provider and per-account outbound attachment size limits. Our code hardcodes 25MB in `imap.service.ts` (`maxTotalBytes = 25 * 1024 * 1024`).

**Where:** `src/services/imap.service.ts` lines 1726, 1808. Config schema in `src/config/schema.ts`. Loader in `src/config/loader.ts`.

**How:** Add `max_attachment_size_mb` to settings schema (default 25). Thread through to send/attachment code. Use account-level override if present, fall back to global setting.

**Tests:** Add to imap.service tests for size enforcement.

### 2. Verification code catcher (opt-in, privacy-sensitive)

**What:** Upstream feature: scans recent mail for OTPs and magic links, extracts them, optionally copies to clipboard, exposes `get_verification_code` MCP tool. Upstream ships it ON by default with auto-copy. We must ship it OFF by default with no auto-copy and no clipboard read unless explicitly enabled.

**Upstream commits:** `f9c8434`, `06cd81e2`, `2d5b862`, `fdf8b7d`, `20e2da8`, `0f3f04f`, `dd251f7`, `6cd81e2`. 12 commits total.

**New files needed:**
- `src/services/verification.service.ts` — OTP extraction, magic link detection, clipboard integration
- `src/services/clipboard.service.ts` — pbcopy/pbpaste (macOS), xclip (Linux)
- `src/tools/verification.tool.ts` — `get_verification_code`, `check_clipboard_setup` MCP tools
- Tests for extraction patterns and clipboard safety

**Config schema additions:**
```typescript
verification: {
  enabled: z.boolean().default(false),
  auto_copy: z.boolean().default(false),
  confirm_copy: z.boolean().default(true),
  scan_window_minutes: z.number().int().min(1).default(5),
}
```

**Security requirements:**
- Default off
- No clipboard read unless `confirm_copy` is true and user confirms
- No clipboard write unless `auto_copy` is true
- Clipboard access must be documented as a privacy consideration
- Add to SECURITY.md

**Integration:** Register tools in `src/tools/register.ts`. Start service in `src/app.ts` only if enabled. Add to README comparison table.

### 3. Body-tier cache (biggest feature, highest value)

**What:** Upstream's v0.6.0 cache overhaul: read-through `get_email` with write-back persistence, bounded backfill, cached search and thread assembly, content-addressed attachment store with read-through downloads, LRU eviction with size budget, schema v3 (flag columns, stable email id, references, body tier plumbing, attachment index, sync window).

**Upstream commits:** `d22d4f4`, `5012971`, `8d8111b`, `3ce4dc1`, `358901e`, `3e5f921`, `0a745e0`, `5ffc8ff`, `e78e832`, `0f037ec`.

**Our current cache:** `src/cache/store.ts` — simple SQLite mirror with `window_days` and `max_size_mb`. Reads go through IMAP then cache. No body tier, no read-through, no thread assembly, no attachment store.

**Scope:** This is the largest change. It touches:
- `src/cache/store.ts` — schema v3, body tier, attachment store, LRU
- `src/cache/` — new modules for backfill, thread assembly, attachment store
- `src/services/imap.service.ts` — read-through integration
- `src/tools/emails.tool.ts` — cached reads
- `src/tools/threads.tool.ts` — thread assembly from cache
- `src/config/schema.ts` — new cache settings
- Tests throughout

**Recommendation:** Do a focused diff of upstream's cache changes against our `src/cache/` before implementing. The upstream implementation is agent-generated and may have quality issues worth reviewing.

**Risk:** High. Cache bugs cause stale data. Must have integration tests.

### 4. CLI read and compose (separate product)

**What:** Upstream added a full CLI email client: list, read, search, mailboxes, flag, delete, attach, reply, send, open (jump to mail client), logs (tail/follow/level/grep), notify (test desktop notifications).

**Upstream commits:** `6d0c105`, `e7a9dd4`, `06fb84c`, `00bd34a`, `0fa5628`, `687f7d2`.

**New files needed:** `src/cli/mail-commands.ts` or extend `src/cli/*.ts`. New commands in `src/main.ts` dispatch.

**Recommendation:** Low priority. Our fork is an MCP server, not a CLI email client. Only add if users request it.

### 5. Daemon and systemd service (opt-in)

**What:** Upstream added `server` lifecycle commands: `start`, `stop`, `status`, `install` (launchd/systemd), `uninstall`. Cross-platform daemon.

**Upstream commits:** `755eb39`, `98bc426`, `a3d4013`.

**Conflict:** We deliberately avoided always-on daemons because they create orphan and supervisor risk. Our stdio EOF exit is the primary lifecycle signal.

**Recommendation:** Skip. If users want a daemon, upstream provides it. Our fork's value is "no daemon, clean exit."

### 6. Per-provider outbound attachment size limits

**What:** Upstream added per-provider and per-account outbound attachment size limits. Our code hardcodes 25MB.

**Where:** `src/services/imap.service.ts` lines 1726, 1808. Config in `src/config/schema.ts`.

**How:** Add `max_attachment_size_mb` to settings (default 25). Thread through to send/attachment code. Use account-level override if present.

**Size:** Small. Doable in one session.

### 7. OAuth IDLE live token refresh during long sessions

**What:** Our watcher gets a fresh token on connect, but long IDLE sessions can outlive the token. Need periodic refresh or reconnect on token expiry.

**Where:** `src/services/watcher.service.ts`, `src/services/oauth.service.ts`.

**Status:** Partially exists. `getAccessToken` refreshes if expired, but only checked at connect time. Need to either check token expiry before each IDLE cycle or set a timer.

**Size:** Small to medium.

## Architecture notes

- Entry point: `src/main.ts` dispatches commands (stdio, http, account, config, keychain, scheduler, test, setup)
- App wiring: `src/app.ts` — `buildServer()`, `buildServices()`, `startBackgroundServices()`
- Config: `src/config/schema.ts` (Zod), `src/config/loader.ts` (TOML + env)
- Services: `src/services/` — imap, smtp, watcher, oauth, cache, hooks, scheduler, calendar, etc.
- Tools: `src/tools/` — MCP tool registration (49 tools)
- Cache: `src/cache/store.ts` — SQLite mirror
- Security: `src/security/` — keychain, password_command

## Conventions

- TypeScript 7.x, Node 24+, ESM
- Biome for lint/format
- Vitest for tests (430 tests, 55 files)
- Conventional commits via lefthook pre-commit (biome + typecheck)
- Pre-push hook runs full test suite + pnpm check
- Path-scoped commits, no `git add -A`
- Push flow: `gh auth switch --user Fe2-O3`, `git push fork repair/sdk-v2:main`
- Two agents share the checkout; stage only own paths

## Recommended implementation order

1. Per-provider attachment size limits (small, security-relevant)
2. OAuth IDLE token refresh during long sessions (bug fix)
3. Verification code catcher as opt-in (medium, privacy-sensitive)
4. Body-tier cache (large, high value, needs focused diff first)
5. CLI read and compose (low priority, separate product)
6. Daemon/systemd (skip unless users request)

## Files most likely to change

| Feature | Primary files |
|---|---|
| Attachment size limits | `src/config/schema.ts`, `src/config/loader.ts`, `src/services/imap.service.ts`, `src/tools/emails.tool.ts` |
| Verification catcher | New: `src/services/verification.service.ts`, `src/services/clipboard.service.ts`, `src/tools/verification.tool.ts`. Modify: `src/tools/register.ts`, `src/app.ts`, `src/config/schema.ts` |
| Body-tier cache | `src/cache/store.ts`, new cache modules, `src/services/imap.service.ts`, `src/tools/emails.tool.ts`, `src/tools/threads.tool.ts` |
| CLI read/compose | New: `src/cli/mail-commands.ts`. Modify: `src/main.ts` |
| OAuth IDLE refresh | `src/services/watcher.service.ts`, `src/services/oauth.service.ts` |

## Testing approach

- Each feature needs unit tests in `src/services/*.test.ts` and `src/tools/*.test.ts`
- Integration tests in `src/__integration__/` for features touching IMAP
- Lifecycle tests in `src/main.lifecycle.test.ts` for process-level changes
- Run `pnpm typecheck && pnpm test` before committing
- Pre-push hook enforces full suite

## Upstream reference

- Upstream repo: `codefuturist/email-mcp`
- Fork point: `7fe8916` (2026-08-21)
- Latest upstream: `v0.6.0` (2026-10-10), develop at `f9f0365` (2026-11-07)
- Upstream commit SHAs for each feature are listed in the README version history and CHANGELOG
- Fetch upstream: `git fetch https://github.com/codefuturist/email-mcp.git develop`

## Important context

- The email MCP server instructions are no longer available in this environment (removed Nov 12, 2026). The server itself still works; only the tool descriptions are gone from the harness.
- Two agents share this checkout. Stage only own paths. `package.json` has an uncommitted change from another session — do not stage it.
- The user's config is at `~/.config/email-mcp/config.toml` with `idle_exit = 0`.
- The user's git identity was fixed: `208582076+Fe2-O3@users.noreply.github.com` (global config). Future commits credit Fe2-O3.
- Historical 94 commits are attributed to UnhandledPage (old account ID 33189015). This cannot be changed without force-pushing.
