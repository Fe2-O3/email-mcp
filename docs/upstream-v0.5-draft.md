# Draft: adopting upstream v0.5.x features

Status as of 2026-09-28. Source: [codefuturist/email-mcp releases](https://github.com/codefuturist/email-mcp/releases) (v0.4.0, v0.4.1, v0.5.0, v0.5.1 — all shipped 2026-09-26).

This fork stays divergent by design (see README comparison). Three items were
already ported in 0.1.0; the rest are drafted here for a later, deliberate
decision — not a merge.

## Ported in 0.1.0

| Upstream commit | What | Why here |
|---|---|---|
| [`70d4215`](https://github.com/codefuturist/email-mcp/commit/70d4215de07920252f672923cf3cd48aad7a0189) | TLS `servername` repair for IP-literal hosts | Real bug shared with this fork — every IMAP login to an IP address failed before auth |
| [`bf09dcc`](https://github.com/codefuturist/email-mcp/commit/bf09dcc1f087279812fe307647bf8e52198becd8) | `config validate` (syntax, schema, typo did-you-mean, consistency) | Config typos were silently dropped here too; CI-friendly exit codes |
| [`bae1bb7`](https://github.com/codefuturist/email-mcp/commit/bae1bb7e75b8a1e0c9ed0d13b03f24e4e30d4f1f) (v0.4.1) | Full dependency upgrade set | imapflow 2, nodemailer 10, vitest 5, zod 4.6, MCP SDK minors — done with type adaptations and the full suite green |

Also carried over from the same upstream commit: **factory schema defaults**
(zod shared-instance footgun — a mutated defaulted section poisoned later
config loads in the same process).

## Not ported — candidates, ranked

| Priority | Upstream feature | What it gives users | Cost / risk here |
|---|---|---|---|
| 1 | **[settings.server] + server lifecycle commands** (`755eb39` in v0.4.0, `98bc426` in v0.5.0) | Always-on HTTP daemon with start/stop/status + launchd login item | Medium — touches `cli/http.ts`, config schema; this fork's HTTP path already diverged (token rules, body caps) |
| 2 | **CLI startup lazy-loading** (`v0.5.0` `a0f9ca6`, 3.8× faster) | Snappier `email-mcp` invocations | Low — pure refactor of `main.ts` import graph; measurable before/after needed |
| 3 | **Shell completion, zsh/bash/fish** (`v0.5.0` `e0c6563`) | Tab completion for the CLI | Low — additive; must list *this* fork's subcommands (incl. `config validate`) |
| 4 | **Config section editor + field catalog + validated save with backups** (`v0.4.0` `17efd45`, `00d559b`, `c2d0a9d`) | Safer interactive `config edit` | Medium — their `settings-fields.ts` assumes sections this fork doesn't have (server, verification); needs adaptation like `validate` did |
| 5 | **Verification-code catcher** (v0.4.0, 12 commits: OTP extractor, magic links, clipboard, `get_verification_code`) | +3 MCP tools (52 total), instant OTP auto-copy | High — new settings section, clipboard service, watcher integration; the biggest feature delta. Worth it only if the OTP workflow matters here |
| 6 | **Bun single-binary releases + GoReleaser Pro matrix** (`v0.5.0`/`v0.5.1`) | Downloadable binaries per platform with provenance | High/infra — needs release pipeline work and (currently) goreleaser targets upstream's registries; their release workflows were removed from this repo for that reason |
| 7 | **npm/Docker publishing** | `npx @fe2-o3/email-mcp`, ghcr images | Blocked on publishing credentials/decisions — package identity is already renamed, nothing publishes |

## Explicitly out of scope

- **Verification feature's `settings.verification`** unless priority 5 is accepted — `config validate` intentionally skips it.
- **Anything touching open upstream issues**: all 17 issues this fork claims to fix were verified `open` after v0.5.1; upstream's .5 line did not address them.

## Re-evaluate when

- imapflow ships the IP-literal `servername` fix upstream → drop `createImapClient`'s repair (its comment says so).
- A merge is ever considered: 18 files are touched by both sides (README, main.ts, manager.ts, config, watcher, hooks, schemas, register) — this document is the alternative to doing that blind.
