# IMAP Wizard: body-tier cache, verified plan (v3)

This is a specification for a strong coding model. Section 1 separates what was
checked from what is still assumed. Section 2 lists errors found in earlier
versions. Later sections are the design, phases, gates, and tests.

Read `README.md` and `CONTRIBUTING.md` first. No `AGENTS.md` exists.

## 1. Evidence

### 1.1 Observed in this repository (2026-11-17)

| # | Claim | Check performed | Result |
|---|---|---|---|
| E1 | Table is `message`, PK `(account, mailbox, uid, uid_validity)` | Read `src/cache/schema.ts` | Confirmed |
| E2 | `body_text` and `body_fetched_at` already exist | Read schema | Confirmed |
| E3 | FTS5 `message_fts` with insert/update/delete triggers exists | Read schema | Confirmed |
| E4 | No `headers_json`, `body_html`, `body_subtype`, `body_attempted_at`, `touchAccess`, `markBodyAttempted`, `clearBody` | Grep `src/cache` | Confirmed absent |
| E5 | `putBody` has no production caller | Grep `putBody(` outside tests | Confirmed. Body tier is dormant. |
| E6 | Schema migration only creates missing tables | Spike with `node:sqlite` | Confirmed: `CREATE TABLE IF NOT EXISTS` does not add columns. Upgrade needs `ALTER TABLE`. |
| E7 | Current `user_version` path: rebuild if newer, else `CREATE IF NOT EXISTS` | Read `src/cache/store.ts:206-220` | Confirmed. A v1 database cannot gain columns without a new step. |
| E8 | `SyncEngine` exposes `start`, `stop`, `detectTier`, `syncMailbox` | Grep | Confirmed. No `backfillBodies` yet. |
| E9 | Live `getEmail` is called by `emails.tool.ts`, `calendar.tool.ts`, `hooks.service.ts`, `smtp.service.ts` (reply and forward), `verification.service.ts` | Grep | Confirmed. Any cache plan must choose which callers switch. |
| E10 | `getThread` is called only by `thread.tool.ts`; `searchEmails` by `emails.tool.ts` | Grep | Confirmed |
| E11 | The fork emits `email:new`, `email:expunge`, `email:flags`, `imap:reconnect` | Read `event-bus.ts` | Confirmed. **No write-side `email:changed` event exists.** `setFlags`, `moveEmail`, `deleteEmail`, `markBodyAttempted` paths do not notify the cache. |
| E12 | Fork's `messageToEmail` decodes text and html parts and builds headers from a `headers` fetch | Read `imap.service.ts:328-419` | Confirmed. A cached `Email` must reproduce these fields exactly. |

### 1.2 Observed in upstream (`codefuturist/email-mcp` develop, fetched 2026-11-17)

| # | Fact | Where |
|---|---|---|
| U1 | `MAX_CACHED_BODY_BYTES = 256 * 1024` | `src/cache/store.ts:29` |
| U2 | Body rows store `headers_json`, `body_subtype`; `clearBody` resets them together | `store.ts:234-265, 1183` |
| U3 | `markBodyAttempted` marks dead-end bodies so they are not retried | `store.ts:920` |
| U4 | `touchAccess` records LRU reads | `store.ts:649` |
| U5 | Reads use a debounce window, then a single STATUS probe comparing UIDVALIDITY, UIDNEXT, HIGHESTMODSEQ, MESSAGES | `mail-read.service.ts` header comment, lines 1-30 |
| U6 | When IMAP is unreachable, serve the mirror marked `offline: true`; when a sync is slow, serve marked `stale: true` | Same header |
| U7 | Attachments are content-addressed by SHA-256 in `blob-store.ts`; reads re-hash and delete corrupt blobs; writes are temp-file-then-rename at mode 0600 | `src/cache/blob-store.ts` header |
| U8 | `maintenance.ts` evicts in order: attachment blobs, then bodies, then old envelopes | `src/cache/maintenance.ts` header |
| U9 | `backfillBodies(account, mailbox, batchLimit = 25)` is bounded by `bodyMessages` per mailbox and runs in the reconcile loop | `sync-engine.ts:545-552` |
| U10 | Writes emit `email:changed` so the mirror resynchronizes | `mail-read.service.ts` header |
| U11 | Commit SHAs listed in v2 exist and are 2026-10-10 cache commits | `git cat-file`, earlier check |

