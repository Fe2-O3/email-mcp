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

const guardMock = vi.hoisted(() => ({ assert: vi.fn() }));
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

import http from 'node:http';
import type { AddressInfo } from 'node:net';

describe('webhook dispatch', () => {
  beforeEach(() => {
    vi.unstubAllGlobals();
    mcpLogMock.mockClear();
    guardMock.assert.mockClear();
    validateMock.mockClear();
    validateMock.mockImplementation(() => {});
  });

  it('sends POSTs with redirects disabled and refuses to follow a 3xx', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(307, { Location: 'http://127.0.0.1/other' });
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://hooks.example.invalid:${port}/x`;
    guardMock.assert.mockResolvedValue({
      hostname: 'hooks.example.invalid',
      address: '127.0.0.1',
      family: 4,
    });

    const notifier = makeService(url);
    await (notifier as never as { sendWebhook: (p: unknown) => Promise<void> }).sendWebhook(
      payload,
    );

    expect(guardMock.assert).toHaveBeenCalledWith(url);
    expect(mcpLogMock).toHaveBeenCalledWith(
      'warning',
      'notifier',
      expect.stringContaining('redirect refused'),
    );
    server.close();
  });

  it('runs the destination guard before dispatch', async () => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    const url = `http://hooks.example.invalid:${port}/x`;
    guardMock.assert.mockResolvedValue({
      hostname: 'hooks.example.invalid',
      address: '127.0.0.1',
      family: 4,
    });

    const notifier = makeService(url);
    await (notifier as never as { sendWebhook: (p: unknown) => Promise<void> }).sendWebhook(
      payload,
    );

    expect(guardMock.assert).toHaveBeenCalledWith(url);
    // No warning for successful dispatch
    expect(mcpLogMock).not.toHaveBeenCalledWith(
      'warning',
      'notifier',
      expect.stringContaining('redirect'),
    );
    server.close();
  });

  it('never reaches fetch when the guard refuses', async () => {
    guardMock.assert.mockRejectedValue(new Error('must point to a public address'));
    // No server needed — guard fails before connect
    const notifier = makeService('https://rebind.example.invalid/hook');
    await (notifier as never as { sendWebhook: (p: unknown) => Promise<void> }).sendWebhook(
      payload,
    );

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

describe('webhook wire body', () => {
  beforeEach(() => {
    mcpLogMock.mockClear();
    validateMock.mockClear();
    validateMock.mockImplementation(() => {});
    guardMock.assert.mockReset();
    guardMock.assert.mockResolvedValue({
      hostname: '127.0.0.1',
      address: '127.0.0.1',
      family: 4,
    });
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

    // No fetch stub — we use real http.request via pinned target
    const notifier = makeService(`http://127.0.0.1:${port}/hook`);
    guardMock.assert.mockResolvedValue({
      hostname: '127.0.0.1',
      address: '127.0.0.1',
      family: 4,
    });
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
