# IMAP Wizard: body-tier cache implementation

This document is a prompt for a strong coding model. It replaces the earlier
handoff note and is intentionally self-contained. Read `README.md` and
`CONTRIBUTING.md` first. No repository `AGENTS.md` exists.

The goal is to extend the existing SQLite metadata mirror with reliable,
bounded local storage for message bodies and attachments. Keep live IMAP as
the safe fallback whenever cached data is missing, stale, incomplete, or
unhealthy.

## Rules for the implementer

1. Do not copy upstream wholesale. The fork has materially different lifecycle,
   security, CLI, and tool code.
2. Do not enable background body scanning or any daemon-like behavior.
3. Cache correctness is the highest priority. A stale or partial answer is
   worse than a slow one.
4. Every cache read must prove freshness before returning data.
5. Every cache failure must fall back to live IMAP, never produce a partial
   result.
6. Follow the repository conventions: TypeScript ESM, Biome, Vitest, path-scoped
   commits, no `git add -A`.
7. Use Node 24 from `.nvmrc` and the repository-pinned pnpm version.
8. Run `pnpm check`, `pnpm typecheck`, `pnpm build`, and `pnpm test` before
   claiming completion.

## Current state

### Cache implementation

- `src/cache/store.ts` — SQLite mirror with `window_days` and `max_size_mb`
  backstop. Stores message metadata (uid, subject, from, to, date, flags,
  labels, has_attachments). No body tier, no read-through, no thread assembly,
  no attachment store.
- `src/cache/sync-engine.ts` — background reconcile with UIDVALIDITY tracking,
  deletion pass, and size-budget eviction.
- `src/services/imap.service.ts` — all reads go through live IMAP. Cache is
  populated as a side effect of sync-engine, not on demand.
- `src/tools/emails.tool.ts` — `get_email` fetches from IMAP, not cache.
- `src/tools/threads.tool.ts` — thread assembly from live IMAP.

### What already works (do not rebuild)

- Scheduler, watcher with IDLE/triage/alerts, provider-aware labels, OAuth
- Connection rotation, cache eviction, chunked UID fetches
- SQLite mirror with window_days and max_size_mb
- HTTP transport, config validate, keychain, password_command
- Cross-platform keychain (macOS security + Linux secret-tool)
- Email CLI (list, read, search, mailboxes, flag, delete, attach, reply, send)
- On-demand verification code lookup (opt-in, no background scanning)

### Key types and interfaces

```typescript
// src/types/index.ts
interface EmailMeta {
  id: string; messageId: string; subject: string; from: EmailAddress;
  to: EmailAddress[]; date: string; seen: boolean; flagged: boolean;
  answered: boolean; hasAttachments: boolean; labels: string[]; bulk?: BulkSignal;
}

interface Email extends EmailMeta {
  cc?: EmailAddress[]; bcc?: EmailAddress[]; replyTo?: EmailAddress;
  bodyText?: string; bodyHtml?: string; inReplyTo?: string;
  references?: string[]; attachments: AttachmentMeta[]; headers: Record<string, string>;
}

interface CacheConfig {
  enabled: boolean; mailboxes: string[]; windowDays: number;
  bodyMessages: number; maxSizeMb: number; syncInterval: number;
}
```

### Config wiring

- `src/config/schema.ts` — Zod schemas with factory defaults
- `src/config/loader.ts` — TOML parsing + env vars + normalization
- `src/app.ts` — `buildServices()` constructs `CacheStore` and `SyncEngine`
- `src/main.ts` — CLI dispatch, idle-exit valve

## What to build

### Phase 1: Body tier in SQLite (schema v3)

Add columns to the existing `emails` table:

```sql
ALTER TABLE emails ADD COLUMN body_text TEXT;
ALTER TABLE emails ADD COLUMN body_html TEXT;
ALTER TABLE emails ADD COLUMN body_fetched_at INTEGER;  -- Unix timestamp ms
ALTER TABLE emails ADD COLUMN body_complete INTEGER DEFAULT 0;  -- 1 if full body cached
```

