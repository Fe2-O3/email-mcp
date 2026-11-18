/**
 * The alerting surface is a write surface: firing a test notification invokes
 * OS tooling, and reconfiguring alerts reroutes where notification payloads
 * go. Both must therefore disappear in read-only mode like every other write
 * tool, and a webhook URL that fails safety validation must be rejected when
 * it is configured, not silently at dispatch time after it has taken effect.
 *
 * Upstream: codefuturist/email-mcp — read_only contract, SECURITY.md.
 */

import { describe, expect, it, vi } from 'vitest';

const auditMock = vi.hoisted(() => ({ log: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../safety/audit.js', () => ({ default: auditMock }));

import type HooksService from '../services/hooks.service.js';
import type NotifierService from '../services/notifier.service.js';
import type WatcherService from '../services/watcher.service.js';
import type { AlertsConfig } from '../types/index.js';
import { registerWatcherReadTools, registerWatcherWriteTools } from './watcher.tool.js';

interface CapturedTool {
  name: string;
  annotations?: { readOnlyHint?: boolean };
  inputSchema?: unknown;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function capture(serverCalls: CapturedTool[]) {
  return {
    registerTool: (
      name: string,
      cfg: { annotations?: { readOnlyHint?: boolean }; inputSchema?: unknown },
      handler: CapturedTool['handler'],
    ): void => {
      serverCalls.push({
        name,
        annotations: cfg.annotations,
        inputSchema: cfg.inputSchema,
        handler,
      });
    },
  };
}

function hooksStub(alerts: AlertsConfig, notifier?: unknown, running = true): HooksService {
  return {
    isRunning: () => running,
    getHooksConfig: () => ({
      onNewEmail: 'notify',
      preset: 'priority-focus',
      autoLabel: false,
      autoFlag: false,
      batchDelay: 5,
      customInstructions: '',
      rules: [],
      alerts,
    }),
    getNotifier: () =>
      (notifier ?? {
        getConfig: () => alerts,
        updateConfig: (partial: Partial<AlertsConfig>) => ({ ...alerts, ...partial }),
        sendTestNotification: async () => ({ success: true, message: 'sent' }),
      }) as never,
  } as unknown as HooksService;
}

const alertsConfig = (): AlertsConfig =>
  ({
    desktop: false,
    sound: false,
    urgencyThreshold: 'high',
    webhookUrl: '',
    webhookEvents: ['urgent', 'high'],
  }) as AlertsConfig;

describe('alerting tools respect the read-only gate', () => {
  const watcherStub = {} as WatcherService;

  it('read-only mode registers only the inspection half', () => {
    const captured: CapturedTool[] = [];
    const hooks = hooksStub(alertsConfig());

    registerWatcherReadTools(capture(captured) as never, watcherStub, hooks);

    const names = captured.map((t) => t.name);
    expect(names.length).toBeGreaterThanOrEqual(4);
    expect(names).toContain('get_watcher_status');
    expect(names).not.toContain('configure_alerts');
    expect(names).not.toContain('test_notification');
  });

  it('with writes enabled both mutating tools are registered and declared as writes', () => {
    const captured: CapturedTool[] = [];
    const hooks = hooksStub(alertsConfig());
    const fakeServer = capture(captured) as never;

    registerWatcherReadTools(fakeServer, watcherStub, hooks);
    registerWatcherWriteTools(fakeServer, hooks);

    for (const name of ['configure_alerts', 'test_notification']) {
      const tool = captured.find((t) => t.name === name);
      expect(tool, `${name} must be registered when writes are enabled`).toBeDefined();
      expect(tool?.annotations?.readOnlyHint).toBe(false);
    }
  });

  it('configure_alerts writes an audit record when it changes something', async () => {
    auditMock.log.mockClear();
    const captured: CapturedTool[] = [];
    const hooks = hooksStub(alertsConfig());

    registerWatcherWriteTools(capture(captured) as never, hooks);
    const configure = captured.find((t) => t.name === 'configure_alerts');
    if (!configure) throw new Error('configure_alerts not registered');

    await configure.handler({ desktop: true });

    expect(auditMock.log).toHaveBeenCalledWith(
      'configure_alerts',
      'system',
      expect.objectContaining({ desktop: true }),
      'ok',
    );
  });

  it('configure_alerts has no webhook fields: only a person can set the webhook in config.toml', async () => {
    const captured: CapturedTool[] = [];
    const hooks = hooksStub({ ...alertsConfig(), webhookUrl: 'https://hooks.example.invalid/x' });
    registerWatcherWriteTools(capture(captured) as never, hooks);
    const configure = captured.find((t) => t.name === 'configure_alerts');
    if (!configure) throw new Error('configure_alerts not registered');

    const keys = Object.keys((configure.inputSchema as { shape: object }).shape);
    expect(keys.sort()).toEqual(['desktop', 'sound', 'urgency_threshold']);

    // Even if a client sends the old fields anyway, they change nothing.
    const result = (await configure.handler({
      webhook_url: 'https://attacker.example/hook',
      webhook_events: ['urgent'],
    })) as { content: { text: string }[] };
    expect(result.content[0].text).toMatch(/No changes specified/);
    expect(result.content[0].text).not.toContain('attacker.example');
  });

  it('read tools show the webhook host but not its secret path', async () => {
    const captured: CapturedTool[] = [];
    const secret = 'https://hooks.slack.example/services/T000/B000/SECRETTOKEN123';
    const hooks = hooksStub({ ...alertsConfig(), webhookUrl: secret });
    registerWatcherReadTools(capture(captured) as never, {} as WatcherService, hooks);
    for (const name of ['get_hooks_config', 'check_notification_setup']) {
      const tool = captured.find((t) => t.name === name);
      if (!tool) throw new Error(`${name} not registered`);
      // eslint-disable-next-line no-await-in-loop
      const out = JSON.stringify(await tool.handler({}));
      expect(out).toContain('hooks.slack.example');
      expect(out).not.toContain('SECRETTOKEN123');
    }
  });

  it('a configure_alerts call in a process that does not run the watcher says it has no effect', async () => {
    const captured: CapturedTool[] = [];
    registerWatcherWriteTools(
      capture(captured) as never,
      hooksStub(alertsConfig(), undefined, false),
    );
    const configure = captured.find((t) => t.name === 'configure_alerts');
    if (!configure) throw new Error('configure_alerts not registered');
    const result = (await configure.handler({ desktop: true })) as { content: { text: string }[] };
    expect(result.content[0].text).toMatch(/another IMAP Wizard process runs the watcher/);
  });

  it('get_watcher_status in a follower says another process holds the watcher', async () => {
    const captured: CapturedTool[] = [];
    const watcher = { getStatus: () => [], isEnabled: () => true } as unknown as WatcherService;
    registerWatcherReadTools(capture(captured) as never, watcher, hooksStub(alertsConfig()));
    const status = captured.find((t) => t.name === 'get_watcher_status');
    if (!status) throw new Error('get_watcher_status not registered');
    const result = (await status.handler({})) as { content: { text: string }[] };
    expect(result.content[0].text).toMatch(/another one holds it/);
  });
});

describe('NotifierService.updateConfig validates at write time', () => {
  it('rejects a private-range webhook URL instead of merging it', async () => {
    const { default: RealNotifierService } = await import('../services/notifier.service.js');
    const notifier = new RealNotifierService(alertsConfig()) as unknown as NotifierService;

    expect(() => notifier.updateConfig({ webhookUrl: 'http://127.0.0.1:8080/admin' })).toThrow();
    expect(notifier.getConfig().webhookUrl).toBe('');
  }, 15_000);
});
