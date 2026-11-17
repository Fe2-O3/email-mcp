# Body cache: implementation brief

Version 4.0.0 · 2026-11-17 · supersedes v3 and the body-cache section of `HANDOFF.md`

This brief is for the model implementing the work. It is self-contained. Every
claim about current code was checked against `main` at `99b03b5`. Where a line
number is given, re-check it before you edit, since earlier phases move code.

---

## 1. What you are building, in one paragraph

`get_email` currently does a mailbox SELECT, one FETCH for envelope, flags,
body structure and headers, and then one or two more round trips to download
the text and HTML parts. You will make a repeat read of the same message cost
**one FETCH of `(UID FLAGS)`** plus a local SQLite read. Everything else about
the message is served from a local copy. The local copy is filled two ways:
write-back after any live read, and a small background backfill of the newest
messages. When the server is unreachable, an already-cached message can still
be read, with a visible warning. All of this sits behind a new
`read_through` setting that defaults to **off**, so merging this changes
nothing for anyone until the owner turns it on.

## 2. The idea that makes this safe

For a given mailbox, the pair `(UIDVALIDITY, UID)` names one message forever.
The envelope, body structure, raw headers, and decoded body parts **cannot
change** for that pair. Only two things can change: the flags, and whether the
message still exists.

So a cache hit does not need a freshness model. Under the mailbox lock:

1. Read `client.mailbox.uidValidity` (free, because SELECT already returned it).
2. Look up the body bundle by `(account, mailbox, uid, uidValidity)`.
3. Run `UID FETCH <uid> (UID FLAGS)`. If it returns nothing, the message is
   gone, so throw the same "not found" error the live path throws. If it
   returns flags, combine them with the cached bundle.

That answer is exactly as fresh as a live read. Because of that, this design
drops several things v3 needed:

| v3 needed | Why it is no longer needed for `get_email` |
|---|---|
| STATUS probe per read | Existence and flags come from the per-message FLAGS fetch |
| `email:changed` write-invalidation events | Flags are always live; a moved or deleted UID fails the FLAGS fetch |
| `ALTER TABLE` migration of `message` | Bodies go in a new table; the existing `migrate()` already creates missing tables |
| A `MailReadService` facade and rewiring 10 callers | The hit path lives inside `ImapService.getEmail`, so every caller benefits unchanged |
| A field-by-field golden test that hopes two paths agree | Both paths call the same pure `assembleEmail()`, so they agree by construction (still tested) |

## 3. Verified current state

| Fact | Where |
|---|---|
| Mirror is `node:sqlite`, table `message`, watermarks in `mailbox_state`, `SCHEMA_VERSION = 1` | `src/cache/schema.ts` |
| `message.body_text` and `putBody()` exist, but production never calls `putBody`, so `body_text` is NULL on every user database | `src/cache/store.ts` (`putBody`) |
| `putBody` is an `UPDATE`, so it silently does nothing for messages in mailboxes the sync engine does not mirror (everything except `INBOX` by default) | `src/cache/store.ts` |
| `migrate()` runs `SCHEMA_SQL` (all `CREATE ... IF NOT EXISTS`) on every open, so **new tables and indexes are added to old databases automatically**; new columns on existing tables are not | `src/cache/store.ts` (`migrate`) |
| The FTS update trigger fires on **every** `UPDATE` of `message`, including flag-only resyncs, so it reindexes subject, sender and body for every flag change | `src/cache/schema.ts` (`message_fts_update`) |
| Cache is on by default (`enabled = true`, `INBOX`, 90 days, 500 MB). `body_messages = 500` exists and is unused | `src/config/schema.ts` (`CacheConfigSchema`) |
| `getEmail` = lock, `fetchOne` (uid, envelope, flags, bodyStructure, headers), then `messageToEmail()` downloads up to two text parts | `src/services/imap.service.ts` (`getEmail`, `messageToEmail`) |
| `messageToEmail` output depends only on envelope, flags, bodyStructure, raw header bytes, and the two decoded parts | same file |
| `downloadPart` swallows errors and returns `undefined`, so a transient failure produces an empty body | same file (`downloadPart` inside `messageToEmail`) |
| Every ImapFlow fetch, including `download()`, uses `BODY.PEEK`/`BINARY.PEEK`, so nothing here sets `\Seen` | `imapflow@2.0.8` `dist/cjs/commands/fetch.js` |
| `getEmail` callers: `get_email` and `get_emails` tools, CLI `read`, reply and forward in `smtp.service`, hooks, verification lookup, calendar tools, `fetchDraft` | `grep -rn "getEmail(" src` |
| The sync engine keys rows by the configured mailbox string; `getEmail` keys by `sanitizeMailboxName(mailbox)` | `src/cache/sync-engine.ts`, `src/services/imap.service.ts` |
| No connectivity-error classifier exists anywhere in `src/` | `grep -rn ECONNREFUSED src` returns nothing |
| In read-only mode `startBackgroundServices` returns early, so no sync and no backfill runs | `src/app.ts` |

