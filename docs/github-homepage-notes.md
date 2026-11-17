# GitHub homepage notes

Suggestions for the repository page. Nothing here has been applied to GitHub.
Counts were taken from the source on 2026-11-17 (branch `cache-local-continue`).

## About blurb

Suggested (under GitHub's 350-character limit):

> Local MCP server that gives AI assistants your email over plain IMAP and SMTP.
> 50 tools, read-only mode, reads never mark mail as read. Fork of
> codefuturist/email-mcp with open upstream bugs fixed.

Website field: leave empty, or link the latest release.

## Topics

`mcp` `mcp-server` `model-context-protocol` `email` `imap` `smtp` `imap-client`
`ai-tools` `llm` `claude` `typescript` `nodejs` `email-automation` `self-hosted`

(GitHub allows up to 20 topics; lowercase, hyphens only.)

## Counts behind the README

| Item | Count | How it was counted |
|---|---|---|
| Tools | 50 + 1 opt-in | `server.registerTool(` names in `src/tools/*.tool.ts`; `get_verification_code` only when `settings.verification.enabled` |
| Read-only mode tools | 25 | Tools registered outside the `if (!readOnly)` blocks in `src/tools/register.ts`, `calendar.tool.ts`, `watcher.tool.ts`, `templates.tool.ts` |
| Prompts | 7 | `server.registerPrompt(` in `src/prompts/` |
| Resources | 6 | `server.registerResource(` in `src/resources/` |
| Unit tests | 583 in 67 files, all passing | `pnpm test` on 2026-11-17 (Node 22.23.1) |
| Upstream issues fixed | 18 | Issue numbers in the fix table; all reported OPEN by `gh issue view` on 2026-11-17 |

The old README said 49 tools. It missed `list_events` and `list_reminders`
and did not list them in the tool table. The banner and architecture SVGs were
updated to the new numbers.

## Things to fix before going public (not changed here)

1. **`email-mcp install` launches upstream.** Its `npx`, `pnpm dlx` and global
   options write `@codefuturist/email-mcp` into client configs
   (`src/cli/install-commands.ts`). The README warns users to pick "Direct
   node", but the source should change.
2. **`smithery.yaml` runs upstream's package.** `commandFunction` uses
   `npx -y @codefuturist/email-mcp`. That is not this fork.
3. **`server.json` names an npm package that does not exist.** `npm view
   @fe2-o3/email-mcp` returns 404. The registry entry will not install until a
   package is published or the entry is changed. Its description was updated
   to 97 characters (the old one was 118; the MCP registry schema is believed
   to cap descriptions at 100, not checked against the live schema).
4. **Issues are disabled** on `Fe2-O3/email-mcp`, but `package.json`
   `bugs.url` points to its Issues page. Enable Issues, or point `bugs.url`
   elsewhere.
5. **Docker metadata still says upstream.** `Dockerfile` labels, the
   `docker:build` script and `.goreleaser.yaml` image names point at
   codefuturist or other registries, and the label still says 49 tools. No
   image is published for this fork.
6. **CI uses upstream's shared workflows** (`codefuturist/shared-workflows`)
   and a `codefuturist/email-mcp:ci` image tag.
7. **Repo name.** README links use `Fe2-O3/email-mcp`. If the public repo will
   have a different name (for example `imap-wizard`), update the links,
   badges, `package.json` `repository`/`homepage`, and `server.json`.
8. **`glama.json`** holds only the maintainer list; no description to update.

## Not verified by this pass

- The 64k-message mailbox test and the Hostinger timeout figure (from the
  CHANGELOG; no way to re-run here). The README now avoids exact numbers for it.
- The body-cache benchmark (174 ms vs 714 ms p50) comes from
  `CACHE-IMPLEMENTATION-PROMPT.md` section 10, one run on one account. Not
  re-run.
- That `BODY.PEEK` is used on every fetch path. It is stated in the
  `get_email` tool description and server instructions and matches imapflow's
  default; the G0 run also recorded unchanged unseen counts. No packet capture
  was taken.
- Client config formats for Cursor, VS Code, Codex and OpenCode were carried
  over from the old README, not re-tested.
- Whether upstream v0.6.0 has fixed any listed bug without closing its issue.
