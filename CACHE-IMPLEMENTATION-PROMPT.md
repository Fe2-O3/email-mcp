# IMAP Wizard: verified body-tier cache implementation plan

This is a prompt for a strong coding model, but it is first an **evidence-backed
specification**. Every factual claim below was checked against this repository
on 2026-11-17. The verification results come first so the implementer can tell
what was observed, what was derived, and what was assumed.

Do not implement the cache from the earlier plan. That plan described tables and
columns that do not exist here. Use this one.

## 1. Verification results

### 1.1 What was checked (observed this session)

| Claim | How it was checked | Result |
|---|---|---|
| Cache files | `ls src/cache/` | `schema.ts`, `store.ts`, `store.test.ts`, `sync-engine.ts`, `sync-engine.test.ts`. There is no `mail-read.service.ts` in this fork. |
| Schema location | Read `src/cache/schema.ts` | `SCHEMA_SQL` and `SCHEMA_VERSION = 1` live in `src/cache/schema.ts`, not in `store.ts`. |
| Message table | Read `src/cache/schema.ts:39-60` | Table is `message`, PK `(account, mailbox, uid, uid_validity)`. There is no `emails` table. |
| Body columns | Read `src/cache/schema.ts:55-56` | `body_text TEXT` and `body_fetched_at INTEGER` **already exist**. |
| FTS | Read `src/cache/schema.ts:75-102` | `message_fts` FTS5 external-content table plus insert/delete/update triggers already exist over `subject, from_text, body_text`. |
| Store APIs | Grep/read `src/cache/store.ts` | Existing methods: `putMessages`, `putBody`, `getMessage`, `findByMessageId`, `listMessages`, `searchMessages`, `listAllUids`, `countMessages`, `deleteMessages`, `pruneOlderThan`, `pruneOldest`, `vacuum`, `putMailboxState`, `getMailboxState`, `resetEpoch`, `clear`, `sizeBytes`, `close`. |
| `putBody` behavior | Read `src/cache/store.ts:324-338` | Takes `(account, mailbox, uid, uidValidity, bodyText: string)` and sets only `body_text` + `body_fetched_at`. No headers, no subtype, no preview, no attempt marker, no byte cap. |
| `putBody` tested | `pnpm exec vitest run src/cache/store.test.ts` | 11 tests passed, including body write/read and FTS findability. |
| Mailbox state | Read `src/cache/schema.ts:24-35` | Table `mailbox_state` holds `uid_validity TEXT`, `uid_next`, `highest_modseq`, `sync_tier`, `total_messages`, `unseen_messages`, `last_synced_at`. There is no `sync_state` table. |
| UIDVALIDITY convention | Read `src/cache/schema.ts:6-16` | UIDVALIDITY is the cache epoch, stored as TEXT (bigint safety). Denormalized on each message. |
| Migration behavior | Read `src/cache/store.ts:206-220` | `migrate()` drops all tables only when the **existing** `user_version` is greater than `SCHEMA_VERSION`; then runs `SCHEMA_SQL` (`CREATE TABLE IF NOT EXISTS`) and sets `user_version`. |
| Migration proof (spike) | `node:sqlite` experiment | `CREATE TABLE IF NOT EXISTS t (a, b)` against an existing `t(a)` leaves only column `a`. Result: **CONFIRMED — IF NOT EXISTS does not add columns**. Bumping `SCHEMA_VERSION` from 1 to 2 will not upgrade a v1 database. |
| Sync cycle location | Read `src/app.ts:215-250` | `startBackgroundServices()` runs `syncEngine.syncMailbox()` once at startup then every `syncInterval`; `stop()` cancels `cacheInterval`, stops the engine, and closes `cacheStore`. Backfill should ride this cycle. |
| Sync fetch shape | Read `src/cache/sync-engine.ts:394-440` | `fetchChanges()` fetches only `uid, envelope, flags, bodyStructure, internalDate` — no body, no `source`. This is the safe pattern to extend; do not switch to `source: true`. |
| Live read path | Read `src/services/imap.service.ts:751-786` | `getEmail()` always opens an IMAP client and fetches headers + bodyStructure, then decodes body parts via `messageToEmail`. No cache use. |
| Conversion constraint | Read `src/services/imap.service.ts:328-419` | `messageToEmail()` needs an `ImapFlow` client and a `headers` fetch. Cached rows do not store raw headers or `bodyHtml`, so a cached-only `Email` cannot be complete today. |
| Search path | Read `src/services/imap.service.ts:845-900` | `searchEmails()` always uses IMAP SEARCH. Store has a working FTS `searchMessages()` that nothing calls. |
| Thread path | Read `src/services/imap.service.ts:1963+` | `getThread()` always uses IMAP SEARCH/fetch. Store has `findByMessageId()` that nothing calls. |
| Backfill | Grep `bodyMessages`/`body_messages` | Config field exists (`default 500`) but is unused outside config/tests. No backfill code. |
| Upstream commits | `git cat-file -t` on fetched upstream develop | All ten SHAs listed in the old plan exist and are cache commits dated 2026-10-10. Their subjects match the features claimed. |
| Upstream implementation pattern | Read commit `5012971` diff | Upstream adds a `MailReadService` facade, stores headers + `bodySubtype`, caps cached bodies at `MAX_CACHED_BODY_BYTES`, marks attempted bodies, coalesces concurrent reads, and rides backfill on the sync cycle. |
| Verification environment | `zsh -ic 'node -v; pnpm --version'` | Node v24.22.3, pnpm 11.22.0. `node:sqlite` is available. |

