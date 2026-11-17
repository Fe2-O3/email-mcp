/**
 * G0 measurement: is a mirror read worth building?
 *
 * Read-only. Uses the same live read path as get_email, one STATUS probe, and a
 * local SQLite row read. Compares live p50 against (STATUS p95 + local p95).
 * Gate passes when live p50 >= 3 x (status p95 + local p95).
 *
 * Run: pnpm exec tsx scripts/bench-get-email.ts
 * Env: BENCH_SAMPLES (default 30), BENCH_MESSAGES (default 10)
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

import CacheStore from '../src/cache/store.js';
import { loadConfig } from '../src/config/loader.js';
import ConnectionManager from '../src/connections/manager.js';
import ImapService from '../src/services/imap.service.js';
import OAuthService from '../src/services/oauth.service.js';

const SAMPLES = Number(process.env.BENCH_SAMPLES ?? 30);
const MESSAGES = Number(process.env.BENCH_MESSAGES ?? 10);
const MAILBOX = 'INBOX';

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)] as number;
}

function fmt(ms: number): string {
  return `${ms.toFixed(1)} ms`;
}

async function timed<T>(fn: () => Promise<T> | T): Promise<[number, T]> {
  const start = performance.now();
  const result = await fn();
  return [performance.now() - start, result];
}

async function main(): Promise<void> {
  const config = await loadConfig();
  const account = config.accounts[0];
  if (!account) throw new Error('No accounts configured.');

  const connections = new ConnectionManager(config.accounts, new OAuthService());
  const imap = new ImapService(connections);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-get-email-'));
  let store: CacheStore | undefined;

  try {
    const page = await imap.listEmails(account.name, {
      mailbox: MAILBOX,
      pageSize: MESSAGES,
      sort: 'date',
    });
    const ids = page.items.map((item) => item.id);
    if (ids.length === 0) throw new Error(`${MAILBOX} is empty; nothing to measure.`);

    const client = await connections.getImapClient(account.name);
    const unseenBefore = (await client.status(MAILBOX, { unseen: true })).unseen;

    // Warm the connection and both code paths; these samples are discarded.
    await imap.getEmail(account.name, ids[0] as string, MAILBOX);
    await client.status(MAILBOX, { messages: true, uidValidity: true });

    const live: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const id = ids[i % ids.length] as string;
      const [ms] = await timed(() => imap.getEmail(account.name, id, MAILBOX));
      live.push(ms);
    }

    const status: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const [ms] = await timed(() => client.status(MAILBOX, { messages: true, uidValidity: true }));
      status.push(ms);
    }

    // Local read: one row with a body, as the mirror would serve it.
    const sample = await imap.getEmail(account.name, ids[0] as string, MAILBOX);
    const uid = Number(ids[0]);
    store = new CacheStore(path.join(dir, 'bench.db'));
    store.putMessages([
      {
        account: account.name,
        mailbox: MAILBOX,
        uid,
        uidValidity: '1',
        envelope: { subject: sample.subject },
        flags: [],
        internalDate: Date.parse(sample.date) || 0,
        subject: sample.subject,
        fromText: sample.from.address,
        hasAttachments: false,
      },
    ]);
    store.putBody(account.name, MAILBOX, uid, '1', sample.bodyText ?? sample.bodyHtml ?? '');

    const local: number[] = [];
    for (let i = 0; i < SAMPLES; i += 1) {
      const [ms] = await timed(() => store?.getMessage(account.name, MAILBOX, uid, '1'));
      local.push(ms);
    }

    const unseenAfter = (await client.status(MAILBOX, { unseen: true })).unseen;

    const liveP50 = pct(live, 0.5);
    const liveP95 = pct(live, 0.95);
    const statusP95 = pct(status, 0.95);
    const localP95 = pct(local, 0.95);
    const cachedBudget = statusP95 + localP95;
    const ratio = liveP50 / cachedBudget;
    const pass = liveP50 >= 3 * cachedBudget;

    console.log(`Account: ${account.name}   mailbox: ${MAILBOX}   messages sampled: ${ids.length}`);
    console.log(`Samples per path: ${SAMPLES}`);
    console.log('');
    console.log('path                      p50            p95');
    console.log(`live getEmail             ${fmt(liveP50).padEnd(14)} ${fmt(liveP95)}`);
    console.log(`STATUS probe              ${fmt(pct(status, 0.5)).padEnd(14)} ${fmt(statusP95)}`);
    console.log(`local SQLite row read     ${fmt(pct(local, 0.5)).padEnd(14)} ${fmt(localP95)}`);
    console.log('');
    console.log(`cached path budget (STATUS p95 + local p95): ${fmt(cachedBudget)}`);
    console.log(`speed ratio (live p50 / cached budget):       ${ratio.toFixed(2)}x`);
    console.log(`unseen before/after (read-only check):        ${unseenBefore} / ${unseenAfter}`);
    console.log('');
    console.log(`G0: ${pass ? 'PASS' : 'FAIL'} (needs >= 3.00x)`);
  } finally {
    store?.close();
    fs.rmSync(dir, { recursive: true, force: true });
    await connections.closeAll();
  }
}

main().catch((err: unknown) => {
  console.error('Benchmark failed:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