### 1.3 Still assumed (must be proven before the phase that depends on it)

- A1: Cached bodies are a real latency win over live `getEmail` on the owner's
  IMAP servers. **Gate G0 measures this before any cache code is written.**
- A2: Hostinger's STATUS responses are fast enough that one STATUS per read is
  cheaper than a live FETCH. Measured in G0.
- A3: `messageToEmail` output is deterministic for a given message, so a
  golden comparison between cached and live `Email` objects is valid. Proven
  by test T-GOLD in Phase 2.
- A4: Upstream's STATUS-based freshness is correct for this fork's sync
  tiers. Not verified. Phase 2 must test it on a server without CONDSTORE.

## 2. Errors in earlier versions (corrected)

1. v1 named an `emails` table. The table is `message`.
2. v1 proposed a `sync_state` table. `mailbox_state` already exists.
3. v1 said a cache hit could return a full body. It could not: headers and
   `bodyHtml` are not stored.
4. v1 assumed a schema constant change upgrades an existing database. E6 shows
   it does not.
5. v2 said freshness comes from `last_synced_at` against `syncInterval`. That
   is not a correctness proof. A message expunged on the server one second
   after the last sync would still be served. The correct check is a STATUS
   probe before serving (U5), or an explicit, surfaced staleness window.
6. v2 said nothing about write invalidation. E11 shows the fork has no write
   event. Without it, flags set from the CLI or a tool would be stale in the
   mirror until the next sync.
7. v2 did not say which callers switch to the cache. E9 lists them. Send paths
   (reply, forward, draft) must stay live: they use the live message to build
   threading and quoting, and a cached copy adds no value there.
8. v2 had no kill switch and no way to prove the cache is faster.
9. v2 did not mention stale or offline markers. Upstream U6 shows the response
   must say when data is not live, or users will trust old mail silently.

## 3. Goals and non-goals

**Goals.**
- Serve `get_email` from the mirror when the message is cached, the mailbox
  generation is confirmed current, and the body is complete.
- Serve `search_emails` from FTS when the mirror covers the mailbox and
  generation is confirmed.
- Keep every read correct: when in doubt, live IMAP, never a guess.
- Make staleness and offline status visible in tool output.
- Keep an explicit off switch that restores current behavior exactly.

**Non-goals.**
- No daemon, no background activity outside the existing reconcile loop.
- No change to send, reply, forward, or draft semantics.
- No change to release, packaging, identity, or global environment.
- No copy of upstream code. Upstream is a design reference.

## 4. Design decisions

D1. **Facade.** Add `src/services/mail-read.service.ts`. Read tools call it.
Writes stay on `ImapService` and `SmtpService`. `ImapService` remains the only
code that talks to the protocol.

D2. **Freshness per read: STATUS probe, no time-based trust.** Before serving
any cached read, send one STATUS for the mailbox and compare UIDVALIDITY,
MESSAGES, and HIGHESTMODSEQ (when CONDSTORE is available) to `mailbox_state`.
Match: serve the mirror. Mismatch: run the existing sync for that mailbox, then
serve. This follows U5. A debounce window may be added later only if G0 shows
STATUS is a measurable cost, and must then be surfaced as `checkedAt` in the
response.

D3. **Surface staleness.** Every cached response carries a `source` field:
`'mirror' | 'live' | 'mirror-offline'`. `mirror-offline` is used only when IMAP
is unreachable and the mirror is served (U6). Tools print the source in their
text output so the user can see it.

