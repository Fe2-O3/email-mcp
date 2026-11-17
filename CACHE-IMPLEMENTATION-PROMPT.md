# Cache implementation prompt

Copy the prompt below into a strong cloud coding session when cache work is
approved.

---

You are implementing the deferred body-tier cache for IMAP Wizard, a fork of
`codefuturist/email-mcp`. Work in this repository. Read `AGENTS.md` if present,
then `README.md`, `CONTRIBUTING.md`, and `HANDOFF.md`. The cache risk notes in
`HANDOFF.md` are requirements, not suggestions.

## Goal

Extend the existing SQLite metadata mirror with reliable, bounded local storage
for message bodies and attachments. Preserve live IMAP as the fallback whenever
cached data is missing, stale, incomplete, or unhealthy.

The fork already has a working metadata mirror, scheduler, watcher, email CLI,
and an opt-in on-demand `get_verification_code` tool. Do not rebuild those.
Daemon support is intentionally out of scope.

## Required first step

Before editing:

1. Inspect `src/cache/store.ts`, `src/cache/sync-engine.ts`, the cache tests,
   `ImapService`, email and thread tools, and current config wiring.
2. Fetch and inspect the current upstream `codefuturist/email-mcp` cache code.
   The known v0.6.0 commits are listed in `HANDOFF.md`; verify them against the
   live `develop` branch before using them.
3. Compare the two implementations and write a short design plan covering:
   schema changes, cache freshness, invalidation, disk budgeting, failure
   fallback, and test coverage.
4. Do not begin the implementation until the plan is internally consistent.
   Ask the owner only if the design requires a real product choice.

## Behavior to build

- Cache message bodies after successful live reads; serve a cached body only
  when its mailbox identity and freshness checks pass.
- Add bounded, resumable backfill. Do not fetch an unbounded mailbox into RAM.
- Reuse cached metadata for searches and thread assembly only when completeness
  and freshness can be proved. Otherwise query IMAP.
- Store downloaded attachments by content hash, index useful metadata, and
  enforce the existing configured disk budget with LRU eviction.
- Invalidate or update cached bodies, flags, labels, and attachment references
  after writes, moves, deletes, IDLE events, reconnects, or UIDVALIDITY changes.
- Keep cache failure non-fatal. A corrupt, unwritable, or partial cache must not
  produce a believable but incomplete answer; fall back to live IMAP.
- Keep read-only mode from starting background writes or changing remote mail.
- Preserve mailbox/account isolation. Never key records by a UID alone.
- Avoid logging message bodies, verification codes, credentials, or attachment
  contents.

## Tests that must protect the design

Add tests for cache hits, stale entries, missing bodies, partial backfill,
resume after restart, duplicate concurrent reads, failed IMAP fetches, failed
SQLite writes, disk-budget eviction, attachment hash reuse, moves/deletes,
flag updates, expunge events, reconnects, and UIDVALIDITY changes. Include at
least one tool-level integration test proving that an incomplete cache falls
back to IMAP rather than returning partial results.

## Constraints

- Keep the changes limited to cache behavior and the smallest required config,
  service, and test wiring.
- Do not copy the upstream branch wholesale. The fork has materially different
  lifecycle, security, CLI, and tool code.
- Do not enable daemons, change release publishing, edit unrelated identity or
  package scripts, or remove existing safety checks.
- Run the success checks before committing. Follow the repository's normal
  path-scoped commit and push rules. Never rewrite shared history.
- Use Node 24 from `.nvmrc` and the repository-pinned pnpm version.

## Success checks

Run and report the actual results of:

```bash
pnpm check
pnpm typecheck
pnpm build
pnpm test
```

Before claiming success, review the changed cache paths for silent stale-data
cases and verify that no cache failure can masquerade as a complete result.
