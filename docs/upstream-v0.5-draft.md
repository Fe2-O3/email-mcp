# Draft: adopting upstream v0.5.x features

Status as of 2026-09-28. Source: [codefuturist/email-mcp releases](https://github.com/codefuturist/email-mcp/releases) (v0.4.0, v0.4.1, v0.5.0, v0.5.1 — all shipped 2026-09-26, 14:00 to 16:29 UTC).

This fork stays divergent by design (see README comparison). Three items were
already ported in 0.1.0; the rest were decided on 2026-09-28 — not a merge.

## Ported in 0.1.0

| Upstream commit | What | Why here |
|---|---|---|
| [`70d4215`](https://github.com/codefuturist/email-mcp/commit/70d4215de07920252f672923cf3cd48aad7a0189) | TLS `servername` repair for IP-literal hosts | Real bug shared with this fork — every IMAP login to an IP address failed before auth |
| [`bf09dcc`](https://github.com/codefuturist/email-mcp/commit/bf09dcc1f087279812fe307647bf8e52198becd8) | `config validate` (syntax, schema, typo did-you-mean, consistency) | Config typos were silently dropped here too; CI-friendly exit codes |
| [`bae1bb7`](https://github.com/codefuturist/email-mcp/commit/bae1bb7e75b8a1e0c9ed0d13b03f24e4e30d4f1f) (v0.4.1) | Full dependency upgrade set | imapflow 2, nodemailer 10, vitest 5, zod 4.6, MCP SDK minors — done with type adaptations and the full suite green |

Also carried over from the same upstream commit: **factory schema defaults**
(zod shared-instance footgun — a mutated defaulted section poisoned later
config loads in the same process).

## Decisions on the rest (2026-09-28)

| Priority | Upstream feature | Call | Reasoning |
|---|---|---|---|
| 1 | **CLI startup lazy-loading** (`a0f9ca6`, 3.8× faster) | **Adopt next** | Pure refactor of `main.ts`'s import graph. Upside is felt on every single command. The one failure mode is a missed import, which the test suite would catch immediately. Measure startup before and after so the 3.8× claim is ours, not inherited. |
| 2 | **Shell completion, zsh/bash/fish** (`e0c6563`) | **Adopt next** | Additive, small, and it removes the exact class of error `config validate` exists to catch (a mistyped subcommand). Upstream's completion list must be replaced with this fork's, and a test should compare the list against `main.ts` so it cannot rot. |
| 3 | **Config section editor + field catalog + validated save with backups** (`17efd45`, `00d559b`, `c2d0a9d`) | **Hold** | Half the value already exists: `config validate` gives typo detection, schema checking, and consistency warnings without a terminal UI. Their field catalog assumes `server` and `verification` sections this fork does not have, and knows nothing about `keychain`, `idle_exit`, or `password_command`. Revisit if the interactive editor is ever worth 20+ settings of catalog upkeep. |
| 4 | **Verification-code catcher** (v0.4.0, 12 commits: OTP extractor, magic links, clipboard, `get_verification_code`) | **Not adopted** | It ships **on by default** upstream — `enabled: true`, `auto_copy: true`, `confirm_copy: false` in `src/config/schema.ts` — and `src/services/clipboard.service.ts` runs `pbpaste` to read the clipboard. Useful for someone logging into sites from a chat assistant; this fork does not need it, and clipboard access belongs outside a mail server. Not wanted, so no follow-up. |
| 5 | **[settings.server] + server lifecycle commands** (`755eb39` v0.4.0, `98bc426` v0.5.0) | **Not adopted** | `email-mcp http` already serves Streamable HTTP on demand, and the 30-minute idle exit prevents the orphan process an always-on daemon would create. A launchd login item means a supervisor that must be trusted, upgraded, and debugged for the life of the install. |
| 6 | **Bun single-binary releases + GoReleaser Pro matrix** (v0.5.0 `7ba90a5`, `7ddc0dc`; v0.5.1) | **Not adopted** | Real engineering, aimed at distribution this fork does not want. The pipeline's targets are upstream's registries, their release workflows were removed from this repo for that reason, and provenance signing is a supply-chain commitment to maintain. Tagged source releases plus CI are enough. |
| 7 | **npm / Docker publishing** | **Not adopted** | No package or image is published for this fork; releases are tagged source so the audit surface stays "clone, build, run". Publishing under our name is a decision to revisit, not a build to inherit. |

## Explicitly out of scope

- **Verification entirely** — because priority 4 was declined, `config validate`
  intentionally knows nothing about `settings.verification`.
- **Anything touching open upstream issues**: all 17 issues this fork claims to fix
  were verified `open` after v0.5.1; upstream's .5 line did not address them.

## Re-evaluate when

- imapflow ships the IP-literal `servername` fix upstream → drop `createImapClient`'s
  repair (its comment says so).
- The two "adopt next" items land in a release → move them into the ported table
  with their upstream commit and a measured before/after number.
- A merge is ever considered: 18 files are touched by both sides (README, main.ts,
  manager.ts, config, watcher, hooks, schemas, register) — this document is the
  alternative to doing that blind.
