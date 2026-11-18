import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { LocalRulesStore } from '../services/local-rules.service.js';
import type { AppConfig } from '../types/index.js';
import { registerLocalRulesReadTools, registerLocalRulesWriteTools } from './local-rules.tool.js';

const auditLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../safety/audit.js', () => ({ default: { log: auditLog } }));

type Result = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-rules-tool-'));
  auditLog.mockClear();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function setup(watcher = true) {
  const store = new LocalRulesStore(path.join(dir, 'local-rules.json'));
  const config = {
    settings: { readOnly: false, watcher: { enabled: watcher } },
    sieve: { allowedRedirects: ['me@example.org'] },
  } as unknown as AppConfig;
  const handlers = new Map<string, Handler>();
  const fake = {
    registerTool: (name: string, _cfg: unknown, h: Handler) => {
      handlers.set(name, h);
    },
  } as never;
  const connections = {
    getAccount: (name: string) => {
      if (name !== 'personal') throw new Error(`Unknown account "${name}"`);
      return { name };
    },
  } as never;
  const imap = { listMailboxes: async () => [{ path: 'INBOX' }, { path: 'Receipts' }] } as never;
  registerLocalRulesReadTools(fake, store, config);
  registerLocalRulesWriteTools(fake, store, connections, imap, config);
  const call = async (name: string, args: Record<string, unknown>) =>
    (handlers.get(name) as Handler)(args);
  return { store, call };
}

describe('local rule tools', () => {
  it('adds, lists and removes a rule, saying they run only while IMAP Wizard runs', async () => {
    const { call, store } = setup();
    const added = await call('add_local_rule', {
      name: 'receipts',
      account: 'personal',
      match: { from: '*@shop.example' },
      actions: { moveTo: 'Receipts', markRead: true },
      dryRun: false,
    });
    expect(added.isError).toBeUndefined();
    expect(added.content[0]?.text).toMatch(/run only while IMAP Wizard is running/);
    const listed = await call('list_local_rules', {});
    expect(listed.content[0]?.text).toMatch(/"receipts" \(personal\): when from "\*@shop.example"/);
    const removed = await call('remove_local_rule', { rule: 'receipts', dryRun: false });
    expect(removed.content[0]?.text).toMatch(/^Removed/);
    expect(await store.load()).toEqual([]);
  });

  it('refuses a forward outside the allowlist; no argument bypasses it', async () => {
    const { call, store } = setup();
    const result = await call('add_local_rule', {
      name: 'leak',
      match: { from: '*' },
      actions: { forwardTo: 'thief@evil.com' },
      dryRun: false,
      confirm: true,
      force: true,
      allowedRedirects: ['thief@evil.com'],
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/not in sieve.allowed_redirects/);
    expect(await store.load()).toEqual([]);
  });

  it('accepts a forward to an allowlisted address', async () => {
    const { call, store } = setup();
    const result = await call('add_local_rule', {
      name: 'copy me',
      match: { subject: '*urgent*' },
      actions: { forwardTo: 'me@example.org' },
      dryRun: false,
    });
    expect(result.isError).toBeUndefined();
    expect((await store.load())[0]?.actions.forwardTo).toBe('me@example.org');
  });

  it('refuses a move into a folder that does not exist on the account', async () => {
    const { call } = setup();
    const result = await call('add_local_rule', {
      name: 'x',
      account: 'personal',
      match: { from: 'a@b.com' },
      actions: { moveTo: 'Nope' },
      dryRun: false,
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/"Nope" does not exist/);
  });

  it('dryRun writes nothing', async () => {
    const { call, store } = setup();
    const result = await call('add_local_rule', {
      name: 'x',
      match: { from: 'a@b.com' },
      actions: { flag: true },
      dryRun: true,
    });
    expect(result.content[0]?.text).toMatch(/^\[DRY RUN\] Would add/);
    await expect(fs.access(store.filePath)).rejects.toThrow();
  });

  it('says when the watcher is off, so rules do not run', async () => {
    const { call } = setup(false);
    const result = await call('list_local_rules', {});
    expect(result.content[0]?.text).toMatch(/watcher is off/);
  });
});
