import { describe, expect, it, vi } from 'vitest';

import registerCalendarTools from '../tools/calendar.tool.js';
import type { HooksConfig } from '../types/index.js';
import HooksService from './hooks.service.js';

vi.mock('./notifier.service.js', () => ({
  default: class {
    notify = vi.fn().mockResolvedValue(undefined);
    start = vi.fn();
    stop = vi.fn();
  },
}));

const addEvent = vi.fn().mockResolvedValue({ status: 'added', message: 'ok' });
vi.mock('./local-calendar.service.js', () => ({
  default: class {
    addEvent = addEvent;
  },
}));

const mcpLog = vi.fn().mockResolvedValue(undefined);
vi.mock('../logging.js', () => ({ mcpLog: (...a: unknown[]) => mcpLog(...a) }));

const undatedEmail = {
  id: '7',
  subject: 'Lunch?',
  from: { address: 'a@example.com' },
  date: 'date unknown',
  bodyText: 'see you',
  bodyHtml: '',
  attachments: [{ filename: 'x.pdf' }],
};

function fakeImap() {
  return {
    getEmail: vi.fn().mockResolvedValue(undatedEmail),
    getCalendarParts: vi.fn().mockResolvedValue([]),
    saveEmailAttachments: vi.fn().mockResolvedValue([]),
  };
}
describe('calendar paths with a "date unknown" email', () => {
  it('the hook skips it, saves nothing and never reaches the calendar', async () => {
    addEvent.mockClear();
    const imap = fakeImap();
    const hooks = new HooksService(
      {
        onNewEmail: 'notify',
        preset: 'custom',
        autoCalendar: true,
        calendarName: '',
        calendarAlarmMinutes: 15,
        calendarConfirm: true,
        batchDelay: 1,
        rules: [],
        alerts: { desktop: false, sound: false, urgencyThreshold: 'high', webhookUrl: '' },
      } as unknown as HooksConfig,
      imap as never,
    );
    await (
      hooks as unknown as {
        applyCalendarAction: (e: unknown) => Promise<void>;
      }
    ).applyCalendarAction({ account: 'work', mailbox: 'INBOX', meta: { id: '7' } });
    expect(addEvent).not.toHaveBeenCalled();
    expect(imap.saveEmailAttachments).not.toHaveBeenCalled();
    expect(mcpLog).toHaveBeenCalledWith('warning', 'hooks', expect.stringContaining('no usable'));
    hooks.stop();
  });

  it('add_to_calendar refuses it with a clear message and saves nothing', async () => {
    const imap = fakeImap();
    const local = { addEvent: vi.fn() };
    const handlers = new Map<string, (args: unknown) => Promise<unknown>>();
    const server = {
      registerTool: (name: string, _cfg: unknown, fn: (args: unknown) => Promise<unknown>) => {
        handlers.set(name, fn);
      },
    } as never;
    registerCalendarTools(
      server,
      imap as never,
      { extractFromParts: vi.fn() } as never,
      local as never,
      {} as never,
      false,
    );
    const result = (await handlers.get('add_to_calendar')?.({
      account: 'work',
      email_id: '7',
      mailbox: 'INBOX',
      alarm_minutes: 15,
      save_attachments: true,
    })) as { isError?: boolean; content: { text: string }[] };
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain('no usable date or time');
    expect(imap.saveEmailAttachments).not.toHaveBeenCalled();
    expect(local.addEvent).not.toHaveBeenCalled();
  });
});
