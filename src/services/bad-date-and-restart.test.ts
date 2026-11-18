/**
 * One spam message with "Date: sometime soon" used to fail every list, search,
 * status, contacts and stats call that touched it (new Date(text).toISOString()
 * throws). It now reads "date unknown", or the server's arrival time.
 *
 * Also here: the alert notifier re-arms its per-minute reset when the hooks
 * restart, and stopping the hooks says how much waiting mail it dropped.
 */

import { AccountConfigSchema } from '../config/schema.js';
import type { IConnectionManager } from '../connections/types.js';
import type { HooksConfig } from '../types/index.js';
import HooksService from './hooks.service.js';
import ImapService, { DATE_UNKNOWN, messageToEmailMeta, safeIsoDate } from './imap.service.js';
import NotifierService from './notifier.service.js';

const { logs } = vi.hoisted(() => ({ logs: [] as string[] }));
vi.mock('../logging.js', () => ({
  mcpLog: vi.fn(async (_level: string, _source: string, message: string) => {
    logs.push(message);
  }),
}));

const BAD = {
  subject: 'spam',
  from: [{ address: 's@example.com' }],
  to: [],
  date: 'sometime soon',
};
const GOOD = {
  subject: 'ok',
  from: [{ address: 'a@example.com' }],
  to: [],
  date: new Date('2026-11-01T10:00:00Z'),
};

function clientWith(messages: Record<string, unknown>[]) {
  return {
    usable: true,
    capabilities: new Set<string>(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    list: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue({ messages: messages.length }),
    search: vi.fn().mockResolvedValue(messages.map((m) => m.uid)),
    fetch: vi.fn(() =>
      (async function* gen() {
        for (const m of messages) yield m;
      })(),
    ),
    fetchOne: vi.fn(async (uid: string) => messages.find((m) => String(m.uid) === uid) ?? false),
  };
}

function serviceWith(messages: Record<string, unknown>[]) {
  const client = clientWith(messages);
  const connections = {
    getImapClient: vi.fn().mockResolvedValue(client),
    getAccountNames: () => ['a'],
  } as unknown as IConnectionManager;
  return new ImapService(connections);
}

describe('a Date header that is not a date', () => {
  it('safeIsoDate refuses text that is not a date', () => {
    expect(safeIsoDate('sometime soon')).toBeUndefined();
    expect(safeIsoDate('Mon, 32 Foo 2026 99:99:99 +0000')).toBeUndefined();
    expect(safeIsoDate(new Date(Number.NaN))).toBeUndefined();
    expect(safeIsoDate('Thu, 01 Jan 1970 00:00:00 +0000')).toBe('1970-01-01T00:00:00.000Z');
  });

  it('messageToEmailMeta reads "date unknown", or the arrival time when it has one', () => {
    expect(messageToEmailMeta({ uid: 1, envelope: BAD }).date).toBe(DATE_UNKNOWN);
    expect(
      messageToEmailMeta({ uid: 1, envelope: BAD, internalDate: new Date('2026-11-02T00:00:00Z') })
        .date,
    ).toBe('2026-11-02T00:00:00.000Z');
  });

  it('list_emails and search_emails return the whole page, with the bad row marked', async () => {
    const messages = [
      { uid: 1, envelope: BAD, flags: new Set() },
      { uid: 2, envelope: GOOD, flags: new Set() },
    ];
    const service = serviceWith(messages);
    const listed = await service.listEmails('a', { mailbox: 'INBOX' });
    expect(listed.items.map((e) => [e.id, e.date])).toEqual(
      expect.arrayContaining([
        ['1', DATE_UNKNOWN],
        ['2', '2026-11-01T10:00:00.000Z'],
      ]),
    );
    const found = await service.searchEmails('a', 'spam', { mailbox: 'INBOX' });
    expect(found.items).toHaveLength(2);
    service.dispose();
  });

  it('get_email, get_email_status, contacts and stats do not fail', async () => {
    const messages = [
      {
        uid: 1,
        envelope: BAD,
        flags: new Set(),
        bodyStructure: { type: 'text/plain', size: 0 },
        headers: Buffer.from('Subject: spam\r\n\r\n'),
      },
    ];
    const service = serviceWith(messages);
    await expect(service.getEmail('a', '1', 'INBOX')).resolves.toMatchObject({
      date: DATE_UNKNOWN,
    });
    await expect(service.getEmailFlags('a', '1', 'INBOX')).resolves.toMatchObject({
      date: DATE_UNKNOWN,
    });
    const contacts = await service.extractContacts('a');
    expect(contacts[0]).toMatchObject({ email: 's@example.com', lastSeen: DATE_UNKNOWN });
    const stats = await service.getEmailStats('a', 'INBOX', 'week');
    expect(stats.dailyVolume).toEqual([{ date: 'undated', count: 1 }]);
    service.dispose();
  });
});

describe('IMAP tls and starttls together', () => {
  it('is refused with a message that says what to change', () => {
    const result = AccountConfigSchema.safeParse({
      name: 'work',
      email: 'me@example.com',
      password: 'x',
      imap: { host: 'imap.example.com', tls: true, starttls: true },
      smtp: { host: 'smtp.example.com' },
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((i) => i.message).join('\n')).toMatch(
      /both tls = true and starttls = true/,
    );
  });
});

describe('alerts after the hooks stop and start again', () => {
  it('the desktop limit resets again after a restart', () => {
    vi.useFakeTimers();
    try {
      const notifier = new NotifierService({
        desktop: false,
        sound: false,
        urgencyThreshold: 'high',
        webhookUrl: '',
        webhookEvents: [],
      } as never);
      const internals = notifier as unknown as { desktopCount: number };
      internals.desktopCount = 5;
      notifier.stop();
      vi.advanceTimersByTime(120_000);
      expect(internals.desktopCount).toBe(5);

      notifier.start();
      expect(internals.desktopCount).toBe(0);
      internals.desktopCount = 5;
      vi.advanceTimersByTime(60_000);
      expect(internals.desktopCount).toBe(0);
      notifier.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('stopping with mail still waiting for the batch says so', async () => {
    logs.length = 0;
    const hooks = new HooksService(
      {
        onNewEmail: 'notify',
        batchDelay: 5,
        rules: [],
        preset: 'inbox-zero',
        alerts: { desktop: false, sound: false, urgencyThreshold: 'high', webhookEvents: [] },
      } as unknown as HooksConfig,
      {} as never,
    );
    hooks.start(null);
    const { default: eventBus } = await import('./event-bus.js');
    eventBus.emit('email:new', {
      account: 'a',
      mailbox: 'INBOX',
      emails: [messageToEmailMeta({ uid: 7, envelope: GOOD })],
    });
    hooks.stop();
    await vi.waitFor(() => expect(logs.join('\n')).toMatch(/1 new email\(s\) waiting/));
  });
});
