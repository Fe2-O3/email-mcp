/**
 * Standing rules are the one thing that keeps acting after the approval that
 * created them, so they are strict: no catch-all, no move into a special or
 * watched folder, no forward loop, an allowlist that is re-read, and edits
 * that cannot lose each other.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { readAllowedRedirects } from '../config/loader.js';
import type { AccountConfig, EmailMeta } from '../types/index.js';
import { isCatchAllPattern, matchesPattern } from '../utils/glob-match.js';
import LocalRulesService, {
  isCatchAllRule,
  LocalRulesStore,
  moveTargetProblem,
  normalizeLocalRule,
  type RuleEmail,
  ruleMatches,
  validateLocalRule,
} from './local-rules.service.js';

vi.mock('../safety/audit.js', () => ({ default: { log: vi.fn(async () => undefined) } }));
const logs = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => undefined));
vi.mock('../logging.js', () => ({ mcpLog: logs }));

let dir: string;
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-rules-safety-'));
  logs.mockClear();
});
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const storeAt = () => new LocalRulesStore(path.join(dir, 'local-rules.json'));

describe('glob matching', () => {
  it('a hostile pattern against a long subject finishes fast', () => {
    const subject = 'a'.repeat(500);
    const started = Date.now();
    expect(matchesPattern('*a*a*a*a*a*a*a*b', subject)).toBe(false);
    expect(matchesPattern('*a*a*a*a*a*a*a*a', subject)).toBe(true);
    expect(Date.now() - started).toBeLessThan(250);
  });

  it('keeps the old meaning: * wildcard, | alternatives, whole value, any case', () => {
    expect(matchesPattern('*@shop.example', 'Billing@Shop.Example')).toBe(true);
    expect(matchesPattern('*@shop.example', 'x@shop.example.evil')).toBe(false);
    expect(matchesPattern('a*|b*', 'bob')).toBe(true);
    expect(matchesPattern('inv*2026', 'Invoice 2026')).toBe(true);
    expect(matchesPattern('a.c', 'abc')).toBe(false); // a dot is a dot
    expect(matchesPattern('a+', 'aa')).toBe(false);
  });

  it('knows which patterns match anything', () => {
    for (const p of ['*', '**', ' * ', '*@*', 'x|*', '*.*'])
      expect(isCatchAllPattern(p)).toBe(true);
    for (const p of ['*@bank.com', '*urgent*', 'a*b', '@'])
      expect(isCatchAllPattern(p)).toBe(false);
  });
});

describe('catch-all rules are refused', () => {
  const base = { name: 'r', actions: { flag: true } };
  it('refuses a bare wildcard, in any condition', () => {
    for (const match of [
      { from: '*' },
      { to: '*@*' },
      { subject: 'x|*' },
      { header: { name: 'constructor', value: '*' } },
      { from: '*', subject: '**' },
    ]) {
      const problems = validateLocalRule({ ...base, match }, [], []);
      expect(problems.join(' ')).toMatch(/match every message/);
    }
  });

  it('accepts a rule with at least one specific condition', () => {
    expect(
      validateLocalRule({ ...base, match: { from: '*', subject: '*invoice*' } }, [], []),
    ).toEqual([]);
  });

  it('a "constructor" header rule cannot read Object.prototype', () => {
    const rule = {
      id: 'x',
      createdAt: '',
      name: 'n',
      match: { header: { name: 'constructor', value: '*function*' } },
      actions: { flag: true },
    };
    const email: RuleEmail = { account: 'a', mailbox: 'INBOX', meta: meta() };
    expect(ruleMatches(rule, email, { 'list-id': 'x' })).toBe(false);
  });

  it('limits name, pattern length and the number of rules', () => {
    expect(
      validateLocalRule(
        { ...base, name: 'n'.repeat(101), match: { from: 'a@b.c' } },
        [],
        [],
      ).join(),
    ).toMatch(/longer than 100/);
    expect(
      validateLocalRule({ ...base, match: { subject: 'x'.repeat(201) } }, [], []).join(),
    ).toMatch(/longer than 200/);
    const many = Array.from({ length: 200 }, (_, i) => ({
      id: String(i),
      createdAt: '',
      name: `r${i}`,
      match: { from: 'a@b.c' },
      actions: { flag: true },
    }));
    expect(validateLocalRule({ ...base, match: { from: 'a@b.c' } }, [], many).join()).toMatch(
      /already 200/,
    );
  });

  it('a stored catch-all rule still loads, and is flagged once in the log', async () => {
    const store = storeAt();
    await fs.writeFile(
      store.filePath,
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: 'old',
            name: 'old',
            match: { from: '*' },
            actions: { flag: true },
            createdAt: '2026-01-01T00:00:00Z',
          },
        ],
      }),
    );
    expect(isCatchAllRule((await store.load())[0].match)).toBe(true);
    const { service } = service3();
    await service.applyToBatch([mail('A', '1')]);
    await service.applyToBatch([mail('A', '2')]);
    const warnings = logs.mock.calls.filter((c) => String(c[2]).includes('matches every message'));
    expect(warnings).toHaveLength(1);
  });
});

describe('where a rule may move mail', () => {
  const boxes = [
    { path: 'INBOX' },
    { path: 'Receipts' },
    { path: 'Trash', specialUse: '\\Trash' },
    { path: '[Gmail]/Spam', specialUse: '\\Junk' },
    { path: 'Corbeille' }, // not flagged, but named like one below
    { path: 'Weird Bin' },
  ];
  it('refuses special-use folders, by flag and by name', () => {
    expect(moveTargetProblem('Trash', boxes, [])).toMatch(/special folder/);
    expect(moveTargetProblem('[Gmail]/Spam', boxes, [])).toMatch(/special folder/);
    expect(moveTargetProblem('Archive', [], [])).toMatch(/special folder/);
    expect(moveTargetProblem('Junk E-mail', [], [])).toMatch(/special folder/);
  });
  it('refuses a watched folder, INBOX in any case', () => {
    expect(moveTargetProblem('Newsletters', boxes, ['INBOX', 'Newsletters'])).toMatch(/watched/);
    expect(moveTargetProblem('inbox', boxes, ['INBOX'])).toMatch(/watched/);
  });
  it('allows an ordinary unwatched folder', () => {
    expect(moveTargetProblem('Receipts', boxes, ['INBOX'])).toBeUndefined();
  });
});

describe('forward targets', () => {
  it('"<addr>" and padded targets are stored as one plain address', () => {
    const n = normalizeLocalRule({
      name: ' r ',
      match: { from: 'a@b.c' },
      actions: { forwardTo: ' <Me@Example.org> ' },
    });
    expect(n.actions.forwardTo).toBe('me@example.org');
    expect(n.name).toBe('r');
  });
});

describe('editing the rules file', () => {
  it('parallel adds in one process keep every rule', async () => {
    const store = storeAt();
    const adds = Array.from({ length: 12 }, (_, i) =>
      store.add({ name: `rule ${i}`, match: { from: `a${i}@b.c` }, actions: { flag: true } }),
    );
    await Promise.all(adds);
    expect((await store.load()).map((r) => r.name).sort()).toHaveLength(12);
  });

  it('parallel adds from two processes (two stores on one file) keep every rule', async () => {
    const a = storeAt();
    const b = storeAt();
    const adds = Array.from({ length: 10 }, (_, i) =>
      (i % 2 ? a : b).add({
        name: `rule ${i}`,
        match: { from: `a${i}@b.c` },
        actions: { flag: true },
      }),
    );
    const results = await Promise.allSettled(adds);
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);
    expect(await a.load()).toHaveLength(10);
    await expect(fs.access(`${a.filePath}.lock`)).rejects.toThrow();
  });

  it('two adds with one name: one wins, one is told it exists', async () => {
    const store = storeAt();
    const same = { name: 'same', match: { from: 'a@b.c' }, actions: { flag: true } };
    const results = await Promise.allSettled([store.add(same), store.add(same)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(await store.load()).toHaveLength(1);
  });

  it('a lock left by a crashed editor does not block forever', async () => {
    const store = storeAt();
    await fs.mkdir(dir, { recursive: true });
    const lock = `${store.filePath}.lock`;
    await fs.writeFile(lock, '');
    const old = new Date(Date.now() - 120_000);
    await fs.utimes(lock, old, old);
    await expect(
      store.add({ name: 'r', match: { from: 'a@b.c' }, actions: { flag: true } }),
    ).resolves.toBeTruthy();
  });

  it('a damaged file names its path', async () => {
    const store = storeAt();
    await fs.writeFile(store.filePath, '{not json');
    await expect(store.load()).rejects.toThrow(store.filePath);
  });
});

// ---------------------------------------------------------------------------
// Running rules
// ---------------------------------------------------------------------------

function meta(overrides: Partial<EmailMeta> = {}): EmailMeta {
  return {
    id: '42',
    messageId: '<m@x>',
    subject: 'Invoice',
    from: { name: 'Billing', address: 'billing@shop.example' },
    to: [{ address: 'user@example.com' }],
    date: '2026-11-17T10:00:00Z',
    seen: false,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
    ...overrides,
  };
}
const mail = (account: string, id: string, mailbox = 'INBOX'): RuleEmail => ({
  account,
  mailbox,
  meta: meta({ id }),
});

/** One service on its own store, with simple fakes. Overrides tune single dependencies. */
function service3(
  opts: {
    store?: LocalRulesStore;
    headers?: Record<string, string> | Error;
    forward?: () => Promise<unknown>;
    readAllowlist?: () => Promise<string[]>;
    watched?: string[];
  } = {},
) {
  const imapService = {
    addLabel: vi.fn(async () => undefined),
    setFlags: vi.fn(async () => undefined),
    moveEmail: vi.fn(async () => undefined),
    getHeaders: vi.fn(async (..._args: unknown[]): Promise<Record<string, string>> => {
      if (opts.headers instanceof Error) throw opts.headers;
      return opts.headers ?? {};
    }),
  };
  const smtpService = {
    forwardEmail: vi.fn(opts.forward ?? (async () => ({ messageId: 'x', status: 'sent' }))),
  };
  const svc = new LocalRulesService({
    store: opts.store ?? storeAt(),
    imapService: imapService as never,
    smtpService: smtpService as never,
    readAllowlist: opts.readAllowlist ?? (async () => ['me@example.org']),
    watchedFolders: () => opts.watched ?? ['INBOX'],
    accounts: [
      { name: 'A', email: 'a@own.example' },
      { name: 'B', email: 'b@own.example' },
      { name: 'C', email: 'c@own.example' },
    ] as AccountConfig[],
  });
  return { service: svc, imapService, smtpService };
}

