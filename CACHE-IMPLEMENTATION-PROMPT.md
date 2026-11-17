# Cache implementation handoff

This document is for a strong coding model. It replaces the earlier plan and is
intentionally self-contained. Read `README.md` and `CONTRIBUTING.md` first.

The goal is to extend the existing SQLite metadata mirror with reliable, bounded
local storage for message bodies and attachments. Keep live IMAP as the safe
fallback whenever cached data is missing, stale, incomplete, or unhealthy.

## What was found and verified

### Verified facts (observed this session)

1. **The cache table is `message`, not `emails`.** It already has `body_text`
   and `body_fetched_at` columns. The previous plan assumed these needed to be
   added. They do not.

2. **`putBody()` exists and is tested.** It writes `body_text` and
   `body_fetched_at`. It is never called in production code — body caching is
   dormant. The storage seam is proven; the wiring is missing.

3. **FTS5 search and Message-ID lookup already work.** `searchMessages()` and
   `findByMessageId()` exist in `src/cache/store.ts` but nothing calls them.

4. **Schema migration is broken for column additions.** The current `migrate()`
   only creates missing tables. A `node:sqlite` spike proved `CREATE TABLE IF NOT
   EXISTS` does not add columns to an existing table. Bumping `SCHEMA_VERSION`
   from 1 to 2 will not upgrade a v1 database. An explicit `ALTER TABLE`
   migration step is required.

5. **`mailbox_state` already tracks UIDVALIDITY.** No new `sync_state` table is
   needed. UIDVALIDITY is the cache epoch and is denormalized on every message
   row.

6. **No `MailReadService` facade exists.** `ImapService.getEmail()` always fetches
   from IMAP. The cache is populated by the sync engine but never read by tools.

7. **No write-side invalidation.** The fork emits `email:new`, `email:expunge`,
   `email:flags`, and `imap:reconnect` but no `email:changed` event. Flags set
   through tools go stale in the mirror until the next sync.

8. **`messageToEmail()` needs an `ImapFlow` client and a `headers` fetch.**
   Cached rows do not store headers or `bodyHtml`. A cache hit would produce a
   partial `Email` unless headers and both body halves are stored.

9. **`body_messages` config exists but is unused.** It defaults to 500 but no
   backfill reads it.

10. **Upstream commits are real.** All ten SHAs listed in the previous plan
    (`d22d4f4`, `5012971`, `8d8111b`, `3ce4dc1`, `358901e`, `3e5f921`,
    `0a745e0`, `5ffc8ff`, `e78e832`, `0f037ec`) exist as 2026-10-10 cache
    commits. Upstream adds a `MailReadService` facade, stores `headers_json`
    and `bodySubtype`, caps cached bodies at 256 KB, marks attempted bodies,
    coalesces concurrent reads, and rides backfill on the sync cycle.

11. **Upstream's freshness model is STATUS-based.** One STATUS probe compares
    UIDVALIDITY, UIDNEXT, HIGHESTMODSEQ, and MESSAGES against stored watermarks.
    A time-based freshness window is insufficient — a message expunged on the
    server one second after the last sync would still be served.

12. **Upstream's attachment store is content-addressed.** SHA-256 of raw bytes,
    re-hash on every read, temp-file-then-rename at mode 0600, LRU eviction in
    order: blobs first, then bodies, then old envelopes.

13. **The bench script was written but not run.** The command was interrupted
    before producing output. G0 has not been measured.

### What was wrong in the earlier plan

- Named a `sync_state` table that does not exist (use `mailbox_state`)
- Assumed columns needed to be added to an `emails` table (table is `message`,
  body columns already present)
- Assumed a schema bump would upgrade existing databases (it does not)
- Claimed a cache hit could return a full body without storing headers or HTML
- Used time-based freshness instead of STATUS probe
- Omitted write-side invalidation (no `email:changed` event exists)
- Did not say which callers switch to the cache
- Did not surface staleness or offline status
- Had no kill-switch test or measurement gate

## What needs to be built

### Phase 0: Measure (gate)

