/**
 * Scheduled mail safety: never resend something the server may have taken,
 * never lose a job, keep a short outage from failing it, never send in
 * read-only mode, and leave an audit line for every send.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SCHEDULED_DIR, SCHEDULED_SENT_DIR } from '../config/xdg.js';
import audit from '../safety/audit.js';
import type { ScheduledEmail } from '../types/index.js';
import SchedulerService from './scheduler.service.js';
import { UncertainSendError } from './smtp.service.js';

const ID = '11111111-1111-4111-8111-111111111111';

function job(over: Partial<ScheduledEmail> = {}): ScheduledEmail {
  return {
    id: ID,
    account: 'a',
    to: ['x@example.invalid'],
    subject: 'Hello',
    body: 'b',
    html: false,
    sendAt: new Date(Date.now() - 60_000).toISOString(),
    createdAt: new Date(Date.now() - 3_600_000).toISOString(),
    status: 'pending',
    attempts: 0,
    ...over,
  };
}

async function put(j: ScheduledEmail, suffix = '.json'): Promise<string> {
  await fs.mkdir(SCHEDULED_DIR, { recursive: true });
  const p = path.join(SCHEDULED_DIR, `${j.id}${suffix}`);
  await fs.writeFile(p, JSON.stringify(j));
  return p;
}

async function readBack(suffix = '.json'): Promise<ScheduledEmail> {
  return JSON.parse(await fs.readFile(path.join(SCHEDULED_DIR, `${ID}${suffix}`), 'utf-8'));
}

function service(
  send: ReturnType<typeof vi.fn>,
  opts: { readOnly?: boolean; trash?: ReturnType<typeof vi.fn> } = {},
) {
  const imap = { trashDraft: opts.trash ?? vi.fn().mockResolvedValue([]) };
  return new SchedulerService({ sendEmail: send } as never, imap as never, opts.readOnly ?? false);
}

const ok = () => vi.fn().mockResolvedValue({ messageId: '<m@x>', status: 'sent' });

beforeEach(async () => {
  expect(SCHEDULED_DIR.startsWith(os.tmpdir())).toBe(true);
  await fs.rm(SCHEDULED_DIR, { recursive: true, force: true });
  vi.spyOn(audit, 'log').mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('a send that worked', () => {
  it('moves the job to sent and writes an audit line', async () => {
    await put(job());
    const send = ok();
    const result = await service(send).checkAndSend();
    expect(result).toMatchObject({ sent: 1, failed: 0 });
    expect(
      JSON.parse(await fs.readFile(path.join(SCHEDULED_SENT_DIR, `${ID}.json`), 'utf-8')).status,
    ).toBe('sent');
    expect(audit.log).toHaveBeenCalledWith(
      'scheduled_send',
      'a',
      expect.objectContaining({ scheduleId: ID }),
      'ok',
    );
  });

  it('failing to record it is a warning: the job is marked sent and never resent', async () => {
    await put(job());
    const send = ok();
    const svc = service(send);
    // Writing into the sent folder fails (disk full); every other write works.
    const real = fs.writeFile.bind(fs);
    vi.spyOn(fs, 'writeFile').mockImplementation(async (p, data, opts) => {
      if (String(p).includes(`${path.sep}sent${path.sep}`)) throw new Error('ENOSPC: disk full');
      return real(p, data as never, opts as never);
    });
    const result = await svc.checkAndSend();
    expect(result.sent).toBe(1);
    expect(result.errors.join(' ')).toMatch(/will not be sent again/);
    vi.restoreAllMocks();
    vi.spyOn(audit, 'log').mockResolvedValue(undefined);
    expect((await readBack()).status).toBe('sent');
    // A second pass sends nothing.
    await service(send).checkAndSend();
    expect(send).toHaveBeenCalledTimes(1);
  });
});

describe('a send that failed', () => {
  it('an uncertain result becomes "unknown", is shown, is not retried, and cancel clears it', async () => {
    await put(job());
    const send = vi.fn().mockRejectedValue(new UncertainSendError('Connection timeout'));
    const svc = service(send);
    const first = await svc.checkAndSend();
    expect(first.unknown).toBe(1);
    expect((await readBack()).status).toBe('unknown');
    await svc.checkAndSend();
    expect(send).toHaveBeenCalledTimes(1);
    expect(await svc.list()).toHaveLength(1); // default list shows it
    await expect(svc.cancel(ID)).resolves.toMatchObject({ cancelled: true });
    expect(await svc.list({ status: 'all' })).toHaveLength(0);
  });

  it('three connection refusals keep the job pending, with a later retry time', async () => {
    await put(job());
    const refused = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    const send = vi.fn().mockRejectedValue(refused);
    const svc = service(send);
    for (let i = 0; i < 3; i += 1) {
      // Make it due again each round, as the clock moving past the back-off would.
      const j = await readBack();
      delete j.retryAfter;
      await put(j);
      await svc.checkAndSend();
    }
    const after = await readBack();
    expect(send).toHaveBeenCalledTimes(3);
    expect(after.status).toBe('pending');
    expect(after.attempts).toBe(0);
    expect(new Date(after.retryAfter as string).getTime()).toBeGreaterThan(Date.now());
    // Not due again until the back-off is over.
    await svc.checkAndSend();
    expect(send).toHaveBeenCalledTimes(3);
  });

  it('a refusal by the server counts, and the job fails after three', async () => {
    await put(job());
    const send = vi
      .fn()
      .mockRejectedValue(Object.assign(new Error('550 no such user'), { responseCode: 550 }));
    const svc = service(send);
    for (let i = 0; i < 3; i += 1) {
      const j = await readBack();
      delete j.retryAfter;
      await put(j);
      await svc.checkAndSend();
    }
    expect((await readBack()).status).toBe('failed');
    expect((await svc.list()).map((e) => e.status)).toEqual(['failed']); // visible by default
  });

  it('a failed job can be cancelled', async () => {
    await put(job({ status: 'failed', attempts: 3 }));
    await expect(service(ok()).cancel(ID)).resolves.toMatchObject({ cancelled: true });
  });
});

describe('a crash during a send', () => {
  it('leaves a visible "unknown" job that is never resent, and cancel can clear it', async () => {
    const old = new Date(Date.now() - 3_600_000).toISOString();
    await put(job({ status: 'sending', sendingAt: old }), '.json.sending');
    const send = ok();
    const svc = service(send);
    // Visible even before a scan has run.
    expect((await svc.list({ status: 'all' }))[0].status).toBe('unknown');
    const result = await svc.checkAndSend();
    expect(result.unknown).toBe(1);
    expect(send).not.toHaveBeenCalled();
    expect((await readBack()).status).toBe('unknown');
    await expect(fs.access(path.join(SCHEDULED_DIR, `${ID}.json.sending`))).rejects.toThrow();
    await expect(svc.cancel(ID)).resolves.toMatchObject({ cancelled: true });
  });

  it('a job being sent right now is shown as sending and cannot be cancelled', async () => {
    await put(job({ status: 'sending', sendingAt: new Date().toISOString() }), '.json.sending');
    const svc = service(ok());
    expect((await svc.list())[0].status).toBe('sending');
    await expect(svc.cancel(ID)).rejects.toThrow(/already sending/);
    // The file is untouched.
    expect((await readBack('.json.sending')).status).toBe('sending');
  });
});

describe('cancel while the scheduler picks the job up', () => {
  it('says "already sending" and leaves the draft alone', async () => {
    const trash = vi.fn().mockResolvedValue([]);
    await put(
      job({
        status: 'sending',
        sendingAt: new Date().toISOString(),
        draftMessageId: '5',
        draftMailbox: 'Drafts',
      }),
      '.json.sending',
    );
    await expect(service(ok(), { trash }).cancel(ID)).rejects.toThrow(/already sending/);
    expect(trash).not.toHaveBeenCalled();
  });

  it('a job that is not there is "not found"', async () => {
    await fs.mkdir(SCHEDULED_DIR, { recursive: true });
    await expect(service(ok()).cancel(ID)).rejects.toThrow(/not found/);
  });
});

describe('read-only mode', () => {
  it('sends nothing, keeps the job queued, and says why', async () => {
    await put(job());
    const send = ok();
    const result = await service(send, { readOnly: true }).checkAndSend();
    expect(send).not.toHaveBeenCalled();
    expect(result.sent).toBe(0);
    expect(result.skipped).toMatch(/Read-only mode is on.*1 overdue/);
    expect((await readBack()).status).toBe('pending');
    expect((await readBack()).attempts).toBe(0);
  });
});

describe('old job files', () => {
  it('a job file from before this change still loads and sends', async () => {
    const legacy = job() as Partial<ScheduledEmail>;
    delete legacy.retryAfter;
    delete legacy.retries;
    await put(legacy as ScheduledEmail);
    const send = ok();
    expect((await service(send).checkAndSend()).sent).toBe(1);
  });
});
