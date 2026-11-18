/**
 * `imap-wizard scheduler check` (run by launchd or cron): it must not send in
 * read-only mode, and its connection manager must be able to use OAuth accounts.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

import { SCHEDULED_DIR } from '../config/xdg.js';
import OAuthService from '../services/oauth.service.js';

const state = vi.hoisted(() => ({
  readOnly: false,
  managerArgs: [] as unknown[][],
  sendMail: vi.fn(),
}));

vi.mock('../config/loader.js', () => ({
  loadConfig: async () => ({
    accounts: [{ name: 'a', email: 'me@example.invalid' }],
    settings: { readOnly: state.readOnly, rateLimit: 10 },
  }),
}));

vi.mock('../connections/manager.js', () => ({
  default: class {
    constructor(...args: unknown[]) {
      state.managerArgs.push(args);
    }

    getAccount() {
      return { email: 'me@example.invalid', username: 'me', smtp: { host: 'h' } };
    }

    async getSmtpTransport() {
      return { sendMail: state.sendMail };
    }

    invalidateSmtpTransport() {}
  },
}));

const ID = '22222222-2222-4222-8222-222222222222';

async function queueOverdueJob(): Promise<void> {
  await fs.mkdir(SCHEDULED_DIR, { recursive: true });
  await fs.writeFile(
    path.join(SCHEDULED_DIR, `${ID}.json`),
    JSON.stringify({
      id: ID,
      account: 'a',
      to: ['x@example.invalid'],
      subject: 'S',
      body: 'b',
      html: false,
      sendAt: new Date(Date.now() - 60_000).toISOString(),
      createdAt: new Date(Date.now() - 3_600_000).toISOString(),
      status: 'pending',
      attempts: 0,
    }),
  );
}

describe('scheduler check command', () => {
  let out: string[];
  beforeEach(async () => {
    await fs.rm(SCHEDULED_DIR, { recursive: true, force: true });
    state.managerArgs.length = 0;
    state.sendMail.mockReset().mockResolvedValue({ messageId: '<m@x>' });
    out = [];
    vi.spyOn(console, 'log').mockImplementation((...a: unknown[]) => {
      out.push(a.join(' '));
    });
  });
  afterEach(() => vi.restoreAllMocks());

  it('sends nothing in read-only mode and says why; the job stays queued', async () => {
    state.readOnly = true;
    await queueOverdueJob();
    const { default: run } = await import('./scheduler.js');
    await run('check');
    expect(state.sendMail).not.toHaveBeenCalled();
    expect(out.join('\n')).toMatch(/Read-only mode is on/);
    expect(
      JSON.parse(await fs.readFile(path.join(SCHEDULED_DIR, `${ID}.json`), 'utf-8')).status,
    ).toBe('pending');
  });

  it('sends when read-only is off, and builds the connection manager with an OAuth service', async () => {
    state.readOnly = false;
    await queueOverdueJob();
    const { default: run } = await import('./scheduler.js');
    await run('check');
    expect(state.sendMail).toHaveBeenCalledTimes(1);
    expect(state.managerArgs[0][1]).toBeInstanceOf(OAuthService);
  });
});
