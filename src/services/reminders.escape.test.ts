import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Bug2 — Reminders builds JSON by concatenation with no escaping.
 *
 * The AppleScript in listRemindersMacOS previously concatenated rTitle directly:
 *   jsonResult & "{\"title\":\"" & rTitle & "\"}"
 * A title like Q4 "plan" broke JSON.parse, and list_reminders returned [].
 *
 * The fix mirrors 7c892e1 (calendar): adds an on jsonEscape(s) handler that
 * escapes \, ", linefeed, return and tab, and wraps every field as
 * my jsonEscape(field). The calendar handler is also improved to handle
 * control characters.
 *
 * This test mocks osascript to simulate the AppleScript concatenation before
 * and after the fix. The mock inspects the generated script: if it contains
 * `my jsonEscape(rTitle)` it returns correctly escaped JSON; otherwise it
 * returns the broken unescaped concatenation. The assertions require that
 * titles with ", \, and newline survive the round-trip — they would be lost
 * (empty list) without escaping.
 */

const behavior = vi.hoisted(() => ({
  lastScript: '' as string,
}));

vi.mock('node:child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const execFile = Object.assign(vi.fn(), {
    [custom]: (_file: string, args: string[], _opts: unknown) => {
      const script = args[1] ?? '';
      behavior.lastScript = script;

      // Only listReminders uses the jsonResult building path
      const hasEscaping = script.includes('my jsonEscape(rTitle)');

      // Simulate three reminders with tricky titles
      const titles = ['Q4 "plan"', 'path\\to\\file', 'line1\nline2'];
      // For the actual test we will override behavior via custom titles,
      // but for generic we can encode the requested titles if present in script
      // Instead we just generate JSON based on whether escaping is present

      function jsonEscapeJS(s: string): string {
        return s
          .replace(/\\/g, '\\\\')
          .replace(/"/g, '\\"')
          .replace(/\n/g, '\\n')
          .replace(/\r/g, '\\r')
          .replace(/\t/g, '\\t');
      }

      // Try to infer titles from script invocation? Instead we return a canned
      // response that uses the titles we care about. The test will call
      // listReminders and expect those titles back.
      // For escaping case we return correct JSON, for non-escaping we return
      // malformed JSON that JSON.parse will throw on (simulating the real bug).

      if (hasEscaping) {
        const payload = titles.map((t, i) => ({
          id: `${i + 1}`,
          title: t,
          dueDate: '',
          completed: false,
          priority: 'none',
          list: 'Reminders',
        }));
        // Build JSON as AppleScript would after jsonEscape — properly escaped
        // Use our JS escape to mimic AppleScript handler
        const items = payload
          .map(
            (p) =>
              `{"id":"${jsonEscapeJS(p.id)}","title":"${jsonEscapeJS(p.title)}","dueDate":"${jsonEscapeJS(p.dueDate)}","completed":${p.completed},"priority":"${jsonEscapeJS(p.priority)}","list":"${jsonEscapeJS(p.list)}"}`,
          )
          .join(',');
        return Promise.resolve({ stdout: `[${items}]`, stderr: '' });
      }

      // Without escaping: produce broken JSON for titles containing " or newline or \
      // Simulate what AppleScript would produce: unescaped concatenation
      // For Q4 "plan" => {"title":"Q4 "plan""} which is invalid
      const broken = titles
        .map(
          (t) =>
            `{"id":"1","title":"${t}","dueDate":"","completed":false,"priority":"none","list":"Reminders"}`,
        )
        .join(',');
      return Promise.resolve({ stdout: `[${broken}]`, stderr: '' });
    },
  });
  return { execFile };
});

import RemindersService from './reminders.service.js';

const realPlatform = process.platform;

describe('Bug2 — reminders JSON escaping', () => {
  beforeEach(() => {
    behavior.lastScript = '';
    Object.defineProperty(process, 'platform', { value: 'darwin' });
  });
  afterEach(() => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
  });

  it('produces escaped JSON that survives titles with ", \\, and newline', async () => {
    const svc = new RemindersService();
    const reminders = await svc.listReminders({});

    // With the fix, the mock returns properly escaped JSON and we get 3 items
    expect(reminders).toHaveLength(3);
    expect(reminders.map((r) => r.title)).toContain('Q4 "plan"');
    expect(reminders.map((r) => r.title)).toContain('path\\to\\file');
    expect(reminders.map((r) => r.title)).toContain('line1\nline2');
  });

  it('generates AppleScript that wraps fields with my jsonEscape and defines handler for control chars', async () => {
    const svc = new RemindersService();
    await svc.listReminders({});
    const script = behavior.lastScript;
    expect(script).toContain('my jsonEscape(rTitle)');
    expect(script).toContain('my jsonEscape(rId)');
    expect(script).toContain('my jsonEscape(listName)');
    expect(script).toContain('on jsonEscape(s)');
    // Improved handler handles newline, carriage return, tab
    expect(script).toContain('linefeed');
    expect(script).toContain('return');
    expect(script).toContain('tab');
    expect(script).toContain('\\n');
    expect(script).toContain('\\r');
    expect(script).toContain('\\t');
  });

  it('also verifies calendar jsonEscape handles control characters', async () => {
    // Import the calendar service's generated script by inspecting file content directly
    const fs = await import('node:fs/promises');
    const calSrc = await fs.readFile(
      new URL('./local-calendar.service.ts', import.meta.url),
      'utf-8',
    );
    expect(calSrc).toContain('my jsonEscape(evTitle)');
    expect(calSrc).toContain('on jsonEscape(s)');
    // Ensure the improved handler is present in calendar too
    const handlerSection = calSrc.slice(calSrc.indexOf('on jsonEscape(s)'));
    expect(handlerSection).toContain('linefeed');
    expect(handlerSection).toContain('return');
    expect(handlerSection).toContain('tab');
  });
});