## 4. Design

### 4.1 Schema v2: one new table

Add to `SCHEMA_SQL` and bump `SCHEMA_VERSION` to `2`:

```sql
-- Immutable per (uid, uid_validity): everything getEmail derives its output
-- from except flags. Independent of `message`, so write-back works for any
-- mailbox, mirrored or not.
CREATE TABLE IF NOT EXISTS message_body (
  account             TEXT    NOT NULL,
  mailbox             TEXT    NOT NULL,
  uid                 INTEGER NOT NULL,
  uid_validity        TEXT    NOT NULL,
  status              TEXT    NOT NULL,      -- 'ok' | 'skipped'
  skip_reason         TEXT,                  -- 'oversize' | 'incomplete' | 'error'
  extractor_version   INTEGER NOT NULL,
  envelope_json       TEXT,
  body_structure_json TEXT,
  headers_raw         TEXT,
  body_text           TEXT,
  body_html           TEXT,
  bytes               INTEGER NOT NULL DEFAULT 0,
  fetched_at          INTEGER NOT NULL,
  accessed_at         INTEGER NOT NULL,
  PRIMARY KEY (account, mailbox, uid, uid_validity)
);

CREATE INDEX IF NOT EXISTS idx_message_body_lru ON message_body (accessed_at);

-- A message leaving the mirror (expunge, retention prune, epoch reset) takes
-- its body with it.
CREATE TRIGGER IF NOT EXISTS message_body_gc AFTER DELETE ON message BEGIN
  DELETE FROM message_body
  WHERE account = old.account AND mailbox = old.mailbox
    AND uid = old.uid AND uid_validity = old.uid_validity;
END;
```

Migration:

- The new table, index and trigger are created by the existing
  `this.db.exec(SCHEMA_SQL)` on any v1 database. **Do not add `ALTER TABLE`.**
- Add one ordered step that runs only when upgrading from `user_version < 2`,
  inside a transaction: replace the FTS update trigger so it fires only when
  indexed columns change.

  ```sql
  DROP TRIGGER IF EXISTS message_fts_update;
  CREATE TRIGGER message_fts_update AFTER UPDATE OF subject, from_text, body_text ON message BEGIN
    ...same body as today...
  END;
  ```

  Change the trigger in `SCHEMA_SQL` the same way, so new databases get it
  too. Structure the step as a small `MIGRATIONS: Array<{ to: number; sql: string }>`
  run in order, so v3 has somewhere to go.
- If any migration step throws, roll back, then fall through to the existing
  "drop and rebuild" path. The mirror can be regenerated, so a failed migration
  must never stop startup.
- The "newer version: rebuild" branch must also drop `message_body`.
- `resetEpoch()` must also `DELETE FROM message_body WHERE account = ? AND mailbox = ? AND uid_validity <> ?`,
  because bodies for UIDs that have no `message` row are not reached by the trigger.
- `clear()` must also clear `message_body`.
- Leave `message.body_text` and `putBody()` in place but unused. Note that in
  a comment. Removing a column is a migration with no payoff.

`extractor_version` is a constant `BODY_EXTRACTOR_VERSION = 1` exported from
the assembly module. Bump it whenever the way a body is extracted or decoded
changes, for example `selectBodyPart`, `collectTextParts`, or charset handling.
Rows with an older version are misses. This stops a decoding bug from being
served from cache forever after it is fixed. This repo has fixed body decoding
several times.

### 4.2 Split `messageToEmail` into I/O and a pure assembler

In `src/services/imap.service.ts`:

