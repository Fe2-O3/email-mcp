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
  handler: (args: Record<string, unknown>) => Promise<unknown>;
}

function capture(serverCalls: CapturedTool[]) {
  return {
    registerTool: (
      name: string,
      cfg: { annotations?: { readOnlyHint?: boolean } },
      handler: CapturedTool['handler'],
    ): void => {
      serverCalls.push({ name, annotations: cfg.annotations, handler });
    },
  };
}

function hooksStub(alerts: AlertsConfig, notifier?: unknown): HooksService {
  return {
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

  it('a webhook URL that fails safety validation is rejected at set time', async () => {
    const { default: RealNotifierService } = await import('../services/notifier.service.js');
    const notifier = new RealNotifierService(alertsConfig());
    try {
      const captured: CapturedTool[] = [];
      const hooks = hooksStub(alertsConfig(), notifier);

      registerWatcherWriteTools(capture(captured) as never, hooks);
      const configure = captured.find((t) => t.name === 'configure_alerts');
      if (!configure) throw new Error('configure_alerts not registered');

      // Loopback literal: set-time validation must refuse it rather than
      // accept silently and only fail at dispatch.
      const result = await configure.handler({ webhook_url: 'http://127.0.0.1:8080/admin' });

      expect(result).toMatchObject({ isError: true });
      expect(notifier.getConfig().webhookUrl).toBe('');
    } finally {
      notifier.stop();
    }
  }, 15_000);

  it('an empty webhook URL still disables the hook', async () => {
    const captured: CapturedTool[] = [];
    const hooks = hooksStub({ ...alertsConfig(), webhookUrl: 'https://hooks.example.invalid/x' });

    registerWatcherWriteTools(capture(captured) as never, hooks);
    const configure = captured.find((t) => t.name === 'configure_alerts');
    if (!configure) throw new Error('configure_alerts not registered');

    const result = await configure.handler({ webhook_url: '' });
    expect(result).not.toMatchObject({ isError: true });
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
