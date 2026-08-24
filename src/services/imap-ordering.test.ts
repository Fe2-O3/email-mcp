/**
 * list_emails used to slice pages by UID and only then date-sort the slice.
 * A migrated message with a low UID and a recent date therefore landed on the
 * wrong page: page one looked correctly ordered, but the message the user was
 * looking for sat on page four behind months of older mail — or nowhere, if
 * they stopped paging. A per-page sort looks right in every screenshot and is
 * wrong on every mailbox that has ever been migrated.
 *
 * These tests pin the corrected contract: date order spans the WHOLE match
 * set before a page is cut; an explicit uid sort stays reachable; page two
 * continues the ordering instead of restarting it.
 *
 * Upstream: codefuturist/email-mcp#59
 */

import ImapService from './imap.service.js';

interface FakeMsg {
  uid: number;
  internalDate?: Date;
  envelope?: Record<string, unknown>;
  flags?: Set<string>;
  bodyStructure?: unknown;
}

/** UIDs ascend with age here: uid 10 is the OLDEST mail, uid 13 the newest. */
const MAILBOX: FakeMsg[] = [
  { uid: 10, internalDate: new Date('2020-01-01T00:00:00Z') },
  { uid: 11, internalDate: new Date('2019-05-05T00:00:00Z') },
  { uid: 12, internalDate: new Date('2026-08-01T00:00:00Z') },
  { uid: 13, internalDate: new Date('2026-08-20T00:00:00Z') },
];

function buildClient() {
  const releaseFn = vi.fn();
  return {
    usable: true,
    capabilities: new Set<string>(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: releaseFn }),
    search: vi.fn().mockResolvedValue([10, 11, 12, 13]),
    // Two fetch shapes arrive: the cheap {uid, internalDate} pass over the
    // whole range, and the full hydration pass over one page. Distinguish by
    // the requested fields so each test controls exactly what the server says,
    // and honour the requested range like a real server would.
    fetch: vi.fn().mockImplementation((range: string, query: Record<string, unknown>) => {
      const wantsDates = Boolean((query as { internalDate?: boolean }).internalDate);
      const wanted = range.split(',').map(Number);
      return (async function* () {
        for (const msg of MAILBOX) {
          if (!wanted.includes(msg.uid)) continue;
          if (wantsDates) {
            yield { uid: msg.uid, internalDate: msg.internalDate };
          } else {
            yield {
              uid: msg.uid,
              envelope: {
                subject: `msg ${msg.uid}`,
                date: msg.internalDate,
                from: [{ name: '', address: 'a@example.invalid' }],
                to: [{ name: '', address: 'b@example.invalid' }],
              },
              flags: new Set<string>(),
              bodyStructure: undefined,
            };
          }
        }
      })();
    }),
  };
}

function buildService(client: ReturnType<typeof buildClient>): ImapService {
  const connections = {
    getImapClient: async () => client,
  };
  return new ImapService(connections as never);
}

describe('list ordering spans pages', () => {
  it('date sort puts the newest message on page 1 even though its UID is high', async () => {
    const svc = buildService(buildClient());

    const page1 = await svc.listEmails('test', { page: 1, pageSize: 2 });
    expect(page1.items.map((m) => m.id)).toEqual(['13', '12']);

    // Page 2 continues the global ordering rather than restarting it.
    const page2 = await svc.listEmails('test', { page: 2, pageSize: 2 });
    expect(page2.items.map((m) => m.id)).toEqual(['10', '11']);
  });

  it('explicit uid sort keeps server-native ascending order across pages', async () => {
    const svc = buildService(buildClient());

    const page1 = await svc.listEmails('test', { page: 1, pageSize: 2, sort: 'uid' });
    expect(page1.items.map((m) => m.id)).toEqual(['10', '11']);

    const page2 = await svc.listEmails('test', { page: 2, pageSize: 2, sort: 'uid' });
    expect(page2.items.map((m) => m.id)).toEqual(['12', '13']);
  });

  it('a low-UID newcomer surfaces on page 1 in date mode', async () => {
    // The migration case from the issue: an old server's mail imported today.
    const client = buildClient();
    MAILBOX.unshift({ uid: 9, internalDate: new Date('2026-08-22T00:00:00Z') });
    client.search.mockResolvedValue([9, 10, 11, 12, 13]);

    const svc = buildService(client);
    const page1 = await svc.listEmails('test', { page: 1, pageSize: 3 });
    expect(page1.items[0].id).toBe('9');
  });
});
