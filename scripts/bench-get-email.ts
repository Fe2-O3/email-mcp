/**
 * G0 measurement: is a body cache worth building?
 *
 * Read-only. Compares the current live `getEmail` against the cache-hit path
 * the plan in CACHE-IMPLEMENTATION-PROMPT.md proposes:
 *
 *   hit = mailbox lock + `UID FETCH <uid> (UID FLAGS)`   (existence + live flags)
 *       + one local SQLite row read of the immutable body bundle
 *
 * A STATUS probe is timed too, for reference only: it is the freshness check a
 * later search/list-from-mirror phase would need, not part of the get_email hit.
 *
 * Gate: PASS when live p50 >= 2 x hit p95, and the absolute saving at p50 is
 * at least 50 ms. Otherwise the body cache is not worth its correctness risk.
 *
 * Run (Node 24):  pnpm exec tsx scripts/bench-get-email.ts
 * Env:
 *   BENCH_ACCOUNT   account name (default: first configured)
 *   BENCH_MAILBOX   mailbox (default: INBOX)
 *   BENCH_MESSAGES  distinct newest messages to cycle through (default 30)
 *   BENCH_SAMPLES   timed samples per path (default 60)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { DatabaseSync } from 'node:sqlite';

import { loadConfig } from '../src/config/loader.js';
import ConnectionManager from '../src/connections/manager.js';
import ImapService from '../src/services/imap.service.js';
import OAuthService from '../src/services/oauth.service.js';
import type { Email } from '../src/types/index.js';

const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 60);
const MESSAGES = Number(process.env.BENCH_MESSAGES ?? 30);
const MAILBOX = process.env.BENCH_MAILBOX ?? 'INBOX';
const BODY_CAP_BYTES = 256 * 1024;

function pct(values: number[], p: number): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))] ?? 0;
}

function ms(n: number): string {
  return `${n.toFixed(1)} ms`;
}

function kb(n: number): string {
  return `${(n / 1024).toFixed(1)} KB`;
}

async function unseenCount(
  client: Awaited<ReturnType<ConnectionManager['getImapClient']>>,
): Promise<number | undefined> {
  const st = await client.status(MAILBOX, { unseen: true });
  return st ? st.unseen : undefined;
}

async function timed(fn: () => Promise<unknown> | unknown): Promise<number> {
  const start = performance.now();
  await fn();
  return performance.now() - start;
}

function bundleOf(email: Email): string {
  // Shape of what the cache would store: everything getEmail derives its
  // output from that does not change for a given (UIDVALIDITY, UID).
  return JSON.stringify({
    headers: email.headers,
    bodyText: email.bodyText ?? null,
    bodyHtml: email.bodyHtml ?? null,
    attachments: email.attachments,
  });
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const account = process.env.BENCH_ACCOUNT
    ? config.accounts.find((a) => a.name === process.env.BENCH_ACCOUNT)
    : config.accounts[0];
  if (!account) throw new Error('No matching account configured.');

  const connections = new ConnectionManager(config.accounts, new OAuthService());
  const imap = new ImapService(connections);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-get-email-'));
  const db = new DatabaseSync(path.join(dir, 'bench.db'));

  try {
    const page = await imap.listEmails(account.name, {
      mailbox: MAILBOX,
      pageSize: MESSAGES,
      sort: 'date',
    });
    const ids = page.items.map((item) => item.id);
    if (ids.length === 0) throw new Error(`${MAILBOX} is empty; nothing to measure.`);

    const client = await connections.getImapClient(account.name);
    const unseenBefore = await unseenCount(client);

    // One untimed pass: warms the connection and records body sizes, and
    // fills the local table with real bundles so the local read is realistic.
    db.exec('CREATE TABLE body (uid INTEGER PRIMARY KEY, bundle TEXT NOT NULL)');
    const insert = db.prepare('INSERT INTO body (uid, bundle) VALUES (?, ?)');
    const sizes: number[] = [];
    let withHtmlAndText = 0;
    for (const id of ids) {
      const email = await imap.getEmail(account.name, id, MAILBOX);
      const bundle = bundleOf(email);
      sizes.push(Buffer.byteLength(bundle));
      if (email.bodyText && email.bodyHtml) withHtmlAndText += 1;
      insert.run(Number(id), bundle);
    }

    const live: number[] = [];
    const probe: number[] = [];
    const local: number[] = [];
    const status: number[] = [];
    const read = db.prepare('SELECT bundle FROM body WHERE uid = ?');

    // Interleave the paths so drift in server or network latency hits all
    // of them equally instead of biasing whichever ran last.
    for (let i = 0; i < SAMPLES; i += 1) {
      const id = ids[i % ids.length] as string;
      const uid = Number(id);

      live.push(await timed(() => imap.getEmail(account.name, id, MAILBOX)));

      probe.push(
        await timed(async () => {
          const lock = await client.getMailboxLock(MAILBOX);
          try {
            const msg = await client.fetchOne(id, { uid: true, flags: true }, { uid: true });
            if (!msg) throw new Error(`UID ${id} vanished during the benchmark`);
          } finally {
            lock.release();
          }
        }),
      );

      local.push(
        await timed(() => {
          const row = read.get(uid) as { bundle: string } | undefined;
          if (!row) throw new Error(`UID ${id} missing from local table`);
          JSON.parse(row.bundle);
        }),
      );

      status.push(
        await timed(() =>
          client.status(MAILBOX, {
            messages: true,
            uidNext: true,
            uidValidity: true,
            highestModseq: true,
          }),
        ),
      );
    }

    const unseenAfter = await unseenCount(client);

    const hit = probe.map((p, i) => p + (local[i] ?? 0));
    const liveP50 = pct(live, 0.5);
    const hitP50 = pct(hit, 0.5);
    const hitP95 = pct(hit, 0.95);
    const saving = liveP50 - hitP50;
    const pass = liveP50 >= 2 * hitP95 && saving >= 50;
    const overCap = sizes.filter((s) => s > BODY_CAP_BYTES).length;

    const row = (name: string, v: number[]): string =>
      `| ${name.padEnd(34)} | ${ms(pct(v, 0.5)).padStart(10)} | ${ms(pct(v, 0.95)).padStart(10)} |`;

    console.log(`## G0 result — ${new Date().toISOString().slice(0, 10)}`);
    console.log('');
    console.log(
      `Mailbox: ${MAILBOX}; distinct messages: ${ids.length}; samples per path: ${SAMPLES}; node ${process.version}`,
    );
    console.log('');
    console.log(`| ${'path'.padEnd(34)} | ${'p50'.padStart(10)} | ${'p95'.padStart(10)} |`);
    console.log(`|${'-'.repeat(36)}|${'-'.repeat(12)}|${'-'.repeat(12)}|`);
    console.log(row('live getEmail (today)', live));
    console.log(row('hit: lock + UID FETCH FLAGS', probe));
    console.log(row('hit: local SQLite bundle read', local));
    console.log(row('hit: total', hit));
    console.log(row('reference: STATUS probe', status));
    console.log('');
    console.log(
      `Bundle size p50 ${kb(pct(sizes, 0.5))}, p95 ${kb(pct(sizes, 0.95))}, max ${kb(Math.max(...sizes))}; ` +
        `${overCap}/${sizes.length} over the ${kb(BODY_CAP_BYTES)} cap; ` +
        `${withHtmlAndText}/${sizes.length} carry both text and HTML.`,
    );
    console.log(`Unseen before/after (must match): ${unseenBefore} / ${unseenAfter}`);
    console.log('');
    console.log(
      `G0: ${pass ? 'PASS' : 'FAIL'} — live p50 ${ms(liveP50)} vs hit p95 ${ms(hitP95)} ` +
        `(${(liveP50 / hitP95).toFixed(2)}x, needs >= 2x); saving at p50 ${ms(saving)} (needs >= 50 ms)`,
    );
    if (unseenBefore !== unseenAfter) {
      console.log('WARNING: unseen count changed — something in the read path is not read-only.');
      process.exitCode = 2;
    }
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await connections.closeAll();
  }
}

main().catch((err: unknown) => {
  console.error('Benchmark failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
