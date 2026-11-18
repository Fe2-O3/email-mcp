/**
 * A rule made for one mailbox must not run on another mailbox that was later
 * given the same account name: it would move or forward that mailbox's mail.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import accountFingerprint from '../connections/account-identity.js';
import type { AccountConfig, EmailMeta } from '../types/index.js';
import LocalRulesService, { LocalRulesStore } from './local-rules.service.js';

vi.mock('../safety/audit.js', () => ({ default: { log: vi.fn(async () => undefined) } }));
vi.mock('../logging.js', () => ({ mcpLog: vi.fn(async () => undefined) }));

const OLD = { username: 'me@old.invalid', imap: { host: 'imap.old.invalid', port: 993 } };
const NEW = { username: 'me@new.invalid', imap: { host: 'imap.new.invalid', port: 993 } };

let dir: string;
let store: LocalRulesStore;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'local-rules-identity-'));
  store = new LocalRulesStore(path.join(dir, 'local-rules.json'));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function service(account: typeof OLD) {
  const moveEmail = vi.fn(async () => []);
  const rules = new LocalRulesService({
    store,
    imapService: { moveEmail, getHeaders: vi.fn(async () => ({})) } as never,
    smtpService: {} as never,
    allowlist: [],
    accounts: [{ name: 'work', email: account.username, ...account } as unknown as AccountConfig],
  });
  return { rules, moveEmail };
}

const mail = {
  account: 'work',
  mailbox: 'INBOX',
  meta: {
    id: '7',
    subject: 'Invoice',
    from: { address: 'billing@shop.example' },
    to: [],
    date: '2026-11-17T10:00:00Z',
    seen: false,
    flagged: false,
    answered: false,
    hasAttachments: false,
    labels: [],
  } as unknown as EmailMeta,
};

describe('local rules and the account they were made for', () => {
  async function addRule(): Promise<void> {
    await store.add({
      name: 'invoices',
      account: 'work',
      accountFingerprint: accountFingerprint(OLD),
      match: { from: '*@shop.example' },
      actions: { moveTo: 'Receipts' },
    });
  }

  it('runs while the account still points at the same mailbox', async () => {
    await addRule();
    const { rules, moveEmail } = service(OLD);
    expect(await rules.applyToBatch([mail])).toEqual([]);
    expect(moveEmail).toHaveBeenCalledTimes(1);
  });

  it('does not run once the account name points at another server or login', async () => {
    await addRule();
    const { rules, moveEmail } = service(NEW);
    expect(await rules.applyToBatch([mail])).toEqual([mail]);
    expect(moveEmail).not.toHaveBeenCalled();
  });

  it('still runs a rule saved before accounts were recorded', async () => {
    await store.add({
      name: 'invoices',
      account: 'work',
      match: { from: '*@shop.example' },
      actions: { moveTo: 'Receipts' },
    });
    const { rules, moveEmail } = service(NEW);
    await rules.applyToBatch([mail]);
    expect(moveEmail).toHaveBeenCalledTimes(1);
  });
});