```ts
export const BODY_EXTRACTOR_VERSION = 1;
export const MAX_CACHED_BODY_BYTES = 256 * 1024;

/** Everything getEmail's output derives from except flags. Immutable per (uidValidity, uid). */
export interface BodyBundle {
  envelope: unknown;          // as ImapFlow returned it
  bodyStructure: unknown;
  headersRaw: string;         // msg.headers.toString('utf-8'), exactly as the live path decodes it
  bodyText?: string;
  bodyHtml?: string;
  /** False when any part that should have downloaded did not. Never cache an incomplete bundle. */
  complete: boolean;
}

export async function fetchBodyBundle(msg: Record<string, unknown>, client: ImapFlow, uid: number): Promise<BodyBundle>;
export function assembleEmail(bundle: BodyBundle, flags: Iterable<string>, uid: number): Email;
```

- `fetchBodyBundle` contains today's part selection and download logic,
  unchanged. Set `complete = false` when a part was selected for download and
  `downloadPart` returned `undefined`.
- `assembleEmail` contains today's object construction. Rebuild the `msg`
  record that `messageToEmailMeta` expects:
  `{ uid, envelope, flags: new Set(flags), headers: Buffer.from(headersRaw, 'utf-8'), bodyStructure }`.
- `messageToEmail(msg, client, uid)` becomes
  `assembleEmail(await fetchBodyBundle(msg, client, uid), msg.flags, uid)`.
  Check every existing caller still compiles and behaves the same.

**Envelope round-trip:** the cached envelope goes through `JSON.stringify` and
`JSON.parse`, so `envelope.date` comes back as an ISO string instead of a
`Date`. `messageToEmailMeta` already does `new Date(envelope.date)`, so that is
fine. The golden test must assemble from a JSON round-tripped bundle to prove
it.

Commit this refactor on its own with no behavior change. All existing tests
must pass unchanged before you go further.

### 4.3 Store API

Add to `CacheStore`:

```ts
interface BodyRow { status: 'ok' | 'skipped'; skipReason?: string; extractorVersion: number; bundle?: Omit<BodyBundle, 'complete'>; fetchedAt: number; }

getBody(account, mailbox, uid, uidValidity): BodyRow | undefined
putBodyBundle(account, mailbox, uid, uidValidity, bundle: Omit<BodyBundle, 'complete'>, extractorVersion): void
markBodySkipped(account, mailbox, uid, uidValidity, reason, extractorVersion): void
touchBody(account, mailbox, uid, uidValidity): void      // sets accessed_at; skip the write if accessed_at is newer than 1 hour
forgetBodies(account, mailbox, uids: number[]): void      // all generations
findBodyAnyGeneration(account, mailbox, uid): (BodyRow & { uidValidity: string }) | undefined   // offline path, see 4.6
listUidsMissingBody(account, mailbox, uidValidity, limit, extractorVersion): number[]   // newest internal_date first, from `message` LEFT JOIN `message_body`
bodyBytes(): number                                       // SUM(bytes) WHERE status='ok'
evictBodiesLru(limitRows: number): number
```

`bytes` = UTF-8 byte length of `headers_raw` + `body_text` + `body_html`.

### 4.4 The read path inside `ImapService.getEmail`

Inject the cache through a narrow port, so `ImapService` does not depend on
SQLite and a missing cache leaves today's code path untouched:

```ts
export interface BodyCachePort {
  get(account: string, mailbox: string, uid: number, uidValidity: string): BodyBundle | undefined; // ok + current extractor only; touches accessed_at
  put(account: string, mailbox: string, uid: number, uidValidity: string, bundle: BodyBundle): void; // decides ok / skipped(oversize|incomplete)
  forget(account: string, mailbox: string, uids: number[]): void;
  getOffline(account: string, mailbox: string, uid: number): { bundle: BodyBundle; flags: string[]; cachedAt: number } | undefined;
}
```

Put the implementation in `src/cache/body-cache.ts`. It wraps `CacheStore`,
and **every method catches all errors and degrades to a miss or no-op**. The
cache must never turn a working read into a failure.

`ImapService` gets `attachBodyCache(port, { offlineReads: boolean })`. In
`src/app.ts`, call it only when `cache.enabled && cache.read_through` and the
store opened successfully.

`getEmail(account, emailId, mailbox)`:

