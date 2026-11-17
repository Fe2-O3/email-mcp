import type { IConnectionManager } from '../connections/types.js';
import ImapService, { assembleEmail, fetchBodyBundle } from './imap.service.js';

function downloadYielding(text: string) {
  return {
    content: (async function* gen() {
      yield Buffer.from(text, 'utf-8');
    })(),
  };
}

interface Fixture {
  name: string;
  msg: Record<string, unknown>;
  parts: Record<string, string>;
}

const date = new Date('2026-08-01T10:00:00Z');
const headers = (extra = '') =>
  Buffer.from(`Subject: Test\r\nFrom: a@b.c\r\n${extra}\r\n`, 'utf-8');

const fixtures: Fixture[] = [
  {
    name: 'single-part plain',
    msg: {
      uid: 7,
      envelope: { subject: 'Plain', messageId: '<p@x>', date, from: [{ address: 'a@b.c' }] },
      flags: new Set(['\\Seen']),
      bodyStructure: { type: 'text/plain', size: 10 },
      headers: headers(),
    },
    parts: { '1': 'hello plain' },
  },
  {
    name: 'multipart/alternative',
    msg: {
      uid: 7,
      envelope: { subject: 'Alt', messageId: '<a@x>', date, to: [{ address: 'to@b.c' }] },
      flags: new Set<string>(),
      bodyStructure: {
        type: 'multipart/alternative',
        childNodes: [
          { part: '1', type: 'text/plain', size: 300 },
          { part: '2', type: 'text/html', size: 600 },
        ],
      },
      headers: headers(),
    },
    parts: { '1': 'alt plain', '2': '<p>alt html</p>' },
  },
  {
    name: 'html only',
    msg: {
      uid: 7,
      envelope: { subject: 'Html', messageId: '<h@x>', date },
      flags: new Set<string>(),
      bodyStructure: { type: 'text/html', size: 100 },
      headers: headers(),
    },
    parts: { '1': '<b>only html</b>' },
  },
  {
    name: 'stub plain with big html',
    msg: {
      uid: 7,
      envelope: { subject: 'Stub', messageId: '<s@x>', date },
      flags: new Set<string>(),
      bodyStructure: {
        type: 'multipart/alternative',
        childNodes: [
          { part: '1', type: 'text/plain', size: 40 },
          { part: '2', type: 'text/html', size: 5000 },
        ],
      },
      headers: headers(),
    },
    parts: { '1': 'Please use an HTML reader', '2': '<h1>real content</h1>' },
  },
  {
    name: 'attachment plus text',
    msg: {
      uid: 7,
      envelope: { subject: 'Att', messageId: '<t@x>', date },
      flags: new Set(['\\Flagged', 'Work']),
      bodyStructure: {
        type: 'multipart/mixed',
        childNodes: [
          { part: '1', type: 'text/plain', size: 20 },
          {
            part: '2',
            type: 'application/pdf',
            disposition: 'attachment',
            dispositionParameters: { filename: 'a.pdf' },
            size: 9000,
          },
        ],
      },
      headers: headers(),
    },
    parts: { '1': 'see attached' },
  },
  {
    name: 'folded References',
    msg: {
      uid: 7,
      envelope: { subject: 'Re: thread', messageId: '<r@x>', inReplyTo: '<q@x>', date },
      flags: new Set<string>(),
      bodyStructure: { type: 'text/plain', size: 5 },
      headers: headers(
        'References: <a@x>\r\n <b@x>\r\n\t<c@x>\r\nList-Unsubscribe: <mailto:u@x>\r\n',
      ),
    },
    parts: { '1': 'reply' },
  },
  {
    name: 'missing date',
    msg: {
      uid: 7,
      envelope: { messageId: '<n@x>' },
      flags: new Set<string>(),
      bodyStructure: { type: 'text/plain', size: 5 },
      headers: headers(),
    },
    parts: { '1': 'no date' },
  },
];

function makeClient(fixture: Fixture, failing = false) {
  return {
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    fetchOne: vi.fn().mockResolvedValue(fixture.msg),
    download: vi.fn(async (_uid: string, part: string) => {
      if (failing) throw new Error('boom');
      return downloadYielding(fixture.parts[part] ?? '');
    }),
  };
}

describe('assembleEmail', () => {
  it.each(fixtures)('matches the live getEmail output: $name', async (fixture) => {
    const client = makeClient(fixture);
    const connections = {
      getImapClient: vi.fn().mockResolvedValue(client),
    } as unknown as IConnectionManager;
    const service = new ImapService(connections);
    const live = await service.getEmail('acct', '7', 'INBOX');
    service.dispose();

    const bundle = await fetchBodyBundle(
      fixture.msg,
      client as unknown as Parameters<typeof fetchBodyBundle>[1],
      7,
    );
    // What the cache stores and returns: a JSON round trip, which turns Date
    // objects into ISO strings.
    const cached = JSON.parse(JSON.stringify(bundle)) as typeof bundle;
    const assembled = assembleEmail(cached, fixture.msg.flags as Set<string>, 7);

    // Dates without an envelope date use "now", so compare around it.
    if (fixture.name === 'missing date') {
      expect(Math.abs(Date.parse(assembled.date) - Date.parse(live.date))).toBeLessThan(5000);
      expect({ ...assembled, date: '' }).toEqual({ ...live, date: '' });
    } else {
      expect(assembled).toEqual(live);
    }
    expect(bundle.complete).toBe(true);
  });

  it('marks the bundle incomplete when a selected part fails to download', async () => {
    const fixture = fixtures[1];
    const client = makeClient(fixture, true);

    const bundle = await fetchBodyBundle(
      fixture.msg,
      client as unknown as Parameters<typeof fetchBodyBundle>[1],
      7,
    );

    expect(bundle.complete).toBe(false);
    expect(bundle.bodyText).toBeUndefined();
  });

  it('is complete when no text part exists', async () => {
    const fixture: Fixture = {
      name: 'x',
      msg: { ...fixtures[0].msg, bodyStructure: { type: 'application/pdf', size: 1 } },
      parts: {},
    };
    const bundle = await fetchBodyBundle(
      fixture.msg,
      makeClient(fixture) as unknown as Parameters<typeof fetchBodyBundle>[1],
      7,
    );
    expect(bundle.complete).toBe(true);
  });
});