### 1.2 Errors in the previous plan (corrected here)

1. It said to add columns to an `emails` table. The table is `message` and
   `body_text`/`body_fetched_at` already exist.
2. It proposed a new `sync_state` table. `mailbox_state` already provides that
   role, with TEXT uid_validity for bigint safety.
3. It claimed a cache hit can return a full body. Not true: raw headers and
   `bodyHtml` are not stored, so a cache hit would be a partial `Email`.
4. It assumed changing `SCHEMA_SQL` upgrades an existing database. The spike
   proved it does not; an explicit versioned migration is required.
5. It omitted that FTS search and Message-ID lookup already work in the store
   and are simply unwired.
6. It omitted the upstream `MailReadService` pattern, which is the proven seam
   for read-through without scattering cache policy through `ImapService`.

### 1.3 Proven facts to build on

- Storage for `body_text` works and is tested. The missing pieces are
  **headers/HTML storage, read-through wiring, backfill, attachment store, and
  correct schema migration**.
- `node:sqlite` works under Node 24 in this environment.
- Upstream's design is available and its commits are real; adapt, do not copy.

## 2. Goal and non-goals

**Goal.** Extend the existing mirror so `get_email`, `search_emails`, and
`get_thread` can be answered locally when the mirror is complete and fresh,
with automatic fallback to live IMAP otherwise. Add a bounded attachment store
with LRU eviction.

**Non-goals.** No daemon, no background body scanning unrelated to the existing
sync cycle, no release/publishing changes, no changes to identity or global
setup. Do not reimplement scheduler, watcher, verification tool, or CLI.

## 3. Design decisions (already made; do not relitigate without asking)

1. **Add a `MailReadService` facade** in `src/services/mail-read.service.ts`,
   modeled on upstream `5012971`/`3ce4dc1`/`0f037ec`. Wire tools to it. Keep
   `ImapService` as the live transport. This avoids mixing cache policy into
   protocol code.
2. **A cache hit requires a complete stored body plus stored headers.** Store
   `headers_json`, `body_html`, `body_subtype`, and `body_attempted_at`.
   Serve from cache only when body is present and not marked as a dead end.
3. **Body content is immutable per `(uidValidity, uid)`**; flags are not. Trust
   cached bodies for a generation, but revalidate mailbox state before serving.
4. **Bounded backfill** rides the existing sync cycle, using `body_messages` as
   the per-mailbox budget. No unbounded scans.
5. **Attachment store uses content hashes**, with LRU under `max_size_mb`.
6. **Every cache error is swallowed on the read path and falls back to IMAP.**
   A partial answer is forbidden.

## 4. Implementation phases

### Phase 0: Correct schema migration (do this first)

