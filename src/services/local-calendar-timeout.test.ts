/**
 * A timed-out Calendar.app query used to be reported as an empty calendar.
 * Two defects compounded: the osascript budget sat below the real cost of an
 * ordinary multi-calendar setup, so the query was SIGTERM'd every time, and a
 * bare `catch { return [] }` made that hard failure indistinguishable from a
 * calendar with no events.
 *
 * These tests pin the contract: the budget covers real multi-calendar setups,
 * a failed query throws with the cause and the remedy instead of returning [].
 *
 * Upstream: codefuturist/email-mcp#46
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mcpLogMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const behavior = vi.hoisted(() => ({
  mode: 'ok' as 'ok' | 'fail',
  out: '[]',
  calls: [] as unknown[][],
}));

vi.mock('../logging.js', () => ({ mcpLog: mcpLogMock }));
vi.mock('node:child_process', () => {
  // The service wraps execFile in util.promisify, and the real execFile
  // resolves to { stdout, stderr } via its custom-promisify hook. Mirror that,
  // or destructuring breaks no matter what the test asserts.
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const execFile = Object.assign(vi.fn(), {
    [custom]: (_file: string, _args: string[], opts: unknown) => {
      behavior.calls.push([_file, _args, opts]);
      if (behavior.mode === 'ok') {
        return Promise.resolve({ stdout: behavior.out, stderr: '' });
      }
      return Promise.reject(
        Object.assign(new Error('osascript exited abnormally'), { killed: true }),
      );
    },
  });
  return { execFile };
});

import LocalCalendarService from '../services/local-calendar.service.js';

const realPlatform = process.platform;

describe('list_events timeout handling', () => {
  beforeEach(() => {
    mcpLogMock.mockClear();
    behavior.mode = 'ok';
    behavior.out = '[]';
    behavior.calls = [];
    // The macOS path is gated on process.platform; force it so the contract
    // holds on every CI runner, not just macOS ones.
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });

  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  it('gives the query a budget that survives a ten-calendar setup', async () => {
    const service = new LocalCalendarService();
    await service.listEvents({});

    const opts = behavior.calls[0]?.[2] as { timeout?: number } | undefined;
    expect(opts?.timeout).toBe(90_000);
  });

  it('reports a failed query as a failure, never as an empty calendar', async () => {
    behavior.mode = 'fail';

    const service = new LocalCalendarService();

    await expect(service.listEvents({})).rejects.toThrow(/Calendar query failed/);
    await expect(service.listEvents({})).rejects.toThrow(/calendar_name/);
    expect(mcpLogMock).toHaveBeenCalledWith(
      'warning',
      'calendar',
      expect.stringContaining('list_events failed'),
    );
  });

  it('still returns parsed events when the query succeeds', async () => {
    behavior.out =
      '[{"id":"1","title":"Standup","start":"","end":"","location":"","calendar":"Work"}]';

    const service = new LocalCalendarService();
    const events = await service.listEvents({});

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ id: '1', title: 'Standup' });
  });

  it('addresses one calendar directly when calendar_name is given', async () => {
    const service = new LocalCalendarService();
    await service.listEvents({ calendarName: 'Work' });

    const script = (behavior.calls[0]?.[1] as string[] | undefined)?.[1] ?? '';
    expect(script).not.toContain('repeat with c in calendars');
    expect(script).toContain('tell calendar "Work"');
  });

  it('keeps looping all calendars when no calendar is named', async () => {
    const service = new LocalCalendarService();
    await service.listEvents({});

    const script = (behavior.calls[0]?.[1] as string[] | undefined)?.[1] ?? '';
    expect(script).toContain('repeat with c in calendars');
  });

  it('keeps title and limit filters on the direct path', async () => {
    const service = new LocalCalendarService();
    await service.listEvents({ calendarName: 'Work', title: 'Standup', limit: 5 });

    const script = (behavior.calls[0]?.[1] as string[] | undefined)?.[1] ?? '';
    expect(script).toContain('tell calendar "Work"');
    expect(script).toContain('set titleFilter to "Standup"');
    expect(script).toContain('set maxResults to 5');
  });
});
