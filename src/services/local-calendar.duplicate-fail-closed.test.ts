import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Bug3 — the calendar duplicate check fails open.
 *
 * findExistingEventMacOS previously caught every error and returned
 * { found: false }, so the caller treated a timeout as "no duplicate" and
 * created a duplicate event. The fix makes it return { found: false, error }
 * on failure and makes addEvent refuse to create, returning no_display with a
 * message that the duplicate check could not be completed.
 *
 * Platform "not darwin" is a legitimate not-applicable case and must remain
 * { found: false } without an error.
 */

const mcpLogMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const calls = vi.hoisted(() => [] as string[][]);
const mode = vi.hoisted(() => ({ duplicate: 'error' as 'error' | 'found' | 'notfound' }));

vi.mock('../logging.js', () => ({ mcpLog: mcpLogMock }));
vi.mock('node:child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const execFile = Object.assign(vi.fn(), {
    [custom]: (file: string, args: string[], _opts: unknown) => {
      const script = args[1] ?? '';
      calls.push([file, script]);
      // First call in addEvent is duplicate check (contains searchTitle)
      // Second call is addEventMacOS (contains make new event)
      if (script.includes('searchTitle')) {
        if (mode.duplicate === 'error') {
          return Promise.reject(new Error('osascript timed out'));
        }
        if (mode.duplicate === 'found') {
          return Promise.resolve({
            stdout: '{"found":true,"eventId":"existing-123","calendarName":"Work"}',
            stderr: '',
          });
        }
        return Promise.resolve({ stdout: '{"found":false}', stderr: '' });
      }
      if (script.includes('make new event')) {
        return Promise.resolve({
          stdout: '{"status":"added","eventId":"new-id","calendarName":"Work"}',
          stderr: '',
        });
      }
      // Fallback for other scripts (listEvents etc)
      return Promise.resolve({ stdout: '[]', stderr: '' });
    },
  });
  return { execFile };
});

import LocalCalendarService from './local-calendar.service.js';

const realPlatform = process.platform;

describe('Bug3 — duplicate check fails closed', () => {
  beforeEach(() => {
    calls.length = 0;
    mcpLogMock.mockClear();
    mode.duplicate = 'error';
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  it('when the duplicate check rejects, addEvent does not create an event and surfaces the failure', async () => {
    const svc = new LocalCalendarService();

    const result = await svc.addEvent(
      {
        title: 'Team Standup',
        start: new Date('2026-03-10T09:00:00'),
        end: new Date('2026-03-10T09:30:00'),
      },
      undefined,
      { confirm: false },
    );

    // Must not succeed nor report duplicate — must be no_display with duplicate-check message
    expect(result.status).toBe('no_display');
    expect(result.message).toMatch(/Duplicate check could not be completed/i);
    expect(result.message).toMatch(/not added/i);

    // Only the duplicate-check osascript should have run, not the creator
    const scripts = calls.map((c) => c[1]);
    expect(scripts.some((s) => s.includes('searchTitle'))).toBe(true);
    expect(scripts.some((s) => s.includes('make new event'))).toBe(false);
  });

  it('non-darwin platform remains not-applicable and is not treated as an error', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const svc = new LocalCalendarService();
    const res = await svc.findExistingEvent('Anything', new Date());
    expect(res).toEqual({ found: false });
    // Ensure no error field
    expect((res as { error?: string }).error).toBeUndefined();
  });

  it('when duplicate check succeeds with found:true, addEvent returns duplicate without creating', async () => {
    mode.duplicate = 'found';
    calls.length = 0;
    const svc = new LocalCalendarService();
    const result = await svc.addEvent(
      {
        title: 'Exists',
        start: new Date('2026-03-10T09:00:00'),
        end: new Date('2026-03-10T10:00:00'),
      },
      undefined,
      { confirm: false },
    );

    expect(result.status).toBe('duplicate');
    expect(result.duplicate).toEqual({ eventId: 'existing-123', calendarName: 'Work' });
    // Ensure creator was not called — duplicate short-circuits
    expect(calls.some((c) => c[1].includes('make new event'))).toBe(false);
  });
});