- Move to `SCHEMA_VERSION = 2` in `src/cache/schema.ts`.
- Extend `SCHEMA_SQL` with the new columns/tables below.
- Add an explicit `migrate()` upgrade path in `src/cache/store.ts`:
  - If existing version is 1: `ALTER TABLE message ADD COLUMN headers_json TEXT`,
    `ADD COLUMN body_html TEXT`, `ADD COLUMN body_subtype TEXT`,
    `ADD COLUMN body_attempted_at INTEGER`; then create the new attachment
    tables; then set `user_version = 2`.
  - Keep the existing "existing version > current → drop and rebuild" branch.
- Add a test that constructs a v1 database, opens it with the new code, and
  asserts all new columns/tables exist and existing messages survive.
- **Why:** the spike proved `CREATE TABLE IF NOT EXISTS` will not upgrade v1.

New columns on `message`:

```sql
headers_json       TEXT,                -- parsed headers for a complete Email
body_html          TEXT,                -- HTML half of multipart/alternative
body_subtype       TEXT,                -- 'plain' | 'html' | undefined
body_attempted_at  INTEGER,             -- dead-end marker; never retried
```

New tables:

```sql
CREATE TABLE IF NOT EXISTS attachment (
  content_hash  TEXT PRIMARY KEY,       -- SHA-256 of raw bytes
  filename      TEXT NOT NULL,
  mime_type     TEXT NOT NULL,
  size          INTEGER NOT NULL,
  local_path    TEXT,
  created_at    INTEGER NOT NULL,
  last_access   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_attachment (
  account      TEXT NOT NULL,
  mailbox      TEXT NOT NULL,
  uid          INTEGER NOT NULL,
  uid_validity TEXT NOT NULL,
  part_id      TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  PRIMARY KEY (account, mailbox, uid, uid_validity, part_id),
  FOREIGN KEY (content_hash) REFERENCES attachment(content_hash)
);
```

Do **not** add a `sync_state` table. Use `mailbox_state`.

### Phase 1: Complete body storage

- Extend `CachedMessageInput`/`CachedMessage` in `src/cache/store.ts` with the
  new fields.
- Replace `putBody(account, mailbox, uid, uidValidity, bodyText: string)` with
  a structured version carrying `{ text, html?, subtype, headers, preview? }`.
  Keep a compatibility path if other callers exist (verified: none today).
- Add `markBodyAttempted(account, mailbox, uid, uidValidity)` and
  `touchAccess(...)` for LRU.
- Add `MAX_CACHED_BODY_BYTES = 256 * 1024` (same as upstream) and refuse larger
  bodies with an attempt marker instead of storing them.
- Update the FTS triggers to index `body_html` as well if HTML-only messages
  must be searchable; decide explicitly and cover with a test.

### Phase 2: MailReadService read-through

- Create `src/services/mail-read.service.ts` with:
  - `getEmail(account, id, mailbox)` — revalidate mailbox state; on `cache`
    result, serve a stored complete body; otherwise fetch live, write back, and
    return. Coalesce concurrent loads keyed by `account\u0000mailbox\u0000uid`.
  - `searchEmails(...)` — on `cache` result with a complete mirror, call
    `store.searchMessages()`; otherwise call `ImapService.searchEmails()`.
  - `getThread(...)` — use `store.findByMessageId()` for cached links; if any
    thread member is missing from the mirror, fall back to live IMAP.
  - `getEmailFlags`, `listEmails` stay live or use existing store methods only
    when completeness is provable.
- Factory: `revalidate(account, mailbox)` returns either `{kind:'cache',
  uidValidity}` or `{kind:'live'}`; check `mailbox_state.last_synced_at` and
  config `syncInterval`. On live, refresh state through the existing sync
  engine. Keep this synchronous-safe (no unhandled rejections).
- Register the service in `src/app.ts`, pass it to `registerAllTools()` and the
  CLI where needed. Update `src/tools/emails.tool.ts`, `src/tools/thread.tool.ts`,
  `src/tools/locate.tool.ts`, and `src/cli/email-commands.ts` to call it.
- **Never** remove the live fallback or let a cache exception reach the tool.

### Phase 3: Bounded body backfill