Write `scripts/bench-get-email.ts` (already written, not run). Run it against
the owner's real account. Record p50/p95 for live `getEmail`, STATUS probe, and
local SQLite read. Gate passes when live p50 >= 3x (STATUS p95 + local p95).

**Status:** Script written but interrupted. Needs to be run and results recorded.

### Phase 1: Schema v2 with explicit migration

- `SCHEMA_VERSION = 2` in `src/cache/schema.ts`
- `migrate()` in `src/cache/store.ts`: if `user_version === 1`, run `ALTER TABLE
  message ADD COLUMN` for `headers_json`, `body_html`, `body_subtype`,
  `body_attempted_at`; create `attachment` and `email_attachment` tables; set
  `user_version = 2`. Keep the "newer version: rebuild" branch.
- New tables for content-addressed attachment storage (see below)
- Tests: v1→v2 migration, idempotent re-open, newer-version rebuild, transaction
  rollback on failure

### Phase 2: Complete body storage and read-through

- Extend `CachedMessageInput`/`CachedMessage` with `headers`, `bodyHtml`,
  `bodySubtype`
- Replace `putBody` to accept structured body data (text, html, subtype, headers)
- Add `markBodyAttempted`, `clearBody`, `touchAccess`
- Add `MAX_CACHED_BODY_BYTES = 256 * 1024` constant
- Create `MailReadService` facade (modeled on upstream, adapted to our fork)
- Wire tools and CLI to use `MailReadService` instead of direct `ImapService`
  calls for reads
- Response carries `source: 'mirror' | 'live' | 'mirror-offline'`
- Coalesce concurrent reads by `account\u0000mailbox\u0000uid`
- Write-back after successful live fetch (not before)
- Golden test: cached `Email` equals live `Email` field-by-field

### Phase 3: Write invalidation

- Emit `email:changed` from `ImapService` after `setFlags`, `moveEmail`,
  `deleteEmail`, mailbox create/rename/delete
- Facade and sync engine handle the event
- Tests for each write path

### Phase 4: Search and thread from mirror

- `search_emails`: use FTS only when mailbox state is current (STATUS probe
  passed). Otherwise live.
- `get_thread`: use `findByMessageId` only when all thread members are cached.
  Any missing member means live.
- Tests for partial coverage fallback and search equality

### Phase 5: Bounded body backfill

- `backfillBodies(account, mailbox)` in `SyncEngine`, bounded by `body_messages`
  (default 500), batched (default 25 per cycle)
- Mark dead ends with `markBodyAttempted` (oversize, decode failure, missing
  part)
- Rides existing reconcile cycle in `startBackgroundServices()`
- Respect read-only mode (no remote writes, FETCH with BODY.PEEK only)
- Cancellable on shutdown

### Phase 6: Attachment store

- `src/cache/blob-store.ts` — content-addressed, SHA-256, re-hash on read,
  temp-file-then-rename at 0600, LRU eviction
- `src/cache/maintenance.ts` — budget enforcement, eviction order
- Wire into `downloadAttachment` in the facade
- Respect `max_attachment_size_mb` (already implemented)

### Phase 7: Config, docs, kill switch

- Reuse existing `[settings.cache]` keys; add `attachment_cache = true` if needed
- Document in README.md and config template
- Update SECURITY.md for locally stored bodies and attachments
- `settings.cache.enabled = false` must make `MailReadService` a pure pass-through

## Architecture notes

- Entry point: `src/main.ts` dispatches commands
- App wiring: `src/app.ts` — `buildServer()`, `buildServices()`,
  `startBackgroundServices()`
- Config: `src/config/schema.ts` (Zod), `src/config/loader.ts` (TOML + env)
- Services: `src/services/` — imap, smtp, watcher, oauth, cache, hooks,
  scheduler, calendar, etc.
- Tools: `src/tools/` — MCP tool registration (49 tools + opt-in verification)
- Cache: `src/cache/store.ts` — SQLite mirror (node:sqlite, Node 24 only)
- Security: `src/security/` — keychain, password_command

## Conventions