describe('forward loop', () => {
  it('refuses to forward a message that carries the marker', async () => {
    const store = storeAt();
    await store.add({
      name: 'fwd',
      match: { from: '*@shop.example' },
      actions: { forwardTo: 'me@example.org' },
    });
    const { service, smtpService } = service3({
      store,
      headers: { 'x-imap-wizard-forwarded': 'a@own.example' },
    });
    await service.applyToBatch([mail('A', '1')]);
    expect(smtpService.forwardEmail).not.toHaveBeenCalled();
  });

  it('three accounts forwarding in a ring stop after one hop', async () => {
    const ring = ['a@own.example', 'b@own.example', 'c@own.example'];
    let forwards = 0;
    // Mail "delivered" by a forward carries the marker, as composeForward adds it.
    const marked = new Set<string>();
    const accounts = ['A', 'B', 'C'];
    const services = accounts.map((name, i) => {
      const store = new LocalRulesStore(path.join(dir, `${name}.json`));
      const target = ring[(i + 1) % 3];
      const built = service3({
        store,
        readAllowlist: async () => ring,
        headers: undefined,
        forward: async () => {
          forwards += 1;
          marked.add(`${accounts[(i + 1) % 3]}:next`);
          return { messageId: 'x', status: 'sent' };
        },
      });
      built.imapService.getHeaders.mockImplementation(
        async (_a: unknown, id: unknown): Promise<Record<string, string>> =>
          id === 'forwarded' ? { 'x-imap-wizard-forwarded': 'x' } : {},
      );
      return { name, store, target, ...built };
    });
    await Promise.all(
      services.map((s) =>
        s.store.add({
          name: 'ring',
          match: { subject: '*invoice*' },
          actions: { forwardTo: s.target },
        }),
      ),
    );
    // The original lands at A and is forwarded to B.
    await services[0].service.applyToBatch([mail('A', '1')]);
    // B receives the forwarded copy (marked) and its rule fires; so does C's if B forwarded.
    await services[1].service.applyToBatch([mail('B', 'forwarded')]);
    await services[2].service.applyToBatch([mail('C', 'forwarded')]);
    expect(forwards).toBe(1);
  });

  it('fails closed when the headers cannot be read', async () => {
    const store = storeAt();
    await store.add({
      name: 'fwd',
      match: { from: '*@shop.example' },
      actions: { forwardTo: 'me@example.org', moveTo: 'Receipts' },
    });
    const { service, smtpService, imapService } = service3({ store, headers: new Error('boom') });
    await service.applyToBatch([mail('A', '1')]);
    expect(smtpService.forwardEmail).not.toHaveBeenCalled();
    expect(imapService.moveEmail).not.toHaveBeenCalled();
  });
});