- Add `backfillBodies(account, mailbox)` to `src/cache/sync-engine.ts`:
  - Read `body_messages` budget from config (already normalized as
    `bodyMessages`).
  - Select newest messages with null body and null `body_attempted_at`, limited
    to the budget; fetch in small batches; call the new `putBody`.
  - Mark dead ends with `markBodyAttempted` (oversize, decode failure, missing
    part) so they are never retried each cycle.
  - Rides the existing reconcile cycle in `startBackgroundServices()`; never
    throws; cancellable on shutdown.
  - Respect read-only mode: no remote writes. Keep the existing metadata-only
    fetch plus decoded part download pattern (`sync-engine.ts:394-440`); never
    use `source: true`, which pulls full messages and risks changing flags.

### Phase 4: Attachment store

- Implement `src/cache/attachment-store.ts`:
  - `store(buffer, metadata) -> hash`, `get(hash)`, `touch(hash)`,
    `evictToFit(maxBytes)` with oldest `last_access` first.
  - Write blobs under the XDG cache dir already used by `CACHE_DB`; inherit its
    0700/0600 permissions posture.
- Wire into `ImapService.downloadAttachment` **after** the read-through facade
  is stable: check `email_attachment` by part id, else download and persist.
- Respect `max_attachment_size_mb` already implemented in this fork.

### Phase 5: Docs and config

- Document new settings in `README.md` and the config template:
  `body_backfill_interval` (if added), `attachment_store_enabled`,
  `max_attachment_store_mb`. Reuse `body_messages` and `max_size_mb` where they
  already exist instead of inventing duplicates.
- Document that bodies are stored locally and that the cache is regenerable;
  point privacy note at the existing at-rest posture.

## 5. Test plan (grounded in real files)

Existing files to extend:
- `src/cache/store.test.ts` — v1→v2 migration, new columns, headers/HTML write,
  attempt markers, LRU touch, attachment tables, FTS over HTML.
- `src/cache/sync-engine.test.ts` — backfill budget, dead-end markers, batching,
  cancellation, no throw on failure.
- `src/services/imap.service.test.ts` — live path unchanged when no cache.
- `src/tools/register.test.ts` — new service wiring, read-only mode.

Files to create:
- `src/services/mail-read.service.test.ts` — cache hit, cache miss, stale,
  concurrent coalescing, corrupt store fallback, partial-body rejection,
  search/thread fallback, failure never propagates.
- `src/cache/attachment-store.test.ts` — hash dedupe, LRU, disk budget,
  permissions, missing blob.
- `src/__integration__/cache-read.integration.test.ts` — end-to-end with the
  existing GreenMail harness.

Lifecycle: `src/main.lifecycle.test.ts` — backfill and cache close on shutdown.

## 6. Risks and mitigations

| Risk | Mitigation |
|---|---|
| Migration drops user data | Explicit v1→v2 ALTER path + test. Mirror is regenerable, but do not rely on that. |
| Partial Email from cache | Require headers + body + subtype before a hit; test partial rejection. |
| Stale flags/labels | Revalidate mailbox state; flags are never trusted from cache blindly. |
| Memory blowup | 256 KB body cap; batched backfill; attachment byte budget. |
| Broken mirror breaks tools | All cache code wrapped; live fallback on every error. |
| Concurrent duplicate fetches | Coalescing map with NUL-delimited keys (upstream proved this pattern). |
| read-only violation | No remote writes; metadata-only FETCH + decoded part download; backfill gated by config. |

## 7. Conventions and success criteria

- TypeScript ESM, Node 24, Biome, Vitest, conventional commits, path-scoped
  commits, no `git add -A`. Push after green hooks as usual.
- Use the pinned pnpm version. Do not modify global setup or unrelated scripts.
- Before claiming done, run and **report actual output** of:
  `pnpm check`, `pnpm typecheck`, `pnpm build`, `pnpm test`.
- Done means: all tests pass; cache hit/fallback tests prove no partial results;
  v1 migration test passes; disk budget enforced; shutdown clean.

## 8. Upstream reference (verified)

Fetch with `git fetch https://github.com/codefuturist/email-mcp.git develop`.
All SHAs below were verified to exist as 2026-10-10 cache commits:

- `d22d4f4` schema v3, `5012971` body tier, `8d8111b` cached list/flags,
  `3ce4dc1` search/thread, `358901e` attachment store, `3e5f921` LRU,
  `0a745e0` filename index, `5ffc8ff` NUL key fix, `e78e832` completeness fix,
  `0f037ec` MailReadService facade.

Read the diffs for patterns. Adapt to this fork. Do not cherry-pick the branch.