Add a new `attachments` table for content-addressed storage:

```sql
CREATE TABLE IF NOT EXISTS attachments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash TEXT NOT NULL UNIQUE,  -- SHA-256 of raw bytes
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size INTEGER NOT NULL,
  local_path TEXT,  -- null if not yet downloaded to disk
  created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_attachments (
  email_uid INTEGER NOT NULL,
  mailbox TEXT NOT NULL,
  attachment_id INTEGER NOT NULL,
  part_id TEXT,  -- MIME part number for re-download
  PRIMARY KEY (email_uid, mailbox, attachment_id),
  FOREIGN KEY (attachment_id) REFERENCES attachments(id)
);
```

Add a `sync_state` table for per-mailbox freshness tracking:

```sql
CREATE TABLE IF NOT EXISTS sync_state (
  account TEXT NOT NULL,
  mailbox TEXT NOT NULL,
  uidvalidity INTEGER,
  last_sync_at INTEGER NOT NULL,
  message_count INTEGER,
  PRIMARY KEY (account, mailbox)
);
```

### Phase 2: Read-through body cache

Modify `ImapService.getEmail()` to:

1. Check cache for body (body_complete = 1 AND body_fetched_at within freshness window)
2. If cache hit and fresh, return cached body
3. If cache miss or stale, fetch from IMAP, cache the body, return it
4. If IMAP fetch fails, return cached body if available (stale-while-error)
5. Never return a partial body — if body_complete = 0, fetch from IMAP

Freshness rules:
- Body is fresh if `body_fetched_at > Date.now() - (sync_interval * 1000 * 2)`
- Body is stale if `body_fetched_at` is older than 2x sync interval
- Stale body triggers a re-fetch but stale data can be served while re-fetching
- On reconnect or UIDVALIDITY change, all bodies for that mailbox are invalidated

### Phase 3: Bounded backfill

Add a background backfill process that:

1. Runs only when cache is enabled and watcher is active (or on startup)
2. Fetches bodies for the most recent `body_messages` messages that don't have
   cached bodies yet
3. Processes in batches of 10-20 messages to avoid memory pressure
4. Respects a configurable `body_backfill_interval` (default 60s between batches)
5. Is cancellable — stops on shutdown or when cache is disabled
6. Never blocks reads — backfill is best-effort background work
7. Tracks progress in sync_state table

### Phase 4: Cached search and thread assembly

- `search_emails` checks if cache covers the date range; if so, search locally
- Thread assembly (`get_thread`) uses cached References/In-Reply-To when
  available; falls back to IMAP for missing messages
- Both must verify completeness: if any message in the result set is not
  cached, fall back to IMAP

### Phase 5: Content-addressed attachment store

- When an attachment is downloaded, compute SHA-256 of raw bytes
- Store in `attachments` table; reuse if hash exists
- `email_attachments` junction links email to attachments with part_id
- LRU eviction: when total size exceeds `max_size_mb`, evict oldest attachments
  first, then remove from disk
- Attachment download tool checks cache before IMAP

### Phase 6: Config additions

Add to `CacheConfigSchema`:

```typescript
body_backfill_interval: z.number().int().min(10).default(60),
attachment_store_enabled: z.boolean().default(true),
max_attachment_store_mb: z.number().int().min(1).default(100),
```

Add to `CacheConfig` interface in `src/types/index.ts`.

## Freshness and invalidation rules (critical)

1. **UIDVALIDITY change** → purge all cached data for that mailbox
2. **Message flags change** → update flags in cache, mark body as potentially
   stale (re-fetch on next read)
3. **Message delete/expunge** → remove from cache
4. **Message move** → remove from source mailbox cache, add to destination
5. **Reconnect** → re-validate UIDVALIDITY, invalidate if changed
6. **Body fetch failure** → do not cache partial body; mark as not complete
7. **Cache write failure** → log warning, serve from IMAP, do not cache
8. **Config change** → reinitialize cache on next startup

