import ClipboardService from '../services/clipboard.service.js';
import type { AppConfig } from '../types/index.js';
import registerVerificationTool from './verification.tool.js';

describe('get_verification_code tool', () => {
  const date = new Date().toISOString();
  const imap = {
    listEmails: vi.fn().mockResolvedValue({
      items: [
        {
          id: '7',
          messageId: '<verification@example.test>',
          subject: 'Your verification code',
          from: { name: 'Example', address: 'no-reply@example.test' },
          to: [{ address: 'user@example.test' }],
          date,
          seen: false,
          flagged: false,
          answered: false,
          hasAttachments: false,
          labels: [],
        },
      ],
    }),
    getEmail: vi.fn().mockResolvedValue({
      bodyText: 'Your verification code is 482913. It expires in 10 minutes.',
    }),
  };
  const config = {
    accounts: [{ name: 'personal' }],
    settings: {
      readOnly: false,
      verification: { enabled: true, includeMagicLinks: false },
    },
  } as unknown as AppConfig;

  let handler: (params: Record<string, unknown>) => Promise<Record<string, unknown>>;

  beforeEach(() => {
    vi.clearAllMocks();
    const server = {
      registerTool: vi.fn((_name: string, _metadata: unknown, callback: typeof handler) => {
        handler = callback;
      }),
    };
    registerVerificationTool(server as never, imap as never, config);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the code but does not write the clipboard by default', async () => {
    const copy = vi.spyOn(ClipboardService.prototype, 'copy').mockResolvedValue(undefined);
    const result = await handler({
      mailbox: 'INBOX',
      lookback_minutes: 15,
      max_messages: 20,
      copy_to_clipboard: false,
    });

    expect(copy).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({ found: true, value: '482913', copied: false });
  });

  it('writes the value only when explicitly requested', async () => {
    const copy = vi.spyOn(ClipboardService.prototype, 'copy').mockResolvedValue(undefined);
    const result = await handler({
      mailbox: 'INBOX',
      lookback_minutes: 15,
      max_messages: 20,
      copy_to_clipboard: true,
    });

    expect(copy).toHaveBeenCalledWith('482913');
    expect(result.structuredContent).toMatchObject({ found: true, copied: true });
  });

  it('blocks clipboard writes in read-only mode', async () => {
    const copy = vi.spyOn(ClipboardService.prototype, 'copy').mockResolvedValue(undefined);
    const readOnlyConfig = {
      ...config,
      settings: { ...config.settings, readOnly: true },
    } as AppConfig;
    const server = {
      registerTool: vi.fn((_name: string, _metadata: unknown, callback: typeof handler) => {
        handler = callback;
      }),
    };
    registerVerificationTool(server as never, imap as never, readOnlyConfig);

    const result = await handler({
      mailbox: 'INBOX',
      lookback_minutes: 15,
      max_messages: 20,
      copy_to_clipboard: true,
    });

    expect(copy).not.toHaveBeenCalled();
    expect(result.structuredContent).toMatchObject({
      found: true,
      copied: false,
      copy_error: expect.stringContaining('read-only'),
    });
  });
});
