# Server-side mail filter rules (Sieve): plan

Status: approved 2026-11-18. Implemented 2026-11-17 on the
`cache-local-continue` branch (not released). See "Implementation notes" at
the end. The Dovecot integration test has not run yet (no Docker locally); it
runs in CI.

## Will it work everywhere?

No. Sieve rules are managed over ManageSieve (RFC 5804, usually port 4190), a
separate protocol from IMAP. Most large consumer providers do not offer it.

| Provider | ManageSieve | Evidence (2026-11-17) | What we do instead |
|---|---|---|---|
| Self-hosted Dovecot (Pigeonhole), Cyrus | Yes, usually | Standard setup | Sieve tools |
| Mailbox.org | Yes | Port 4190 greeting: Dovecot Pigeonhole, STARTTLS | Sieve tools |
| Migadu | Yes | Greeting: "Sora ManageSieve Proxy", STARTTLS | Sieve tools |
| Purelymail | Yes | Greeting: "Apache ManageSieve", STARTTLS | Sieve tools |
| IONOS | Yes | Greeting: "NEMESIS ManageSieved", STARTTLS | Sieve tools |
| Hostinger | Unclear | Port open from one network, reset before greeting from another | Verify with a real login first |
| Gmail | No | Port closed | Local rules; later the Gmail filters API (needs a new OAuth scope) |
| Outlook / Microsoft 365 | No | Port closed | Local rules; later Microsoft Graph inbox rules (new token) |
| iCloud, Yahoo, Zoho, GoDaddy | No | Port closed | Local rules |
| Fastmail | No ManageSieve | Port closed; Sieve only in its web UI | Local rules; JMAP Sieve (RFC 9661) unverified |
| Proton (Bridge) | No | Sieve only in the web app | Local rules |
| Posteo, Runbox, Strato | No public port found | Port closed | Local rules |

So the feature has two layers:

1. **Sieve tools** for servers that support ManageSieve. Rules run on the
   server, even when this app is not running.
2. **Local rules** for everyone else, run by our existing watcher and hooks
   (`src/services/hooks.service.ts` static rules). These only run while the
   server process is running.

## Tools

Shown only for accounts that have Sieve available (config `sieve` block, or
capability detection succeeds). Everyone else gets a plain "this provider has no
server-side rules; use local rules" answer from `sieve_status`.

| Tool | Kind | Notes |
|---|---|---|
| `sieve_status` | read | Capabilities, extensions, scripts, which is active, or "not supported" |
| `sieve_list_scripts` | read | |
| `sieve_get_script` | read | Script text wrapped as untrusted content |
| `sieve_check_script` | read | Server `CHECKSCRIPT` when supported, plus our own risky-action scan |
| `sieve_put_script` | write | Preview by default: diff against current + risky actions. Backup first when replacing the active script |
| `sieve_activate_script` | write | Preview first; backup always; empty name (disable all) needs explicit `disableAll: true` |
| `sieve_delete_script` | write | Refuses the active script; timestamped backup before delete |

All write tools are hidden in read-only mode and only exist in the `full`
toolset.

## Safety rules (the important part)

A silent forwarding rule is the worst thing this feature could create: it leaks
every future email, forever, with no visible sign. The model can be steered by
the content of an email, so a `confirm: true` argument is not protection.

- **`redirect` is blocked** unless the target address or domain is listed by a
  human in the config file (`sieve.allowed_redirects`). No tool argument can
  unlock it.
- **Also risky, shown in every preview:** `vacation` (sends auto-replies),
  `reject`, `discard`, `notify`, `include`, `fileinto` to a folder that does not
  exist.
- The risky-action scan works on the script with comments and quoted strings
  removed. False alarms are acceptable; misses are not.
- **Saving over the active script makes it live immediately** (RFC 5804). The
  put tool says so, previews by default, and always backs up first. Mailoo's
  version claims it "does not activate", which is wrong for the active script.
- Backups are new scripts named `imapwiz-backup-<timestamp>-<name>`, kept until
  the user deletes them.
- Every write is written to the audit log with the full diff.

## Transport

- STARTTLS required with full certificate checks, or implicit TLS where a
  provider documents it. Never send credentials over plain text (same rule as
  the new login guard).
- SASL PLAIN with the account's IMAP credentials by default; OAUTHBEARER /
  XOAUTH2 when the account uses OAuth and the server advertises it.