describe('allowlist is re-read', () => {
  it('removing an address stops the next forward in a running process', async () => {
    const store = storeAt();
    await store.add({
      name: 'fwd',
      match: { from: '*@shop.example' },
      actions: { forwardTo: 'me@example.org' },
    });
    let list = ['me@example.org'];
    const { service, smtpService } = service3({ store, readAllowlist: async () => list });
    await service.applyToBatch([mail('A', '1')]);
    expect(smtpService.forwardEmail).toHaveBeenCalledTimes(1);
    list = [];
    await service.applyToBatch([mail('A', '2')]);
    expect(smtpService.forwardEmail).toHaveBeenCalledTimes(1);
  });

  it('an unreadable allowlist allows nothing', async () => {
    const store = storeAt();
    await store.add({
      name: 'fwd',
      match: { from: '*@shop.example' },
      actions: { forwardTo: 'me@example.org' },
    });
    const { service, smtpService } = service3({
      store,
      readAllowlist: async () => {
        throw new Error('cannot read config.toml');
      },
    });
    await service.applyToBatch([mail('A', '1')]);
    expect(smtpService.forwardEmail).not.toHaveBeenCalled();
  });

  it('readAllowedRedirects reads config.toml fresh, and gives [] when it cannot', async () => {
    const file = path.join(dir, 'config.toml');
    await fs.writeFile(file, '[sieve]\nallowed_redirects = ["me@example.org"]\n');
    expect(await readAllowedRedirects(file)).toEqual(['me@example.org']);
    await fs.writeFile(file, '[sieve]\nallowed_redirects = []\n');
    expect(await readAllowedRedirects(file)).toEqual([]);
    await fs.writeFile(file, 'this is = = not toml [');
    expect(await readAllowedRedirects(file)).toEqual([]);
    expect(await readAllowedRedirects(path.join(dir, 'missing.toml'))).toEqual([]);
  });
});