D4. **Write invalidation.** Add a write-side event
`email:changed` (`{ account, mailbox, uids? }`) emitted by `ImapService` after
`setFlags`, `moveEmail`, `deleteEmail`, and any mailbox create/rename/delete.
The facade and sync engine listen for it and clear or update the affected rows.
This closes E11. Test T-INV covers each write.

D5. **Who uses the cache.** Read-only consumers switch: `get_email`,
`get_emails`, `search_emails`, `get_thread`, `list_emails`. Consumers that build
outgoing mail or act on a message stay live: `smtp.service.ts` (reply, forward,
draft), `hooks.service.ts`, `verification.service.ts`, `calendar.tool.ts`
(calendar extraction). Calendar and verification may switch in a later phase if
G0 shows they are hot paths.

D6. **Body storage.** Store `body_text`, `body_html`, `body_subtype`,
`headers_json` together, as one unit, in one transaction. A row is "complete"
only when all required parts are present or the row is explicitly marked
attempted (U3). Bodies over 256 KB are attempted-marked, not stored (U1).

D7. **Attachments.** Use a content-addressed blob store with SHA-256 names,
re-hash on every read, temp-file-then-rename writes at mode 0600 (U7). Do not
store attachments in SQLite. This is a clean-room version of the upstream
design; keep the same invariants.

D8. **Eviction.** Order: attachment blobs, then bodies (clear, keep envelope),
then envelopes older than the window (U8). Budget comes from `max_size_mb`,
which already exists.

D9. **Backfill.** Runs inside the existing reconcile cycle in
`startBackgroundServices()`. Bounded per mailbox by `body_messages`, batched
(default 25 per cycle, U9). Read-only mode: fetches only, no writes to the
server.

D10. **Kill switch.** `settings.cache.enabled = false` already exists. With it
false, `MailReadService` is a pure pass-through and every tool returns exactly
what it returns today. Test T-OFF proves this with a golden comparison.

## 5. Phases and gates

Each phase ships only when its gate passes. A failing gate stops the phase; it
does not get worked around.

### Phase 0. Measure (no code in src/)

Write `scripts/bench-get-email.ts` (not run in CI). Against the owner's real
account, record p50 and p95 for: live `getEmail` (headers plus decoded body),
one STATUS on the same mailbox, and `getEmail` with a warm mirror (simulated by
reading the body from SQLite). Run 30 samples each, on one message of each of
three kinds: plain text, multipart/alternative, and HTML with an attachment.

**Gate G0:** the cache is worth building only if STATUS p95 plus local read p95
is at least 3x faster than live `getEmail` p50 for the common case. If not,
stop and report. Do not build the cache for a marginal gain.

Output: a table of measured numbers in the PR description. Do not claim a
speedup that was not measured.

### Phase 1. Schema v2 with explicit migration

- `SCHEMA_VERSION = 2` in `src/cache/schema.ts`.
- `migrate()` in `src/cache/store.ts`: if `user_version === 1`, run
  `ALTER TABLE message ADD COLUMN` for `headers_json`, `body_html`,
  `body_subtype`, `body_attempted_at`; create the `attachment` and
  `email_attachment` tables; set `user_version = 2`. Keep the existing
  "newer version: rebuild" branch.
- New tables (blob index only, bytes live on disk):

```sql
CREATE TABLE IF NOT EXISTS attachment (
  sha256      TEXT PRIMARY KEY,
  size        INTEGER NOT NULL,
  mime_type   TEXT NOT NULL,
  filename    TEXT,
  created_at  INTEGER NOT NULL,
  last_access INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS email_attachment (
  account      TEXT NOT NULL,
  mailbox      TEXT NOT NULL,
  uid          INTEGER NOT NULL,
  uid_validity TEXT NOT NULL,
  part_id      TEXT NOT NULL,
  sha256       TEXT NOT NULL REFERENCES attachment(sha256),
  PRIMARY KEY (account, mailbox, uid, uid_validity, part_id)
);
```

**Tests (must pass):**
- T-MIG1: build a real v1 database with the current `SCHEMA_SQL` and rows,
  open it with new code, assert new columns exist, existing rows survive,
  `user_version === 2`.