```
uid = parseInt(emailId); safeMailbox = sanitizeMailboxName(mailbox)
client = await getImapClient(account)          -- connectivity error → offline path (4.6)
lock   = await client.getMailboxLock(safeMailbox)   -- connectivity error → offline path
try:
  uidValidity = client.mailbox?.uidValidity?.toString()
  if cache && uidValidity:
    bundle = cache.get(account, safeMailbox, uid, uidValidity)
    if bundle:
      m = await client.fetchOne(String(uid), { uid: true, flags: true }, { uid: true })
      if !m: throw new Error(`Email ${emailId} not found in ${mailbox}`)   -- identical to live
      return assembleEmail(bundle, m.flags, uid)
  ...existing live fetchOne...
  bundle = await fetchBodyBundle(msg, client, uid)
  email  = assembleEmail(bundle, msg.flags, uid)
  if cache && uidValidity: cache.put(account, safeMailbox, uid, uidValidity, bundle)   -- after success, never before
  return email
finally: lock.release()
```

Rules:

- **Key on `safeMailbox`** everywhere: read, write, backfill. Make the sync
  engine and backfill sanitize the configured mailbox the same way, or
  backfilled rows will never be hit.
- `put` stores `status='skipped', skip_reason='incomplete'` when
  `bundle.complete` is false. The read path treats skipped rows as misses, so
  the next read retries live. Backfill does not retry skipped rows.
- `put` stores `skipped/oversize` with no content when `bytes > MAX_CACHED_BODY_BYTES`.
  Never truncate. A truncated body would differ from the live answer.
- No request coalescing. Not measured as a need.

### 4.5 Write hygiene (not correctness)

After a successful `deleteEmail`, `moveEmail`, `bulkDelete`, or `bulkMove`,
call `cache.forget(account, sourceMailbox, uids)`. This only frees space early.
Correctness does not depend on it, because the FLAGS fetch already detects a
missing UID. Do not add an `email:changed` event.

### 4.6 Offline reads

Only for `getEmail`, and only when `offlineReads` is on.

- Add `isConnectivityError(err): boolean` in `src/utils/imap-error.ts`. It
  returns true for Node socket and DNS codes (`ECONNREFUSED`, `ECONNRESET`,
  `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`, `ENOTFOUND`, `EAI_AGAIN`,
  `EPIPE`) and for ImapFlow connection-closed or `NoConnection` errors, walking
  `err.cause`. Auth failures, "not found", and permission errors return
  **false**. Unit-test each case.
- Use it only around `getImapClient` and `getMailboxLock`. Any other error
  propagates as today.
- `getOffline` picks the generation from `mailbox_state.uid_validity` if that
  row exists. Otherwise it uses the single `message_body` row for that UID. If
  more than one generation exists and `mailbox_state` cannot decide, it is a
  miss. Flags come from the matching `message` row if one exists, otherwise `[]`.
- Return the assembled `Email` with a new optional field
  `offline?: { cachedAt: string }` on the `Email` type in `src/types/index.ts`.
  On a miss, rethrow the original error.
- `get_email`, `get_emails`, and CLI `read` print one line when `offline` is
  set: `⚠ Offline: served from local cache (cached <ISO>). Flags may be stale and the message may have been moved or deleted.`
  `markRead` on an offline result must fail with the original connectivity
  error, not silently do nothing.

### 4.7 Backfill

`SyncEngine.backfillBodies(account, mailbox, signal)`, called by `runSync`
after a successful reconcile when read-through is on:

- `uids = store.listUidsMissingBody(account, safeMailbox, uidValidity, batch, BODY_EXTRACTOR_VERSION)`,
  restricted to the newest `body_messages` rows by `internal_date`. Default
  batch is 25 per sync cycle.
- **One message at a time, taking and releasing the mailbox lock per
  message.** Tool calls share the connection. Holding the lock for 25
  downloads would stall `get_email` for seconds.
- Per message: lock, then `fetchOne(uid, { uid, envelope, bodyStructure, headers })`,
  then `fetchBodyBundle`, then `cache.put`, then release. If the UID is gone,
  skip it. On error, `markBodySkipped('error')` and continue. Never throw out
  of backfill.
- Check `signal.aborted` between messages. `SyncEngine.stop()` aborts it.
- Stop the cycle early when `bodyBytes()` reaches the body budget.
- Needs `ImapFlow` and the exported `fetchBodyBundle`. Import it from
  `../services/imap.service.js`. Do not duplicate the extraction logic.

### 4.8 Budget

- New `body_max_mb`, default 200. After backfill and after `put`, if
  `bodyBytes()` exceeds it, call `evictBodiesLru(500)` until under budget,
  bounded to 10 rounds per call.