## Test plan

### Unit tests (src/cache/*.test.ts)

- `store.test.ts`: schema v3 migration, body tier read/write, attachment store CRUD, LRU eviction, disk budget enforcement
- `sync-engine.test.ts`: backfill scheduling, batch processing, resume after restart, cancellation
- `cache-freshness.test.ts`: freshness window, stale detection, UIDVALIDITY invalidation

### Service tests (src/services/*.test.ts)

- `imap.service.test.ts`: read-through cache hit, cache miss, stale body re-fetch, stale-while-error, partial body rejection
- `imap.service.test.ts`: thread assembly from cache, fallback to IMAP
- `imap.service.test.ts`: attachment download from cache, cache miss, hash reuse

### Tool tests (src/tools/*.test.ts)

- `emails.tool.test.ts`: get_email returns cached body when fresh
- `emails.tool.test.ts`: get_email falls back to IMAP when cache stale
- `threads.tool.test.ts`: get_thread uses cached data when complete

### Integration tests (src/__integration__/)

- `cache-body.integration.test.ts`: end-to-end body caching with GreenMail
- `cache-eviction.integration.test.ts`: LRU eviction under disk pressure
- `cache-fallback.integration.test.ts`: incomplete cache falls back to IMAP

### Lifecycle tests (src/main.lifecycle.test.ts)

- Backfill stops on shutdown
- Cache store closes cleanly

## Files to create

| File | Purpose |
|---|---|
| `src/cache/attachment-store.ts` | Content-addressed attachment storage with LRU |
| `src/cache/body-backfill.ts` | Bounded background body fetcher |
| `src/cache/cache-freshness.ts` | Freshness and invalidation logic |
| `src/cache/thread-assembler.ts` | Thread assembly from cached data |

## Files to modify

| File | Changes |
|---|---|
| `src/cache/store.ts` | Schema v3, body tier, attachment store, sync_state |
| `src/cache/sync-engine.ts` | Backfill integration, freshness tracking |
| `src/services/imap.service.ts` | Read-through cache integration |
| `src/tools/emails.tool.ts` | Cached reads |
| `src/tools/threads.tool.ts` | Cached thread assembly |
| `src/config/schema.ts` | New cache settings |
| `src/config/loader.ts` | Parse new settings |
| `src/types/index.ts` | New types |
| `src/app.ts` | Wire new services |
| `README.md` | Document cache features |

## Upstream reference

- Upstream repo: `codefuturist/email-mcp`
- Fetch: `git fetch https://github.com/codefuturist/email-mcp.git develop`
- Known commits: `d22d4f4`, `5012971`, `8d8111b`, `3ce4dc1`, `358901e`,
  `3e5f921`, `0a745e0`, `5ffc8ff`, `e78e832`, `0f037ec`
- These SHAs may have changed. Verify against current develop before use.
- Do not copy upstream code. Review and adapt.

## Conventions

- TypeScript 7.x, Node 24+, ESM
- Biome for lint/format (`pnpm check`)
- Vitest for tests (`pnpm test`)
- Conventional commits via lefthook pre-commit
- Pre-push hook runs full test suite + pnpm check
- Path-scoped commits, no `git add -A`
- Push flow: `gh auth switch --user Fe2-O3`, `git push fork repair/sdk-v2:main`
- Two agents share the checkout; stage only own paths
- Never stage the unrelated `package.json` change

## Success criteria

1. `pnpm check` passes
2. `pnpm typecheck` passes
3. `pnpm build` passes
4. `pnpm test` passes (all tests, including new cache tests)
5. Body reads fall back to IMAP when cache is incomplete or stale
6. Disk budget is enforced (LRU eviction)
7. No stale data served without freshness proof
8. No partial results from cache failures
9. Cache store closes cleanly on shutdown
10. Backfill is cancellable and stops on shutdown