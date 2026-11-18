/**
 * A scheduled email belongs to the mailbox it was written for. If the
 * account name now points at another server or login, or is gone, the job
 * must not go out from whatever mailbox holds the name today.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { SCHEDULED_DIR } from '../config/xdg.js';
import audit from '../safety/audit.js';
import type { ScheduledEmail } from '../types/index.js';
import SchedulerService from './scheduler.service.js';

const ID = '22222222-2222-4222-8222-222222222222';

function job(over: Partial<ScheduledEmail> = {}): ScheduledEmail {
  return {
    id: ID,
    account: 'work',
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

async function put(j: ScheduledEmail): Promise<void> {
  await fs.mkdir(SCHEDULED_DIR, { recursive: true });
  await fs.writeFile(path.join(SCHEDULED_DIR, `${j.id}.json`), JSON.stringify(j));
}

async function readBack(): Promise<ScheduledEmail> {
  return JSON.parse(await fs.readFile(path.join(SCHEDULED_DIR, `${ID}.json`), 'utf-8'));
}

function service(send: ReturnType<typeof vi.fn>, identity: (name: string) => string | undefined) {
  const imap = {
    trashDraft: vi.fn().mockResolvedValue([]),
    saveDraft: vi.fn().mockResolvedValue({ id: undefined }),
  };
  return new SchedulerService({ sendEmail: send } as never, imap as never, false, identity);
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

describe('scheduled mail and the account it was written for', () => {
  it('records which server and login the account pointed at', async () => {
    const scheduled = await service(ok(), () => 'server-a').schedule('work', {
      to: ['x@example.invalid'],
      subject: 'Later',
      body: 'b',
      sendAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    expect(scheduled.accountFingerprint).toBe('server-a');
  });

  it('sends when the account still points at the same mailbox', async () => {
    await put(job({ accountFingerprint: 'server-a' }));
    const send = ok();
    const result = await service(send, () => 'server-a').checkAndSend();
    expect(result.sent).toBe(1);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('does not send when the account name now points at another server or login', async () => {
    await put(job({ accountFingerprint: 'server-a' }));
    const send = ok();
    const result = await service(send, () => 'server-b').checkAndSend();
    expect(send).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    const back = await readBack();
    expect(back.status).toBe('failed');
    expect(back.lastError).toMatch(/different server or login/);
  });

  it('does not send, and says why, when the account was removed', async () => {
    await put(job({ accountFingerprint: 'server-a' }));
    const send = ok();
    const result = await service(send, () => undefined).checkAndSend();
    expect(send).not.toHaveBeenCalled();
    expect(result.failed).toBe(1);
    expect((await readBack()).lastError).toMatch(/no longer exists/);
  });

  it('still sends a job written before accounts were recorded', async () => {
    await put(job());
    const send = ok();
    await service(send, () => 'server-a').checkAndSend();
    expect(send).toHaveBeenCalledTimes(1);
  });
});