- TypeScript 7.x, Node 24+, ESM
- Biome for lint/format (`pnpm check`)
- Vitest for tests (504 tests, 63 files)
- Conventional commits via lefthook pre-commit (biome + typecheck)
- Pre-push hook runs full test suite + pnpm check
- Path-scoped commits, no `git add -A`
- Push flow: `gh auth switch --user Fe2-O3`, `git push fork repair/sdk-v2:main`
- Two agents share the checkout; stage only own paths
- Never stage the unrelated `package.json` change
- Use Node 24 from `.nvmrc` and pnpm 11.22.0

## Test plan

### Unit tests

- `src/cache/store.test.ts`: schema v2 migration, body write/read, headers/HTML
  round-trip, attempt markers, LRU touch, attachment tables, FTS over HTML
- `src/cache/sync-engine.test.ts`: backfill budget, dead-end markers, batching,
  cancellation, no throw on failure
- `src/services/mail-read.service.test.ts`: cache hit, miss, stale, coalescing,
  corrupt store fallback, partial-body rejection, search/thread fallback,
  failure never propagates
- `src/cache/attachment-store.test.ts`: hash dedupe, LRU, disk budget, permissions,
  missing blob
- `src/cache/maintenance.test.ts`: eviction order, budget enforcement

### Integration tests

- `src/__integration__/cache-read.integration.test.ts`: end-to-end with GreenMail
- `src/__integration__/cache-fallback.integration.test.ts`: incomplete cache falls
  back to IMAP

### Lifecycle tests

- `src/main.lifecycle.test.ts`: backfill stops on shutdown, cache closes cleanly

## Success criteria

1. `pnpm check` passes
2. `pnpm typecheck` passes
3. `pnpm build` passes
4. `pnpm test` passes (all tests including new cache tests)
5. Body reads fall back to IMAP when cache is incomplete or stale
6. Disk budget is enforced (LRU eviction)
7. No stale data served without freshness proof (STATUS probe)
8. No partial results from cache failures
9. Cache store closes cleanly on shutdown
10. Backfill is cancellable and stops on shutdown
11. G0 measurement table present with actual numbers justifying the work
12. Golden test: cached `Email` equals live `Email` field-by-field
13. T-OFF test: disabling cache returns today's output

## Risks

| Risk | Mitigation |
|---|---|
| Migration corrupts a user database | Explicit v1→v2 ALTER path + tests; mirror is regenerable but do not rely on that |
| Stale mail served silently | STATUS probe per read; `source` field in every response |
| Missed write invalidation | D4; tests for each write path |
| Partial result from partial mirror | Completeness check; live fallback |
| Memory growth | 256 KB body cap; batch 25; blob budget |
| Privacy: bodies on disk | 0700/0600; documented; kill switch |
| Cache slower than live | G0 gate |
| Read-only violated by backfill | T-BF-RO test |

## Upstream reference

- Upstream repo: `codefuturist/email-mcp`
- Fetch: `git fetch https://github.com/codefuturist/email-mcp.git develop`
- Files: `src/cache/blob-store.ts`, `src/cache/maintenance.ts`,
  `src/services/mail-read.service.ts`, `src/cache/sync-engine.ts`
  (`backfillBodies`), `src/cache/store.ts` (`markBodyAttempted`, `clearBody`,
  `touchAccess`)
- All SHAs verified as real 2026-10-10 cache commits
- Read the diffs for patterns. Adapt to this fork. Do not cherry-pick the branch.

## Important context

- The email MCP server instructions are no longer available in this
  environment (removed Nov 12, 2026). The server itself still works.
- Two agents share this checkout. Stage only own paths. `package.json` has an
  uncommitted change from another session — do not stage it.
- The user's config is at `~/.config/email-mcp/config.toml` with
  `idle_exit = 0`.
- The user's git identity: `208582076+Fe2-O3@users.noreply.github.com`.
- Historical 94 commits are attributed to UnhandledPage (old account ID
  33189015). This cannot be changed without force-pushing.
- Node 24.22.3 is installed via nvm and set as the default alias. New
  terminals use Node 24. The current OpenCode process may still use Node 22
  until restarted.
- `scripts/bench-get-email.ts` exists but was not run (interrupted). G0 needs
  to be executed first.