- T-MIG2: open a v2 database with new code again; no change.
- T-MIG3: a database with `user_version = 3` is rebuilt as today.
- T-MIG4: migration is one transaction; a failure mid-way leaves v1 intact.

### Phase 2. Complete body storage and read-through

- Extend `CachedMessageInput`/`CachedMessage` with `headers`, `bodyHtml`,
  `bodySubtype`.
- Replace `putBody(account, mailbox, uid, uidValidity, bodyText)` with
  `putBody(..., { text?, html?, subtype, headers })`. No production callers
  exist (E5), so the signature change is safe.
- Add `markBodyAttempted`, `clearBody`, `touchAccess` (U2, U3, U4).
- Implement `MailReadService.getEmail` with the STATUS-probe freshness rule
  (D2), per-key request coalescing (`account\u0000mailbox\u0000uid`), and
  write-back of live results after a successful live read (not before).
- Response carries `source` (D3).

**Tests (must pass):**
- T-GOLD: for a fixture message set (plain, alternative, html-only,
  attachment, folded headers, RFC 2047 subject), the `Email` returned from the
  cache equals the `Email` returned live, field by field, including `headers`,
  `bulk`, `references`, and `attachments`. This is the main correctness proof.
- T-STALE: mailbox UIDVALIDITY changed on the server since the last sync. The
  mirror is not served. Live result is returned and rows for the old epoch are
  not used.
- T-PARTIAL: a row with `body_text` but no `headers_json` is not served.
- T-FAIL: SQLite throws on read. `getEmail` returns the live result and the
  tool output says `source: live`.
- T-OFFLINE: IMAP connect fails and the mirror holds the body. Result is
  `source: mirror-offline`, not an error.
- T-COAL: 20 concurrent `getEmail` calls for one message produce exactly one
  live FETCH.
- T-OFF: with `cache.enabled = false`, output is byte-identical to the current
  live path for the same fixtures.

### Phase 3. Write invalidation

- Emit `email:changed` from `ImapService` after `setFlags`, `moveEmail`,
  `deleteEmail`, and mailbox create/rename/delete (D4).
- Facade and sync engine handle the event: update flags in place, clear body
  for moved or deleted rows, remove deleted rows.

**Tests (must pass):**
- T-INV-FLAG: `setFlags(read)` then `getEmail` shows `seen: true` from the
  mirror in the same process, without waiting for sync.
- T-INV-MOVE: after `moveEmail`, the old `(mailbox, uid)` is not served; the
  new location is fetched live once.
- T-INV-DEL: after `deleteEmail`, `getEmail` returns the live not-found error,
  not a cached copy.
- T-INV-EXT: a flag change made by another client is seen after the next
  STATUS-triggered sync (tested with a fixture that changes HIGHESTMODSEQ).

### Phase 4. Search and thread from the mirror

- `search_emails`: use FTS only when the mailbox state is current (STATUS
  probe passed) and `body_messages` covers the query window. Otherwise live.
  The response says which source answered.
- `get_thread`: use `findByMessageId` only when every member of the thread is
  present in the mirror. Any missing member means live.

**Tests (must pass):**
- T-SEARCH-COVER: partial backfill returns live results, not a short list.
- T-SEARCH-EQ: for a fixture mailbox, FTS results equal live SEARCH results
  for the same query (same set, same order by date).
- T-THREAD-PART: thread with a missing member falls back to live.

### Phase 5. Backfill

- `SyncEngine.backfillBodies(account, mailbox, batchLimit = 25)` inside the
  reconcile loop (D9).
- Dead ends: oversize, decode failure, missing part. Mark attempted; never
  retry.

**Tests (must pass):**
- T-BF-BUDGET: never more than `body_messages` bodies per mailbox.
- T-BF-BATCH: at most 25 fetches per cycle.
- T-BF-ATTEMPT: an attempted-marked row is not refetched on the next cycle.
- T-BF-CANCEL: `stop()` during a batch leaves the store consistent and does not
  throw.
