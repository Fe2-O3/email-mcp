/**
 * A webhook consumer that is told "new urgent mail arrived" cannot do anything
 * with it without knowing which message. Before this, the payload carried only
 * account, sender, subject and priority, so the only way to fetch the body was
 * a search by subject and timestamp — ambiguous the moment two messages share
 * a subject, which for automated mail is most of the time.
 *
 * The interesting failure is not "the field is missing from the type". It is
 * "one of the several places that build an alert forgot to populate it", which
 * ships silently and only shows up for whichever notification path the user
 * happens to trigger. So this parameterises over the paths.
 *
 * Upstream: codefuturist/email-mcp#17
 */

import type { EmailMeta } from '../types/index.js';
import HooksService from './hooks.service.js';
import type { AlertPayload } from './notifier.service.js';

const alert = vi.fn().mockResolvedValue(undefined);

vi.mock('./notifier.service.js', () => ({
  default: class {
    alert = alert;

    stop = vi.fn();

    updateConfig = vi.fn();

    getConfig = vi.fn().mockReturnValue({});
  },
}));

vi.mock('../logging.js', () => ({ mcpLog: vi.fn().mockResolvedValue(undefined) }));

const meta: EmailMeta = {
  id: '4821',
  messageId: '<abc123@sender.invalid>',
  subject: 'Invoice',
  from: { name: 'Biller', address: 'billing@sender.invalid' },
  to: [{ address: 'me@example.invalid' }],
  date: '2026-08-20T09:00:00Z',
  seen: false,
  flagged: false,
  answered: false,
  hasAttachments: true,
  labels: [],
};

const email = { account: 'work', mailbox: 'INBOX', meta };

function hooks(config: Record<string, unknown> = {}) {
  return new HooksService(
    {
      onNewEmail: 'notify',
      preset: 'priority-focus',
      autoLabel: false,
      autoFlag: false,
      batchDelay: 0,
      rules: [],
      alerts: {},
      ...config,
    } as never,
    {
      addLabel: vi.fn().mockResolvedValue(undefined),
      setFlags: vi.fn().mockResolvedValue(undefined),
      markAsRead: vi.fn().mockResolvedValue(undefined),
    } as never,
  );
}

/** Every payload handed to the notifier so far. */
function payloads(): AlertPayload[] {
  return alert.mock.calls.map((c) => c[0] as AlertPayload);
}

function expectIdentity(payload: AlertPayload): void {
  expect(payload.uid).toBe('4821');
  expect(payload.messageId).toBe('<abc123@sender.invalid>');
  expect(payload.folder).toBe('INBOX');
  expect(payload.hasAttachments).toBe(true);
}

describe('alert payloads carry enough identity to fetch the message', () => {
  beforeEach(() => {
    alert.mockClear();
  });

  it('notify path', async () => {
    const service = hooks();
    await (service as never as { notifyBatch: (e: unknown[]) => Promise<void> }).notifyBatch([
      email,
    ]);

    expect(payloads()).toHaveLength(1);
    expectIdentity(payloads()[0]);
  });

  it('static rule path', async () => {
    const service = hooks();
    await (
      service as never as {
        applyStaticRule: (e: unknown, r: unknown) => Promise<void>;
      }
    ).applyStaticRule(email, {
      name: 'invoices',
      actions: { alert: true, labels: ['billing'] },
    });

    expect(payloads()).toHaveLength(1);
    expectIdentity(payloads()[0]);
  });

  it('ai triage path', async () => {
    const service = hooks();
    await (
      service as never as {
        applySingleTriage: (e: unknown, t: unknown) => Promise<void>;
      }
    ).applySingleTriage(email, { priority: 'urgent', labels: ['billing'] });

    expect(payloads()).toHaveLength(1);
    expectIdentity(payloads()[0]);
  });

  it('the watcher builds meta with a messageId, not an empty one', async () => {
    const { messageToEmailMeta } = await import('./imap.service.js');
    const built = messageToEmailMeta({
      uid: 4821,
      flags: [],
      envelope: {
        subject: 'Invoice',
        messageId: '<abc123@sender.invalid>',
        from: [{ address: 'billing@sender.invalid' }],
        to: [{ address: 'me@example.invalid' }],
        date: new Date('2026-08-20T09:00:00Z'),
      },
    });

    // The IDLE watcher is the path that actually feeds the webhook, so an
    // empty messageId here would make the other three tests pass and the
    // feature still not work in production.
    expect(built.messageId).toBe('<abc123@sender.invalid>');
  });
});
