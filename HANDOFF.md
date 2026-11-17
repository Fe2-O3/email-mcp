# IMAP Wizard: remaining cache work

This handoff is for the next feature session. Read `README.md` and
`CONTRIBUTING.md` first. No repository `AGENTS.md` is present.

## Current state

- Fork of `codefuturist/email-mcp`, published at `Fe2-O3/email-mcp`.
- 49 MCP tools by default. `get_verification_code` adds one optional tool.
- Email CLI commands: `list`, `read`, `search`, `mailboxes`, `flag`, `delete`,
  `attach`, `reply`, and `send`.
- `get_verification_code` is off by default, on-demand only, and does not scan
  mail in the background. Magic-link lookup and clipboard writes are separate
  opt-ins. Clipboard is never read or cleared; writes are blocked in read-only
  mode.
- Outbound attachment sizes are checked against global and provider defaults,
  with a per-account override.
- Linux secure password storage uses `secret-tool`; macOS uses `security`.
- The stdio process exits on client stdin EOF. `idle_exit` defaults to `0`.
- Body-tier cache: specified in `CACHE-IMPLEMENTATION-PROMPT.md`. Daemon support
  is intentionally out of scope.

## What is already in the fork

- SQLite metadata mirror (`src/cache/store.ts`, `src/cache/sync-engine.ts`)
- Scheduler, watcher, triage hooks, provider-aware labels, OAuth, Streamable HTTP
- Attachment save paths, chunked large-mailbox fetches, connection rotation
- Security controls and fixes tracked in the README comparison table
- Cross-platform secure-store support
- Email CLI and on-demand verification lookup described above

Do not reimplement these. Check current source and tests before changing them.

## Body-tier cache

The body cache spec is in `CACHE-IMPLEMENTATION-PROMPT.md`, version 4. It
replaces the upstream-derived plan that was here. The per-message design caches
immutable bundles, and every hit re-checks existence and flags live with one
`UID FETCH (FLAGS)`. Search, thread, list-from-mirror, and attachment blobs
are deferred there, with the reasons. Run `scripts/bench-get-email.ts` (G0)
before turning `read_through` on.

## Intentionally skipped

- **Daemon / systemd / launchd service:** upstream has this, but it conflicts
  with this fork's preference that stdio servers stop when clients close.
  Existing `http` mode can be started manually when a persistent server is
  specifically needed.
- **Ambient verification catcher:** only on-demand lookup was added. Do not
  add inbox watching, automatic clipboard writes, or clipboard reads without
  explicit approval.
- **Self-updating binaries, release packaging, Docker, and registry publishing:**
  these are not part of this source-first fork.

## OAuth watcher note

The watcher calls `OAuthService.getAccessToken()` each time it opens an IDLE
connection. Reconnects call the same connection path, which refreshes an
expired token. A token expiring after an established IMAP login does not by
itself require an extra timer. Do not add periodic reconnects without a
reproduced failure.

## Code map

| Area | Files |
|---|---|
| App wiring | `src/app.ts`, `src/main.ts` |
| Config | `src/config/schema.ts`, `src/config/loader.ts` |
| IMAP and SMTP | `src/services/imap.service.ts`, `src/services/smtp.service.ts` |
| MCP tools | `src/tools/register.ts`, `src/tools/` |
| CLI | `src/cli/email-commands.ts`, `src/cli/config-commands.ts` |
| Cache | `src/cache/store.ts`, `src/cache/sync-engine.ts` |
| Verification lookup | `src/services/verification.service.ts`, `src/tools/verification.tool.ts` |

## Conventions and verification

- TypeScript ESM, Node.js 24+, Biome, Vitest
- Run `pnpm check`, `pnpm typecheck`, `pnpm build`, and `pnpm test`
- Keep changes narrow, add behavior tests, and stage only files changed for the
  task. Do not stage unrelated `package.json` edits.
- Node 24 is the target (`.nvmrc`). The suite also passes on Node 22.23
  (`node:sqlite` is unflagged from 22.13), but verify on Node 24 before release.