describe('moves and failed forwards', () => {
  it('a same-folder move is skipped (no new number, no new "new mail")', async () => {
    const store = storeAt();
    await store.add({
      name: 'mv',
      match: { from: '*@shop.example' },
      actions: { moveTo: 'Receipts' },
    });
    const { service, imapService } = service3({ store });
    await service.applyToBatch([mail('A', '1', 'Receipts')]);
    expect(imapService.moveEmail).not.toHaveBeenCalled();
  });

  it('a move into a watched folder is skipped at run time, even for an old rule', async () => {
    const store = storeAt();
    await store.add({ name: 'mv', match: { from: '*@shop.example' }, actions: { moveTo: 'News' } });
    const { service, imapService } = service3({ store, watched: ['INBOX', 'News'] });
    await service.applyToBatch([mail('A', '1')]);
    expect(imapService.moveEmail).not.toHaveBeenCalled();
  });

  it('a forward that is rate-limited leaves the message in place', async () => {
    const store = storeAt();
    await store.add({
      name: 'fwd',
      match: { from: '*@shop.example' },
      actions: { forwardTo: 'me@example.org', moveTo: 'Receipts' },
    });
    const { service, imapService } = service3({
      store,
      forward: async () => {
        throw new Error('Rate limit exceeded for account "A".');
      },
    });
    await service.applyToBatch([mail('A', '1')]);
    expect(imapService.moveEmail).not.toHaveBeenCalled();
  });

  it('a failed header fetch for a header rule is logged, not a silent no-match', async () => {
    const store = storeAt();
    await store.add({
      name: 'hdr',
      match: { header: { name: 'list-id', value: '*dev*' } },
      actions: { flag: true },
    });
    const { service } = service3({ store, headers: new Error('fetch failed') });
    await service.applyToBatch([mail('A', '1')]);
    expect(logs.mock.calls.some((c) => String(c[2]).includes('Could not read the headers'))).toBe(
      true,
    );
  });
});