- Read multi-line `NO` responses fully, so a server's syntax error reaches the
  user (Mailoo stops early).
- Timeouts on connect and every command.

## Starting point

Mailoo has a working ManageSieve client (`src/services/sieve.service.ts`, 452
lines; `src/tools/sieve.tool.ts`, 278 lines; LGPL, Copyright (c) 2026 Bitfloo).
Port the protocol client with attribution in `NOTICE`, then add the safety
layer above. Its known gaps: no redirect guard, no CHECKSCRIPT, no backups,
put-over-active is silently live, multi-line NO truncated, no implicit TLS, no
OAuth.

## Tests

- Unit: protocol parsing, risky-action scanner (including tricks: comments,
  quoted strings, `include` of a script that redirects), redirect allowlist,
  backup before delete/replace, preview output.
- Integration: a Dovecot + Pigeonhole test container in CI, run through every
  tool end to end.

## Effort (estimate)

| Piece | Days |
|---|---|
| Port the client and fix its known bugs | 1 |
| Safety layer: scanner, allowlist, previews, backups | 1.5 |
| Tests with a Dovecot container | 1 |
| Docs | 0.5 |
| **Sieve total** | **4** |
| Local-rules tools for non-Sieve providers | 1 to 2 more |
| Gmail filters API or Microsoft Graph rules | 3 to 5 each, later |

## Decisions (owner, 2026-11-18)

1. **Ship Sieve tools and local rules together**, so every provider gets rules
   on day one.
2. **Forwarding only to a human-controlled allowlist.** `sieve.allowed_redirects`
   (and the same list for local rules) lives in `config.toml`. The user, or an AI
   the user directs to edit that file outside this server, may change it. **No
   MCP tool can read-modify-write the allowlist**, and no tool argument can
   bypass it. A test must assert that no registered tool writes `config.toml`.
   The list covers standing forwards only. One-off sends (`send_email`,
   `reply_email`, `forward_email`, `send_draft`, `schedule_email`,
   `apply_template`) stay open to any address; the MCP client's approval prompt
   is the only check on them (owner decision, 2026-11-18).

## Implementation notes (2026-11-17)

What shipped, and where it differs from the plan above.

- **Tools.** The seven Sieve tools as planned, plus `list_local_rules`,
  `add_local_rule`, `remove_local_rule`. All ten are in the `full` toolset only;
  the write tools are hidden in `read_only`. Sieve tools are registered for
  every account; `sieve_status` answers "not supported, use local rules" for
  known providers without ManageSieve (no connection attempt) and for servers
  that cannot be reached.
- **Config.** Per-account `[accounts.sieve]` (`enabled`, `host`, `port`, `tls`,
  `starttls`); without it the IMAP host is tried on 4190 with STARTTLS.
  Top-level `[sieve] allowed_redirects` (addresses or bare domains, no
  wildcards, no subdomain matching). Env: `MCP_EMAIL_SIEVE_*`.
- **Put** previews unless `apply: true` (and `dryRun` always previews). It also
  warns when the script is live because the active script includes it.
- **Activate** executes unless `dryRun` (as the other write tools do). It does
  not make a backup, since activation changes no script text; it reports the
  previously active script so it can be undone, and the audit log records it.
- **Scanner, stricter than planned.** Besides `redirect`, these are blocked
  unless every target is allowlisted: `notify` with `mailto:` (any other notify
  method is blocked), and Dovecot's `report`. `pipe` and `execute` are always
  blocked. Variables in a target, `redirect :list`, dynamic include names and
  scripts that do not tokenize are blocked. `vacation`, `reject`, `ereject`,
  `discard`, `filter`, includes and `fileinto` to a missing folder are shown
  as risky.
- **Local rules** run inside the hooks pipeline (before the config.toml rules
  and AI triage), so only the writer-lease holder applies them, and only while
  IMAP Wizard runs with the watcher on and `read_only` off. Stored in
  `local-rules.json` in the data directory. The forward action exists: it is
  checked against the allowlist when added and again when it fires, and mail
  from the account itself or from the target is not forwarded (loop guard).
- **Not done.** Gmail filters API and Microsoft Graph rules (later, as planned).
  No `verify_ssl` switch for ManageSieve: certificates are always checked, so a
  self-signed server needs a loopback tunnel or a proper certificate.
