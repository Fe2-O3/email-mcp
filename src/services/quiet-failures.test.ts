/**
 * Background steps that failed without a word made it look as if templates,
 * alerts, calendars and reminders were fine when they were not.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { registerTemplateReadTools } from '../tools/templates.tool.js';
import type { HooksConfig } from '../types/index.js';
import eventBus from './event-bus.js';
import HooksService from './hooks.service.js';
import LocalCalendarService from './local-calendar.service.js';
import RemindersService from './reminders.service.js';
import TemplateService from './template.service.js';

const mcpLogMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
vi.mock('../logging.js', () => ({ mcpLog: mcpLogMock }));

vi.mock('node:child_process', () => {
  const custom = Symbol.for('nodejs.util.promisify.custom');
  const execFile = Object.assign(vi.fn(), {
    [custom]: () =>
      Promise.reject(
        Object.assign(new Error('Command failed: osascript -e secret script'), {
          stderr: 'Not authorized to send Apple events to Calendar. (-1743)',
        }),
      ),
  });
  return { execFile, exec: vi.fn(), spawn: vi.fn() };
});

const realPlatform = process.platform;

describe('failures that used to be silent', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'quiet-failures-'));
    mcpLogMock.mockClear();
  });

  afterEach(async () => {
    Object.defineProperty(process, 'platform', { value: realPlatform });
    eventBus.removeAllListeners();
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('list_templates names a template file it could not read', async () => {
    await fs.writeFile(
      path.join(dir, 'good.toml'),
      'name = "good"\nsubject = "S"\nbody = "B"\nvariables = []\n',
    );
    await fs.writeFile(path.join(dir, 'broken.toml'), 'name = "broken\nsubject = ');
    let handler: () => Promise<{ content: { text: string }[] }> = async () => ({ content: [] });
    registerTemplateReadTools(
      {
        registerTool: (name: string, _cfg: unknown, h: typeof handler) => {
          if (name === 'list_templates') handler = h;
        },
      } as never,
      new TemplateService(dir),
    );

    const text = (await handler()).content[0].text;

    expect(text).toMatch(/good/);
    expect(text).toMatch(/broken\.toml/);
    expect(text).toMatch(/could not be read/);
  });

  it('logs a batch of new mail that failed to process', async () => {
    const hooks = new HooksService(
      { onNewEmail: 'notify', batchDelay: 0, rules: [], alerts: {} } as unknown as HooksConfig,
      {} as never,
    );
    hooks.attachLocalRules({
      applyToBatch: vi.fn().mockRejectedValue(new Error('rules file unreadable')),
    } as never);
    hooks.start(null);

    eventBus.emit('email:new', {
      account: 'work',
      mailbox: 'INBOX',
      emails: [{ id: '1', subject: 's', from: { address: 'a@b.invalid' } }],
    } as never);

    await vi.waitFor(() =>
      expect(mcpLogMock).toHaveBeenCalledWith(
        'warning',
        'hooks',
        expect.stringMatching(/1 new message.*rules file unreadable/),
      ),
    );
    hooks.stop();
  });

  it('list_calendars reports a refused Calendar instead of "no calendars"', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const error = await new LocalCalendarService().listCalendars().catch((e: Error) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Not authorized/);
    expect((error as Error).message).not.toMatch(/secret script/);
  });

  it('reminders lists report a refused Reminders instead of "none"', async () => {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    const service = new RemindersService();
    await expect(service.listLists()).rejects.toThrow(/Not authorized/);
    await expect(service.listReminders()).rejects.toThrow(/Not authorized/);
  });
});
