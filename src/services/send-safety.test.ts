/**
 * Sending safety: no duplicate sends, no automatic retry of an uncertain send,
 * a good send is never reported as failed, and a reply says who got it.
 */

import SmtpService from './smtp.service.js';

function makeService(opts: { sendMail?: ReturnType<typeof vi.fn>; tokens?: number } = {}) {
  const sendMail = opts.sendMail ?? vi.fn().mockResolvedValue({ messageId: '<m@x.invalid>' });
  const invalidate = vi.fn();
  const connections = {
    getAccount: () => ({
      email: 'me@example.invalid',
      username: 'me',
      fullName: 'Me',
      smtp: { host: 'smtp.example.invalid' },
    }),
    getSmtpTransport: async () => ({ sendMail }),
    invalidateSmtpTransport: invalidate,
  };
  let tokens = opts.tokens ?? 10;
  const rate = {
    tryConsume: vi.fn(() => {
      if (tokens <= 0) return false;
      tokens -= 1;
      return true;
    }),
    remaining: () => tokens,
  };
  const imap = {
    getEmail: vi.fn(async () => ({
      messageId: '<orig@boss.invalid>',
      subject: 'Figures',
      from: { address: 'boss@corp.invalid' },
      replyTo: { address: 'attacker@evil.invalid' },
      to: [{ address: 'me@example.invalid' }],
      references: [],
      date: 'x',
    })),
    fetchMessageAttachments: vi.fn(async () => []),
    fetchDraft: vi.fn(async () => ({
      email: { to: [{ address: 'c@example.invalid' }], subject: 'D', bodyText: 'b' },
      mailbox: 'Drafts',
    })),
    trashDraft: vi.fn(async () => []),
    appendSent: vi.fn(async () => ({ appended: true })),
  };
  const svc = new SmtpService(connections as never, rate as never, imap as never);
  return { svc, sendMail, invalidate, rate, imap };
}

const mail = { to: ['c@example.invalid'], subject: 'Invoice', body: 'b' };

function netError(props: Record<string, unknown>, message = 'boom') {
  return Object.assign(new Error(message), props);
}