- T-BF-RO: read-only mode performs no server writes (asserted with a spy on
  every write method of the client).

### Phase 6. Attachment store

- `src/cache/blob-store.ts` and `src/cache/maintenance.ts` (D7, D8).
- `downloadAttachment` in the facade: check `email_attachment` for
  `(account, mailbox, uid, uid_validity, part_id)`; on hit, read blob and
  re-hash; on miss, download live and store.

**Tests (must pass):**
- T-BLOB-DEDUP: same bytes under two messages stored once.
- T-BLOB-CORRUPT: a modified blob is detected on read, removed, and reported
  as a miss.
- T-BLOB-PERM: files are created 0600; directories 0700.
- T-BLOB-ATOMIC: a simulated crash between temp write and rename leaves no
  file at the final path.
- T-EVICT-ORDER: over budget, blobs go first, then bodies, then old envelopes;
  envelopes of recent messages are never evicted before bodies.

### Phase 7. Config, docs, and kill switch

- Reuse existing `[settings.cache]` keys: `enabled`, `body_messages`,
  `max_size_mb`, `sync_interval`, `window_days`. Add only
  `attachment_cache = true` if separate control is needed.
- Document in `README.md` and the config template, including: where bodies are
  stored, that the cache is regenerable, and how to disable it.
- Update `SECURITY.md` for locally stored bodies and attachments.

**Tests (must pass):**
- T-CFG: defaults and env overrides load; invalid values rejected.
- T-OFF from Phase 2, re-run after all phases.

## 6. Acceptance criteria

The work is done only when all of these hold, with actual command output
pasted in the PR:

1. `pnpm check`, `pnpm typecheck`, `pnpm build`, `pnpm test` all pass under
   Node 24 (`.nvmrc`).
2. Every test ID above exists and passes.
3. G0 measurement table is present, and the numbers justify the change.
4. Golden test T-GOLD passes for all fixture kinds.
5. T-OFF passes: disabling the cache returns today's output.
6. No cache path returns data without a `source` field.
7. Live `getEmail` is still the fallback for every error path (grep shows no
   `catch` on the read path that returns empty data).
8. Commit history: one concern per commit, conventional messages, path-scoped
   staging, no `git add -A`, no edits to the unrelated `package.json` change.

## 7. Risks

| Risk | Control |
|---|---|
| Migration corrupts a user database | T-MIG1..4; migration in one transaction |
| Stale mail served silently | STATUS probe per read (D2); `source` field (D3) |
| Missed write invalidation | D4; T-INV-* for every write |
| Partial result from a partial mirror | T-SEARCH-COVER, T-THREAD-PART; live fallback |
| Memory growth | 256 KB body cap; batch 25; blob budget |
| Privacy: bodies on disk | 0700/0600; documented; kill switch |
| Cache slower than live | G0 gate |
| Read-only violated by backfill | T-BF-RO |

## 8. Upstream references

Use as design reference only. Do not cherry-pick the branch.

- Fetch: `git fetch https://github.com/codefuturist/email-mcp.git develop`
- Files: `src/cache/blob-store.ts`, `src/cache/maintenance.ts`,
  `src/services/mail-read.service.ts`, `src/cache/sync-engine.ts`
  (`backfillBodies`), `src/cache/store.ts` (`markBodyAttempted`, `clearBody`,
  `touchAccess`)
- Commits: `5012971` (body tier), `8d8111b` (STATUS-validated reads), `358901e`
  (blob store), `3e5f921` (LRU), `e78e832` (completeness and invalidation fixes),
  `0f037ec` (facade)

## 9. Conventions

- TypeScript ESM, Node 24, Biome, Vitest.
- Conventional commits; pre-commit and pre-push hooks run; do not bypass them.
- Path-scoped staging. Never stage the unrelated `package.json` change.
- Report command output, not summaries. "Passes" means the actual run printed
  it.
