/**
 * Webhook delivery pins two properties of the dispatch path itself:
 *
 * - Requests are sent with redirects disabled, and a 3xx answer is treated as
 *   a failed delivery rather than being followed.
 * - The destination guard runs before anything leaves the process.
 *
 * Upstream: codefuturist/email-mcp#17
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const guardMock = vi.hoisted(() => ({ assert: vi.fn().mockResolvedValue(undefined) }));
const mcpLogMock = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('../logging.js', () => ({ mcpLog: mcpLogMock }));
vi.mock('../safety/webhook-guard.js', () => ({
  assertWebhookTargetAllowed: guardMock.assert,
}));

import type NotifierService from './notifier.service.js';

// Imported after the mocks so it picks them up.
const { default: RealNotifierService } = await import('./notifier.service.js');

function makeService(webhookUrl: string): NotifierService {
  return new RealNotifierService({
    desktop: false,
    sound: false,
    urgencyThreshold: 'high',
    webhookUrl,
    webhookEvents: ['urgent', 'high'],
    desktopCount: 0,
    desktopResetMs: 60_000,
  } as never) as unknown as NotifierService;
}

const payload = {
  account: 'work',
  sender: 'billing@example.invalid',
  subject: 'Invoice',
  priority: 'high' as const,
};

describe('webhook dispatch', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mcpLogMock.mockClear();
    guardMock.assert.mockClear();
  });

  it('sends POSTs with redirects disabled and refuses to follow a 3xx', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 307 });
    vi.stubGlobal('fetch', fetchMock);

    const notifier = makeService('https://hooks.example.invalid/x');
    await (notifier as never as { sendWebhook: (p: unknown) => Promise<void> }).sendWebhook(
      payload,
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, Record<string, unknown>];
    expect(init.redirect).toBe('manual');

    expect(mcpLogMock).toHaveBeenCalledWith(
      'warning',
      'notifier',
      expect.stringContaining('redirect refused'),
    );
  });

  it('runs the destination guard before dispatch', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, status: 200 }));

    const notifier = makeService('https://hooks.example.invalid/x');
    await (notifier as never as { sendWebhook: (p: unknown) => Promise<void> }).sendWebhook(
      payload,
    );

    expect(guardMock.assert).toHaveBeenCalledWith('https://hooks.example.invalid/x');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('never reaches fetch when the guard refuses', async () => {
    guardMock.assert.mockRejectedValue(new Error('must point to a public address'));
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const notifier = makeService('https://rebind.example.invalid/hook');
    await (notifier as never as { sendWebhook: (p: unknown) => Promise<void> }).sendWebhook(
      payload,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(mcpLogMock).toHaveBeenCalledWith(
      'warning',
      'notifier',
      expect.stringContaining('public address'),
    );
  });
});