describe('duplicate send guard', () => {
  it('two identical sends started together produce one send', async () => {
    const { svc, sendMail } = makeService();
    const results = await Promise.allSettled([svc.sendEmail('w', mail), svc.sendEmail('w', mail)]);
    expect(results.map((r) => r.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('a retried reply and a retried forward are refused, and send_draft too', async () => {
    const { svc, sendMail } = makeService();
    await svc.replyToEmail('w', { emailId: '5', body: 'hi' });
    await expect(svc.replyToEmail('w', { emailId: '5', body: 'hi' })).rejects.toThrow(
      /allow_duplicate/,
    );
    await svc.forwardEmail('w', { emailId: '5', to: ['z@example.invalid'] });
    await expect(
      svc.forwardEmail('w', { emailId: '5', to: ['z@example.invalid'] }),
    ).rejects.toThrow(/allow_duplicate/);
    await svc.sendDraft('w', 9);
    await expect(svc.sendDraft('w', 9)).rejects.toThrow(/allow_duplicate/);
    expect(sendMail).toHaveBeenCalledTimes(3);
  });

  it('the override lets a deliberate repeat through for reply, forward and draft', async () => {
    const { svc, sendMail } = makeService();
    await svc.replyToEmail('w', { emailId: '5', body: 'hi' });
    await svc.replyToEmail('w', { emailId: '5', body: 'hi', allowDuplicate: true });
    await svc.sendDraft('w', 9);
    await svc.sendDraft('w', 9, undefined, true);
    expect(sendMail).toHaveBeenCalledTimes(4);
  });

  it('a refused duplicate does not use up a send from the rate budget', async () => {
    const { svc, rate } = makeService();
    await svc.sendEmail('w', mail);
    expect(rate.tryConsume).toHaveBeenCalledTimes(1);
    await expect(svc.sendEmail('w', mail)).rejects.toThrow();
    expect(rate.tryConsume).toHaveBeenCalledTimes(1);
  });

  it('a rate-limited send frees its key, so it can go once the limit lifts', async () => {
    const { svc, sendMail } = makeService({ tokens: 0 });
    await expect(svc.sendEmail('w', mail)).rejects.toThrow(/Rate limit/);
    // Not "already being sent" and not a duplicate: the key was released.
    await expect(svc.sendEmail('w', mail)).rejects.toThrow(/Rate limit/);
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('uncertain send', () => {
  it('a timeout after the text went out is reported as unknown and never retried', async () => {
    const sendMail = vi
      .fn()
      .mockRejectedValue(netError({ code: 'ETIMEDOUT' }, 'Connection timeout'));
    const { svc } = makeService({ sendMail });
    await expect(svc.sendEmail('w', mail)).rejects.toThrow(/unknown.*Sent folder|Sent folder/s);
    expect(sendMail).toHaveBeenCalledTimes(1);
    // A second try is blocked by the guard, not sent.
    await expect(svc.sendEmail('w', mail)).rejects.toThrow(/unknown result/);
    expect(sendMail).toHaveBeenCalledTimes(1);
    // The owner can still send on purpose after checking.
    sendMail.mockResolvedValueOnce({ messageId: '<ok@x.invalid>' });
    await expect(svc.sendEmail('w', { ...mail, allowDuplicate: true })).resolves.toMatchObject({
      status: 'sent',
    });
  });

  it('a refused recipient is a definite failure: the key is freed for a corrected retry', async () => {
    const sendMail = vi
      .fn()
      .mockRejectedValueOnce(netError({ code: 'EENVELOPE', responseCode: 550 }, 'No such user'))
      .mockResolvedValue({ messageId: '<ok@x.invalid>' });
    const { svc } = makeService({ sendMail });
    await expect(svc.sendEmail('w', mail)).rejects.toThrow('No such user');
    await expect(svc.sendEmail('w', mail)).resolves.toMatchObject({ status: 'sent' });
  });

  it('a reply that is uncertain is also blocked from an automatic repeat', async () => {
    const sendMail = vi.fn().mockRejectedValue(netError({ code: 'ECONNECTION', command: 'DATA' }));
    const { svc } = makeService({ sendMail });
    await expect(
      svc.forwardEmail('w', { emailId: '5', to: ['z@example.invalid'] }),
    ).rejects.toThrow(/unknown/i);
    await expect(
      svc.forwardEmail('w', { emailId: '5', to: ['z@example.invalid'] }),
    ).rejects.toThrow(/unknown result/);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('shared connection', () => {
  it('a refused recipient does not close the shared connection', async () => {
    const sendMail = vi.fn().mockRejectedValue(netError({ code: 'EENVELOPE', responseCode: 550 }));
    const { svc, invalidate } = makeService({ sendMail });
    await expect(svc.sendEmail('w', mail)).rejects.toThrow();
    expect(invalidate).not.toHaveBeenCalled();
  });

  it('a broken connection still closes it so the next send dials fresh', async () => {
    const sendMail = vi.fn().mockRejectedValue(netError({ code: 'ECONNRESET' }));
    const { svc, invalidate } = makeService({ sendMail });
    await expect(svc.sendEmail('w', mail)).rejects.toThrow();
    expect(invalidate).toHaveBeenCalledWith('w');
  });

  it('two parallel sends where the first is refused: the second is still delivered', async () => {
    const sendMail = vi
      .fn()
      .mockRejectedValueOnce(netError({ code: 'EENVELOPE', responseCode: 550 }))
      .mockResolvedValue({ messageId: '<ok@x.invalid>' });
    const { svc, invalidate } = makeService({ sendMail });
    const [a, b] = await Promise.allSettled([
      svc.sendEmail('w', mail),
      svc.sendEmail('w', { ...mail, subject: 'Other' }),
    ]);
    expect(a.status).toBe('rejected');
    expect(b.status).toBe('fulfilled');
    expect(invalidate).not.toHaveBeenCalled();
  });
});

describe('send_draft cleanup', () => {
  it('a failed move to Trash after the send is a warning, not a failed send', async () => {
    const { svc, imap, sendMail } = makeService();
    imap.trashDraft.mockRejectedValue(new Error('IMAP server rejected moving the draft'));
    const result = await svc.sendDraft('w', 9);
    expect(result.status).toBe('sent');
    expect(result.warnings?.[0]).toMatch(/could not be moved to Trash/);
    expect(sendMail).toHaveBeenCalledTimes(1);
  });
});

describe('reply recipients', () => {
  it('the result lists who got the reply and warns when Reply-To is on another domain', async () => {
    const { svc } = makeService();
    const result = await svc.replyToEmail('w', { emailId: '5', body: 'hi' });
    expect(result.to).toEqual(['attacker@evil.invalid']);
    expect(result.warnings?.[0]).toMatch(/attacker@evil\.invalid.*different domain/);
  });

  it('no warning when Reply-To is on the sender domain', async () => {
    const { svc, imap } = makeService();
    imap.getEmail.mockResolvedValue({
      messageId: '<o@x>',
      subject: 'S',
      from: { address: 'boss@corp.invalid' },
      replyTo: { address: 'desk@corp.invalid' },
      to: [],
      references: [],
      date: 'x',
    } as never);
    const result = await svc.replyToEmail('w', { emailId: '6', body: 'hi' });
    expect(result.to).toEqual(['desk@corp.invalid']);
    expect(result.warnings).toBeUndefined();
  });

  it('the dry run shows the warning too', async () => {
    const { svc } = makeService();
    const plan = await svc.previewReply('w', { emailId: '5', body: 'hi' });
    expect(plan.notes.join('\n')).toMatch(/To: attacker@evil\.invalid/);
    expect(plan.notes.join('\n')).toMatch(/Warning: .*different domain/);
  });
});

describe('forward loop marker', () => {
  it('every forward carries the marker header, so rules elsewhere can refuse it', async () => {
    const { svc, sendMail, imap } = makeService();
    imap.getEmail.mockResolvedValue({
      messageId: '<o@x>',
      subject: 'S',
      from: { address: 'a@x.invalid' },
      to: [{ address: 'me@example.invalid' }],
      bodyText: 'hello',
      date: 'x',
    } as never);
    await svc.forwardEmail('w', { emailId: '5', to: ['z@example.invalid'] });
    expect(sendMail.mock.calls[0][0].headers).toEqual({
      'X-IMAP-Wizard-Forwarded': 'me@example.invalid',
    });
  });
});
