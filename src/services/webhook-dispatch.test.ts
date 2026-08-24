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
const validateMock = vi.hoisted(() => vi.fn());
vi.mock('../safety/validation.js', () => ({ validateWebhookUrl: validateMock }));
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

// ---------------------------------------------------------------------------
// Wire-level assertion: the JSON that actually arrives on the socket
// ---------------------------------------------------------------------------

import http from 'node:http';
import type { AddressInfo } from 'node:net';

describe('webhook wire body', () => {
  const realFetch = globalThis.fetch.bind(globalThis);
  beforeEach(() => {
    mcpLogMock.mockClear();
    validateMock.mockClear();
    validateMock.mockImplementation(() => {});
    guardMock.assert.mockReset();
    guardMock.assert.mockResolvedValue(undefined);
  });

  it('delivers the documented JSON fields to a real HTTP endpoint', async () => {
    const seen: Array<Record<string, unknown>> = [];
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        try {
          seen.push(JSON.parse(Buffer.concat(chunks).toString('utf-8')));
        } catch {
          seen.push({});
        }
        res.writeHead(200);
        res.end('ok');
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;

    vi.stubGlobal(
      'fetch',
      // Real fetch against the local listener; redirect stays manual so the
      // production option is exercised end to end. The real fetch is captured
      // BEFORE stubbing, or the stub would recurse into itself.
      vi
        .fn()
        .mockImplementation(async (url: string | URL, init?: RequestInit) =>
          realFetch(url, { ...init, redirect: 'manual' } as RequestInit),
        ),
    );

    const notifier = makeService(`http://127.0.0.1:${port}/hook`);
    await (notifier as never as { sendWebhook: (p: unknown) => Promise<void> }).sendWebhook({
      event: 'email.high',
      account: 'work',
      sender: 'billing@example.invalid',
      subject: 'Invoice',
      priority: 'high',
      labels: ['billing'],
      rule: 'invoices',
      uid: 4821,
      messageId: '<abc@sender.invalid>',
      folder: 'INBOX',
      hasAttachments: true,
    });

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      account: 'work',
      sender: 'billing@example.invalid',
      subject: 'Invoice',
      priority: 'high',
      uid: 4821,
      messageId: '<abc@sender.invalid>',
      folder: 'INBOX',
      hasAttachments: true,
    });

    server.close();
  }, 15_000);
});
