import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import type { AccountConfig, EmailMeta, HooksConfig } from '../types/index.js';
import eventBus from './event-bus.js';
import HooksService from './hooks.service.js';
import type { LocalRuleInput, RuleEmail } from './local-rules.service.js';
import LocalRulesService, { LocalRulesStore, validateLocalRule } from './local-rules.service.js';

const auditLog = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('../safety/audit.js', () => ({ default: { log: auditLog } }));
vi.mock('../logging.js', () => ({ mcpLog: vi.fn(async () => undefined) }));

let dir: string;
let store: LocalRulesStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-rules-'));
  store = new LocalRulesStore(path.join(dir, 'local-rules.json'));
  auditLog.mockClear();
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

const ALLOW = ['me@example.org'];

function meta(overrides: Partial<EmailMeta> = {}): EmailMeta {
  return {
    id: '42',
    messageId: '<m@x>',
    subject: 'Invoice 2026-11',
    from: { name: 'Billing', address: 'billing@shop.example' },
    to: [{ address: 'user@example.com' }, { address: 'team@example.com' }],
    date: '2026-11-17T10:00:00Z',
    seen: false,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
    ...overrides,
  };
}

const email = (overrides: Partial<EmailMeta> = {}): RuleEmail => ({
  account: 'personal',
  mailbox: 'INBOX',
  meta: meta(overrides),
});

function rule(overrides: Partial<LocalRuleInput> = {}): LocalRuleInput {
  return {
    name: 'invoices',
    match: { from: '*@shop.example' },
    actions: { moveTo: 'Receipts' },
    ...overrides,
  };
}

function runner(allowlist = ALLOW) {
  const calls: string[] = [];
  const imapService = {
    addLabel: vi.fn(async (_a: string, _id: string, _m: string, label: string) => {
      calls.push(`label:${label}`);
    }),
    setFlags: vi.fn(async (_a: string, _id: string, _m: string, action: string) => {
      calls.push(`flags:${action}`);
    }),
    moveEmail: vi.fn(async (_a: string, _id: string, _m: string, dest: string) => {
      calls.push(`move:${dest}`);
    }),
    getHeaders: vi.fn(async () => ({ 'list-id': '<dev.lists.example>' })),
  };
  const smtpService = {
    forwardEmail: vi.fn(async (_a: string, opts: { to: string[] }) => {
      calls.push(`forward:${opts.to.join(',')}`);
      return { messageId: 'x', status: 'sent' };
    }),
  };
  const service = new LocalRulesService({
    store,
    imapService: imapService as never,
    smtpService: smtpService as never,
    allowlist,
    accounts: [{ name: 'personal', email: 'user@example.com' } as AccountConfig],
  });
  return { service, calls, imapService, smtpService };
}

describe('LocalRulesStore', () => {
  it('starts empty, adds, persists as JSON with mode 600, and removes by id or name', async () => {
    expect(await store.load()).toEqual([]);
    const added = await store.add(rule(), new Date('2026-11-17T00:00:00Z'));
    expect(added).toMatchObject({ name: 'invoices', createdAt: '2026-11-17T00:00:00.000Z' });
    const stat = await fs.stat(store.filePath);
    // eslint-disable-next-line no-bitwise
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600);
    expect(JSON.parse(await fs.readFile(store.filePath, 'utf8'))).toMatchObject({
      version: 1,
      rules: [{ id: added.id }],
    });
    await store.add(rule({ name: 'Other' }));
    expect((await store.remove('OTHER'))?.name).toBe('Other');
    expect((await store.remove(added.id))?.name).toBe('invoices');
    expect(await store.remove('nope')).toBeNull();
    expect(await store.load()).toEqual([]);
  });

  it('refuses a damaged file instead of overwriting it', async () => {
    await fs.writeFile(store.filePath, '{"version":1,"rules":[{"bogus":true}]}');
    await expect(store.add(rule())).rejects.toThrow(/not valid/);
    expect(await fs.readFile(store.filePath, 'utf8')).toContain('bogus');
  });

  it('two saves in the same millisecond do not share a temp file', async () => {
    // With a clock-based temp name both saves wrote one temp file and the
    // second rename failed with ENOENT, so a saved rule was reported as failed.
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    try {
      const results = await Promise.allSettled([
        store.add(rule({ name: 'one' })),
        store.add(rule({ name: 'two' })),
      ]);
      expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled']);
    } finally {
      now.mockRestore();
    }
    const leftovers = (await fs.readdir(dir)).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
  });

  it('can never be pointed at config.toml', () => {
    expect(() => new LocalRulesStore(path.join(dir, 'config.toml'))).toThrow(/config\.toml/);
  });
});

