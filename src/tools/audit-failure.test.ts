/**
 * A full or unwritable audit folder must not turn a finished action into a
 * reported failure: the caller would retry a mail that already went out.
 */

import fs from 'node:fs/promises';

import registerSendTools from './send.tool.js';

vi.mock('node:fs/promises');

type Result = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

function buildHandlers(smtp: Record<string, unknown>) {
  const handlers = new Map<string, Handler>();
  registerSendTools(
    {
      registerTool: (name: string, _cfg: unknown, h: Handler) => {
        handlers.set(name, h);
      },
    } as never,
    smtp as never,
  );
  return handlers;
}

describe('tools when the audit log cannot be written', () => {
  let stderr: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    vi.mocked(fs.mkdir).mockRejectedValue(new Error('ENOSPC: no space left on device'));
    stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
  });
  afterEach(() => {
    stderr.mockRestore();
  });

  it('send_email still reports success', async () => {
    const send = vi.fn().mockResolvedValue({ messageId: '<m@x>', status: 'sent' });
    const result = await buildHandlers({ sendEmail: send }).get('send_email')?.({
      account: 'a',
      to: ['b@example.invalid'],
      subject: 'Hi',
      body: 'x',
    });
    expect(result?.isError).toBeUndefined();
    expect(result?.content[0].text).toMatch(/sent successfully/);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it('a failed send returns its own error, not a second audit error', async () => {
    const send = vi.fn().mockRejectedValue(new Error('refused'));
    const result = await buildHandlers({ sendEmail: send }).get('send_email')?.({
      account: 'a',
      to: ['b@example.invalid'],
      subject: 'Hi',
      body: 'x',
    });
    expect(result?.isError).toBe(true);
    expect(result?.content[0].text).toBe('Failed to send email: refused');
  });

  it('reply_email names who got the reply and shows the warning', async () => {
    const reply = vi.fn().mockResolvedValue({
      messageId: '<r@x>',
      status: 'sent',
      to: ['attacker@evil.invalid'],
      warnings: ['goes to a different domain'],
    });
    const result = await buildHandlers({ replyToEmail: reply }).get('reply_email')?.({
      account: 'a',
      emailId: '5',
      body: 'x',
    });
    expect(result?.content[0].text).toContain('To: attacker@evil.invalid');
    expect(result?.content[0].text).toContain('goes to a different domain');
  });
});
