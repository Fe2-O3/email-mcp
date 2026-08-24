/**
 * Two wedges used to outlive their own failures:
 *
 * - A failed label-strategy detection stayed cached forever: the pending map
 *   only ever cleared on success or a reconnect event, so every later label
 *   call for that account awaited the same doomed promise.
 * - A pooled SMTP transport that died between messages was handed to every
 *   later send: nothing re-verified the cache on the send path, so sends
 *   failed until restart.
 *
 * Both now recover: detection clears its pending entry when it settles, and
 * a failed send evicts the cached transport so the next call dials fresh.
 *
 * Upstream: codefuturist/email-mcp#55
 */

import { describe, expect, it, vi } from 'vitest';

const detectMock = vi.hoisted(() => vi.fn());

vi.mock('./label-strategy.js', () => ({ detectLabelStrategy: detectMock }));

import ImapService from './imap.service.js';
import SmtpService from './smtp.service.js';

describe('label strategy detection recovers from failure', () => {
  it('re-probes after a failed detection instead of replaying the rejection', async () => {
    const client = { usable: true };
    const connections = {
      getImapClient: vi.fn().mockResolvedValue(client),
    };
    const service = new ImapService(connections as never);

    // First probe fails (transient server hiccup), second succeeds.
    detectMock.mockRejectedValueOnce(new Error('server went away'));
    detectMock.mockResolvedValueOnce({ addLabel: vi.fn(), listLabels: vi.fn() });

    await expect(
      (
        service as never as {
          getLabelStrategy: (a: string) => Promise<unknown>;
        }
      ).getLabelStrategy('work'),
    ).rejects.toThrow(/went away/);

    // The retry must actually re-probe, not await the cached failure.
    const strategy = await (
      service as never as {
        getLabelStrategy: (a: string) => Promise<unknown>;
      }
    ).getLabelStrategy('work');
    expect(strategy).toBeDefined();
    expect(detectMock).toHaveBeenCalledTimes(2);
  });
});

describe('smtp send path evicts dead transports', () => {
  it('invalidates the cached transport when a send fails', async () => {
    const sendMail = vi.fn().mockRejectedValue(new Error('connection died mid-DATA'));
    const connections = {
      getAccount: () => ({ email: 'me@example.invalid', fullName: 'Me' }),
      getSmtpTransport: async () => ({ sendMail }),
      invalidateSmtpTransport: vi.fn(),
    };
    const service = new SmtpService(
      connections as never,
      { tryConsume: () => true } as never,
      { getEmail: async () => ({}) } as never,
    );

    await expect(
      service.sendEmail('work', {
        to: ['c@example.invalid'],
        subject: 's',
        body: 'b',
      }),
    ).rejects.toThrow(/died/);

    expect(connections.invalidateSmtpTransport).toHaveBeenCalledWith('work');
  });

  it('does not evict when the send succeeds', async () => {
    const sendMail = vi.fn().mockResolvedValue({ messageId: '<ok@example.invalid>' });
    const connections = {
      getAccount: () => ({ email: 'me@example.invalid', fullName: 'Me' }),
      getSmtpTransport: async () => ({ sendMail }),
      invalidateSmtpTransport: vi.fn(),
    };
    const service = new SmtpService(
      connections as never,
      { tryConsume: () => true } as never,
      { getEmail: async () => ({}) } as never,
    );

    await service.sendEmail('work', {
      to: ['c@example.invalid'],
      subject: 's',
      body: 'b',
    });

    expect(connections.invalidateSmtpTransport).not.toHaveBeenCalled();
  });
});