describe('validateLocalRule', () => {
  it('needs a condition and an action', () => {
    expect(validateLocalRule(rule({ match: {} }), ALLOW, [])).toEqual([
      expect.stringMatching(/match condition/),
    ]);
    expect(validateLocalRule(rule({ actions: { flag: false } }), ALLOW, [])).toEqual([
      expect.stringMatching(/at least one action/),
    ]);
  });

  it('refuses a forward outside the allowlist and says only a person can change it', () => {
    expect(
      validateLocalRule(rule({ actions: { forwardTo: 'thief@evil.com' } }), ALLOW, []),
    ).toEqual([
      expect.stringMatching(/not in sieve.allowed_redirects.*Only a person editing config.toml/),
    ]);
    expect(
      validateLocalRule(rule({ actions: { forwardTo: 'me@example.org' } }), ALLOW, []),
    ).toEqual([]);
    expect(
      validateLocalRule(rule({ actions: { forwardTo: 'me@example.org' } }), [], []),
    ).toHaveLength(1);
  });

  it('refuses a forward target that is not one plain address', () => {
    expect(
      validateLocalRule(rule({ actions: { forwardTo: 'me@example.org, x@evil.com' } }), ALLOW, []),
    ).toEqual([expect.stringMatching(/one plain email address/)]);
  });

  it('refuses a duplicate name', async () => {
    const existing = await store.add(rule());
    expect(validateLocalRule(rule({ name: 'INVOICES' }), ALLOW, [existing])).toEqual([
      expect.stringMatching(/already exists/),
    ]);
  });
});