- The existing `max_size_mb` backstop in `enforceRetention` must evict bodies
  (LRU) **before** pruning `message` rows. Only prune messages when no `ok`
  bodies remain.
- `evictBodiesLru` deletes the oldest `accessed_at` rows. Skipped rows are
  tiny, but evict them too, oldest first, so they cannot pile up.

### 4.9 Config

In `CacheConfigSchema` (`src/config/schema.ts`), the loader mapping
(`src/config/loader.ts`, follow the `window_days` → `windowDays` pattern
including the env var), the config template in `loader.ts`, the `config
validate` known-keys list, and README:

| key | default | meaning |
|---|---|---|
| `read_through` | `false` | Serve repeat `get_email` reads from the local body cache and write bodies back. Off means today's behavior exactly. |
| `offline_reads` | `true` | When `read_through` is on and the server is unreachable, serve cached bodies with a warning. |
| `body_max_mb` | `200` | LRU budget for cached bodies, inside `max_size_mb`. |
| `body_messages` | `500` (existing) | Backfill bodies for the newest N messages per synced mailbox. `0` disables backfill. |

Read-only mode: write-back is a local write, so it stays allowed. Backfill
never runs in read-only mode, because background services do not start.
Document both.

`SECURITY.md`: when `read_through` is on, decoded message bodies and raw
headers are stored in the mirror (`CACHE_DB` in `src/config/xdg.ts`, normally `~/.cache/email-mcp/cache.db`) at `0600`
inside a `0700` directory. There is no `cache clear` CLI command. Document
deleting the file while the server is stopped. Do not add a command in this
change.

## 5. Explicitly not in this change

| Deferred | Why | What would unlock it |
|---|---|---|
| `search_emails` from FTS | Needs a mailbox-wide freshness proof (STATUS: UIDNEXT, MESSAGES, HIGHESTMODSEQ). Baseline-tier servers cannot detect flag changes that way. FTS only covers the 90-day mirrored window, so results would silently differ from live | A G1 measurement of live search latency, plus a coverage rule ("mirror covers the query's date range") |
| `get_thread` from `findByMessageId` | A partial mirror returns partial threads. Proving completeness needs the same mailbox-wide proof | Same as above |
| `list_emails` from mirror | Same freshness problem for flags and unseen counts | Same as above |
| Attachment blob store | Downloads are explicit and rare. A content-addressed store with re-hash, temp-rename and LRU is a separate module with its own risks | A measured need: repeated large downloads |
| Request coalescing, `MailReadService` facade, `email:changed` events | Not needed by the per-message design | — |
| Removing `message.body_text`/`putBody` | Pure churn | Next schema change that touches `message` anyway |

Do not build any of these. If you find you need one, stop and say so in your
report.

## 6. Phases and commits

Each phase is one or two conventional commits. Each must leave `pnpm check`,
`pnpm typecheck`, `pnpm build`, and `pnpm test` green.

| # | Commit(s) | Content | Exit test |
|---|---|---|---|
| P1 | `refactor(imap): split messageToEmail into fetchBodyBundle and assembleEmail` | 4.2. No behavior change | Existing suite green, no test edits needed |
| P2 | `feat(cache): schema v2 message_body table and FTS trigger fix` | 4.1, 4.3 | Store tests below |
| P3 | `feat(cache): read-through and write-back for get_email` | 4.4, 4.5, `body-cache.ts`, config keys, app wiring | Read-path tests below |
| P4 | `feat(cache): offline reads for cached messages` | 4.6 | Offline tests below |
| P5 | `feat(cache): bounded body backfill and LRU budget` | 4.7, 4.8 | Backfill tests below |
| P6 | `docs(cache): document read_through, budget, offline, security` | README, SECURITY.md, config template, CHANGELOG `Unreleased` | — |

## 7. Tests (names are suggestions; behaviors are required)

`src/cache/store.test.ts`
- v1 file → open → `message_body` exists, `user_version = 2`, existing `message` rows intact (build the v1 file with the v1 SQL inline in the test)
- re-open v2 is idempotent
- newer `user_version` → rebuild drops `message_body` too
- migration step failure → rebuild, store still opens
- FTS: updating only `flags_json` does not touch `message_fts` (assert via `message_fts` row count or `'integrity-check'` plus a search that still matches)
- deleting a `message` row deletes its `message_body` (trigger)
- `resetEpoch` deletes bodies of other generations, including UIDs with no `message` row
- `listUidsMissingBody` newest-first, excludes ok and skipped, includes stale `extractor_version`
- `evictBodiesLru` order; `touchBody` 1-hour throttle

