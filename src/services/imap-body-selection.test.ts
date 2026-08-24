/**
 * get_email used to populate exactly one of bodyText / bodyHtml — whichever
 * single part the selector chose. On multipart/alternative mail whose plain
 * half is a token stub beside the real content, the tool reported the stub as
 * the email. And with only one half fetched, no consumer could ever apply a
 * richer-sibling preference, because the richer sibling was never there.
 *
 * These tests pin the corrected contract on real MIME shapes: both halves are
 * populated when both exist; text output prefers the html-derived text only
 * when it is materially richer (concrete ratio); attachments are never
 * mistaken for bodies.
 *
 * Upstream: codefuturist/email-mcp#66
 */

import { applyBodyFormat } from '../tools/emails.tool.js';
import ImapService from './imap.service.js';

// ---------------------------------------------------------------------------
// applyBodyFormat — the materially-richer rule
// ---------------------------------------------------------------------------

describe('applyBodyFormat chooses between alternative halves', () => {
  const stub = 'This message requires an HTML-capable reader.';
  const paragraphs = [
    'Quarterly numbers at a glance',
    'Revenue up twelve percent year over year',
    'Outlook raised for the next two quarters',
    'Full breakdown lives on the internal dashboard',
    'Questions go to finance, not to this list',
    'Thanks again for a strong quarter',
  ];
  const rich = `<html><body>${paragraphs.map((p) => `<p>${p}</p>`).join('')}</body></html>`;
  const richDerived = paragraphs.join('\n\n');

  it('prefers html-derived text when it is materially richer than the plain stub', () => {
    const out = applyBodyFormat(stub, rich, 'text');
    expect(out).toContain('Revenue up twelve percent');
    expect(out.length).toBeGreaterThan(stub.length * 1.5);
  });

  it('keeps the plain part when it is not merely a stub', () => {
    const plain =
      'Real plain content that stands entirely on its own with plenty of words of detail here.';
    const out = applyBodyFormat(plain, `<p>${plain}</p>`, 'text');
    expect(out).toBe(plain);
  });

  it('falls back to html-derived text when there is no plain half', () => {
    expect(applyBodyFormat(undefined, rich, 'text')).toBe(richDerived);
  });
});

// ---------------------------------------------------------------------------
// getEmail — both halves land on the Email
// ---------------------------------------------------------------------------

const nestedAlternative = {
  type: 'multipart/mixed',
  childNodes: [
    {
      part: '1',
      type: 'multipart/alternative',
      childNodes: [
        { part: '1.1', type: 'text/plain', size: 40 },
        { part: '1.2', type: 'text/html', size: 900 },
      ],
    },
    {
      part: '2',
      type: 'application/pdf',
      disposition: 'attachment',
      dispositionParameters: { filename: 'invoice.pdf' },
      size: 9000,
    },
  ],
};

function buildService(parts: Record<string, string>) {
  const releaseFn = vi.fn();
  const client = {
    usable: true,
    capabilities: new Set<string>(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: releaseFn }),
    fetchOne: vi.fn().mockResolvedValue({
      uid: 42,
      envelope: { subject: 'Marketing', messageId: '<m@k>' },
      flags: [],
      bodyStructure: nestedAlternative,
      headers: Buffer.from('Subject: Marketing\r\n\r\n', 'utf-8'),
    }),
    download: vi.fn().mockImplementation(async (_uid: string, path: string) => ({
      content: (async function* () {
        yield Buffer.from(parts[path] ?? '', 'utf-8');
      })(),
    })),
  };
  const connections = { getImapClient: async () => client };
  return {
    service: new ImapService(connections as never),
    client,
  };
}

describe('getEmail populates both alternative halves', () => {
  it('fetches the plain and html parts, never the attachment', async () => {
    const { service, client } = buildService({
      '1.1': 'See attached.',
      '1.2': '<html><body>Big shiny newsletter content continues here for a while.</body></html>',
    });

    const email = await service.getEmail('test', '42', 'INBOX');

    expect(email.bodyText).toBe('See attached.');
    expect(email.bodyHtml).toContain('newsletter');
    // The attachment is not a body, whatever its size advantage.
    expect(client.download.mock.calls.map((c) => c[1])).toEqual(
      ['1.2', '1.1'].filter((p) => ['1.1', '1.2'].includes(p)),
    );
  });

  it('single-part messages keep exactly one download round trip', async () => {
    const { client } = buildService({ '1': 'plain only' });
    client.fetchOne.mockResolvedValue({
      uid: 7,
      envelope: { subject: 'S', messageId: '<s@x>' },
      flags: [],
      bodyStructure: { type: 'text/plain', size: 10 },
      headers: Buffer.from('Subject: S\r\n\r\n', 'utf-8'),
    });
    client.download.mockImplementation(async (_u: string, path: string) => ({
      content: (async function* () {
        yield Buffer.from(path === '1' ? 'plain only' : '', 'utf-8');
      })(),
    }));

    const svc = new ImapService({ getImapClient: async () => client } as never);
    const email = await svc.getEmail('test', '7', 'INBOX');

    expect(client.download).toHaveBeenCalledTimes(1);
    expect(email.bodyText).toBe('plain only');
    expect(email.bodyHtml).toBeUndefined();
  });
});