describe('LocalRulesService', () => {
  it('passes everything through when there are no rules', async () => {
    const { service, calls } = runner();
    const batch = [email()];
    expect(await service.applyToBatch(batch)).toEqual(batch);
    expect(calls).toEqual([]);
  });

  it('applies the first matching rule, moving last, and returns the rest', async () => {
    await store.add(
      rule({
        actions: { labels: ['Bills'], flag: true, markRead: true, moveTo: 'Receipts' },
      }),
    );
    await store.add(rule({ name: 'second', actions: { moveTo: 'Never' } }));
    const { service, calls } = runner();
    const other = email({ id: '43', from: { address: 'friend@example.com' } });
    expect(await service.applyToBatch([email(), other])).toEqual([other]);
    expect(calls).toEqual(['label:Bills', 'flags:flag', 'flags:read', 'move:Receipts']);
    expect(auditLog).toHaveBeenCalledWith(
      'local_rule',
      'personal',
      expect.objectContaining({ rule: 'invoices', emailId: '42' }),
      'ok',
      undefined,
    );
  });

  it('matches to, subject and display-name from, all conditions together', async () => {
    await store.add(
      rule({
        match: { from: 'Billing <*>', to: 'team@*', subject: 'invoice*' },
        actions: { flag: true },
      }),
    );
    const { service } = runner();
    expect(await service.applyToBatch([email()])).toEqual([]);
    expect(await service.applyToBatch([email({ subject: 'Hello' })])).toHaveLength(1);
  });

  it('fetches headers only for a header rule', async () => {
    const { service, imapService, calls } = runner();
    await store.add(rule({ match: { subject: 'nothing' } }));
    await service.applyToBatch([email()]);
    expect(imapService.getHeaders).not.toHaveBeenCalled();

    await store.add(
      rule({
        name: 'lists',
        match: { header: { name: 'List-Id', value: '*dev.lists*' } },
        actions: { moveTo: 'Lists' },
      }),
    );
    await service.applyToBatch([email()]);
    expect(imapService.getHeaders).toHaveBeenCalledOnce();
    expect(calls).toEqual(['move:Lists']);
  });

  it('only runs an account-scoped rule on that account', async () => {
    await store.add(rule({ account: 'work' }));
    const { service, calls } = runner();
    await service.applyToBatch([email()]);
    expect(calls).toEqual([]);
  });

  it('forwards only to an allowlisted address, checked again when it fires', async () => {
    await store.add(rule({ actions: { forwardTo: 'me@example.org' } }));
    const allowed = runner();
    await allowed.service.applyToBatch([email()]);
    expect(allowed.calls).toEqual(['forward:me@example.org']);

    // The file says forward, but the allowlist this process loaded no longer lists it.
    const revoked = runner([]);
    await revoked.service.applyToBatch([email()]);
    expect(revoked.smtpService.forwardEmail).not.toHaveBeenCalled();
    expect(auditLog).toHaveBeenLastCalledWith(
      'local_rule',
      'personal',
      expect.anything(),
      'error',
      expect.stringMatching(/not in sieve.allowed_redirects/),
    );
  });

  it('does not forward a hand-edited rule whose target is off the allowlist', async () => {
    await fs.writeFile(
      store.filePath,
      JSON.stringify({
        version: 1,
        rules: [
          {
            id: 'x',
            name: 'sneaky',
            match: { from: '*' },
            actions: { forwardTo: 'thief@evil.com' },
            createdAt: '2026-11-17T00:00:00Z',
          },
        ],
      }),
    );
    const { service, smtpService } = runner();
    await service.applyToBatch([email()]);
    expect(smtpService.forwardEmail).not.toHaveBeenCalled();
  });

  it('skips forwarding mail sent by the account itself or by the target (loops)', async () => {
    await store.add(rule({ match: { subject: '*' }, actions: { forwardTo: 'me@example.org' } }));
    const { service, smtpService } = runner();
    await service.applyToBatch([
      email({ from: { address: 'user@example.com' } }),
      email({ from: { address: 'ME@example.org' } }),
    ]);
    expect(smtpService.forwardEmail).not.toHaveBeenCalled();
  });

  it('keeps going when one action fails, and records the failure', async () => {
    await store.add(rule({ actions: { labels: ['A'], moveTo: 'Receipts' } }));
    const { service, imapService, calls } = runner();
    imapService.addLabel.mockRejectedValueOnce(new Error('no labels here'));
    await service.applyToBatch([email()]);
    expect(calls).toEqual(['move:Receipts']);
    expect(auditLog).toHaveBeenCalledWith(
      'local_rule',
      'personal',
      expect.anything(),
      'error',
      expect.stringMatching(/label A: no labels here/),
    );
  });

  it('skips the rules (not the mail) when the file is damaged', async () => {
    await fs.writeFile(store.filePath, 'not json at all');
    const { service } = runner();
    const batch = [email()];
    expect(await service.applyToBatch(batch)).toEqual(batch);
  });
});

describe('HooksService with local rules', () => {
  const hooksConfig = (onNewEmail: HooksConfig['onNewEmail']): HooksConfig => ({
    onNewEmail,
    preset: 'priority-focus',
    autoLabel: false,
    autoFlag: false,
    batchDelay: 1,
    rules: [],
    alerts: {
      desktop: false,
      sound: false,
      urgencyThreshold: 'high',
      webhookUrl: '',
      webhookEvents: [],
    },
  });

  it('runs local rules even when on_new_email is "none"', async () => {
    vi.useFakeTimers();
    try {
      await store.add(rule({ actions: { flag: true } }));
      const { service, calls } = runner();
      const hooks = new HooksService(hooksConfig('none'), {} as never);
      hooks.attachLocalRules(service);
      hooks.start(null);
      eventBus.emit('email:new', { account: 'personal', mailbox: 'INBOX', emails: [meta()] });
      await vi.advanceTimersByTimeAsync(1_000);
      await vi.waitFor(() => {
        expect(calls).toEqual(['flags:flag']);
      });
      hooks.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not listen at all with on_new_email "none" and no local rules', () => {
    const before = eventBus.listenerCount('email:new');
    const hooks = new HooksService(hooksConfig('none'), {} as never);
    hooks.start(null);
    expect(eventBus.listenerCount('email:new')).toBe(before);
    hooks.stop();
  });
});