`src/services/imap.service.test.ts` (or a new `email-assembly.test.ts`)
- **golden**: for fixtures (single-part plain; multipart/alternative; HTML-only; stub-plain + big-HTML; attachment + text; folded `References`; missing date), `assembleEmail(JSON-roundtrip(bundle), flags)` deep-equals `messageToEmail` live output with the same mocked client
- `complete=false` when a selected part's download throws

`src/cache/body-cache.test.ts`
- oversize → skipped, `get` misses
- incomplete → skipped, `get` misses
- stale `extractor_version` → miss
- store throws (close the db first) → `get` returns undefined, `put` no-ops, no throw

`ImapService.getEmail` with a mocked client plus real in-memory `CacheStore`
- miss → live → written back; second call → hit, `download` not called, `fetchOne` called with `{ uid, flags }` only
- hit, but FLAGS fetch returns nothing → throws the same not-found message as live
- hit returns **current** flags (change mocked flags between calls)
- UIDVALIDITY changed between calls → miss
- no port attached (`read_through=false`) → identical calls to today (assert mock call log)
- mailbox `" INBOX "` (whitespace) is keyed as `INBOX`, so it hits rows written by backfill

Offline (`src/utils/imap-error.test.ts` + `getEmail`)
- classifier truth table, including `cause` chains and auth error → false
- `getImapClient` rejects with `ECONNREFUSED`, cached → `offline` set, flags from `message` row
- same, not cached → original error rethrown
- auth error, cached → error rethrown (no offline)
- `offline_reads=false` → error rethrown

`src/cache/sync-engine.test.ts`
- backfill fetches at most `batch`, newest first, only within `body_messages`
- lock acquired and released per message (count lock calls)
- vanished UID skipped; per-message error → skipped/error, loop continues, sync result still ok
- abort between messages stops further fetches
- stops at body budget
- `read_through=false` → no backfill calls

`src/main.lifecycle.test.ts`
- shutdown during backfill: no further fetches after `stop()`, store closes cleanly

Integration (`src/__integration__/cache-read.integration.test.ts`, GreenMail, runs in CI via `pnpm test:integration`)
- seed multipart and plain messages; `read_through` on; read twice; second read equals first exactly
- set `\Flagged` via `setFlags` between reads → second read shows it
- delete message, read → not found
- unseen count unchanged after reads and backfill (PEEK)

## 8. G0: measure before turning it on

The flag defaults off, so G0 gates **enabling** the feature, not merging it.
The owner runs this on their real account (Node 24), before and after the
change:

```bash
pnpm exec tsx scripts/bench-get-email.ts
```

It prints a markdown table: live `getEmail` p50/p95, the hit path (lock plus
`UID FETCH FLAGS` plus local bundle read), STATUS for reference, bundle sizes,
and the share over the 256 KB cap. **PASS** = live p50 ≥ 2 × hit p95 **and**
p50 saving ≥ 50 ms. Paste the output into §10 of this file. If it fails, leave
`read_through` off and record why.

The script has been typechecked and lint-checked against the current tree. It
has not been run against a live server.

## 9. Ground rules for the implementer

- Node 24 is the target (`.nvmrc`). Node 22.13 or later also runs `node:sqlite`
  unflagged, and the suite is known to pass on 22.23.
- Commands: `pnpm install --frozen-lockfile`, `pnpm check`, `pnpm typecheck`,
  `pnpm build`, `pnpm test`. Lefthook runs biome and typecheck on commit and
  the full suite on push. Do not bypass hooks.
- Stage explicit paths only. Never `git add -A`.
- Do not change behavior when `read_through` is false. The "no port attached"
  test is the guard.
- Do not touch the sync tier logic, the deletion-reconcile safety check, or
  `idle_exit`.
- Do not copy upstream (`codefuturist/email-mcp`) cache code. The upstream
  design is facade plus STATUS-based. This one is not.
- Comments explain why, not what, matching the existing style in
  `src/cache/*.ts`.
- If a step here contradicts the code you find, trust the code, do the
  smallest correct thing, and list the discrepancy in your final report.
- Final report: commits (SHA and subject), test count before and after, any
  deviation from this brief and the reason.

## 10. G0 results

_Not yet run. Paste `scripts/bench-get-email.ts` output here._
