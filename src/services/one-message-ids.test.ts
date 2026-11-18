/**
 * One message means one message.
 *
 * ImapFlow reads a message id as an IMAP sequence set, so "1:*" names every
 * message and "*" names the newest one by position. Every path that means one
 * message must refuse anything but a single decimal UID before it talks to the
 * server, and a write must not claim success for a UID that is not there.
 */

import type { ImapFlow } from 'imapflow';
import type { IConnectionManager } from '../connections/types.js';
import { validateKeywordName, validateLabelName } from '../safety/validation.js';
import registerLocateTools from '../tools/locate.tool.js';
import ImapService from './imap.service.js';
import { detectLabelStrategy } from './label-strategy.js';
import { validateLocalRule } from './local-rules.service.js';

const BAD_IDS = ['1:*', '*', '1,2', '1e3', ' 5', '5 ', '0x10', '123abc', '', '-1', '0'];

function makeClient(present: number[] = []) {
  const release = vi.fn();
  return {
    usable: true,
    mailbox: { path: 'INBOX', uidValidity: 1n },
    capabilities: new Set<string>(),
    getMailboxLock: vi.fn().mockResolvedValue({ release }),
    list: vi.fn().mockResolvedValue([{ name: 'INBOX', path: 'INBOX', listed: true }]),
    fetch: vi.fn().mockReturnValue((async function* empty() {})()),
    fetchOne: vi.fn().mockResolvedValue(null),
    download: vi.fn().mockResolvedValue(null),
    search: vi.fn(async (query: { uid?: string }) =>
      query.uid
        ? query.uid
            .split(',')
            .map(Number)
            .filter((uid) => present.includes(uid))
        : [],
    ),
    messageMove: vi.fn().mockResolvedValue(true),
    messageCopy: vi.fn().mockResolvedValue(true),
    messageDelete: vi.fn().mockResolvedValue(true),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    messageFlagsRemove: vi.fn().mockResolvedValue(true),
  };
}

function makeService(client: ReturnType<typeof makeClient>) {
  const getImapClient = vi.fn().mockResolvedValue(client);
  const connections = {
    getAccount: vi.fn(),
    getAccountNames: vi.fn().mockReturnValue(['a']),
    getImapClient,
    getSmtpTransport: vi.fn(),
    closeAll: vi.fn(),
    invalidateSmtpTransport: vi.fn(),
  } as unknown as IConnectionManager;
  return { service: new ImapService(connections), getImapClient };
}

describe('single-message ids', () => {
  let client: ReturnType<typeof makeClient>;
  let service: ImapService;
  let getImapClient: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    client = makeClient([42]);
    ({ service, getImapClient } = makeService(client));
  });

  afterEach(() => service.dispose());

  const calls: [string, (s: ImapService, id: string) => Promise<unknown>][] = [
    ['moveEmail', (s, id) => s.moveEmail('a', id, 'INBOX', 'Archive')],
    ['deleteEmail to Trash', (s, id) => s.deleteEmail('a', id, 'INBOX')],
    ['deleteEmail permanent', (s, id) => s.deleteEmail('a', id, 'INBOX', true)],
    ['setFlags', (s, id) => s.setFlags('a', id, 'INBOX', 'read')],
    ['addLabel', (s, id) => s.addLabel('a', id, 'INBOX', 'Work')],
    ['removeLabel', (s, id) => s.removeLabel('a', id, 'INBOX', 'Work')],
    ['findEmailFolder', (s, id) => s.findEmailFolder('a', id, 'INBOX')],
    ['getHeaders', (s, id) => s.getHeaders('a', id, 'INBOX')],
    ['getCalendarParts', (s, id) => s.getCalendarParts('a', 'INBOX', id)],
    ['getEmail (get_email)', (s, id) => s.getEmail('a', id, 'INBOX')],
    ['getEmailFlags (get_email_status)', (s, id) => s.getEmailFlags('a', id, 'INBOX')],
    ['getEmailSecurity (get_email_security)', (s, id) => s.getEmailSecurity('a', id, 'INBOX')],
    [
      'downloadAttachment (download_attachment)',
      (s, id) => s.downloadAttachment('a', id, 'INBOX', 'x.pdf'),
    ],
    ['fetchMessageAttachments', (s, id) => s.fetchMessageAttachments('a', id, 'INBOX')],
    ['saveEmailAttachments', (s, id) => s.saveEmailAttachments('a', id, 'INBOX', '/tmp')],
    ['exportEmail', (s, id) => s.exportEmail('a', id, 'INBOX', 1024)],
    ['previewMove', (s, id) => s.previewMove('a', id, 'INBOX', 'Archive')],
    ['previewDelete', (s, id) => s.previewDelete('a', id, 'INBOX', true)],
  ];

  for (const [name, call] of calls) {
    it(`${name} refuses ranges and loose numbers before any IMAP call`, async () => {
      for (const id of BAD_IDS) {
        await expect(call(service, id), `id ${JSON.stringify(id)}`).rejects.toThrow(/numeric UID/);
      }
      expect(getImapClient).not.toHaveBeenCalled();
    });
  }

  it('refuses a UID larger than 32 bits', async () => {
    await expect(service.moveEmail('a', '4294967296', 'INBOX', 'Archive')).rejects.toThrow(
      /larger than any IMAP UID/,
    );
    expect(getImapClient).not.toHaveBeenCalled();
  });

  it('sends the single UID it parsed to the server', async () => {
    await service.moveEmail('a', '42', 'INBOX', 'Archive');
    expect(client.messageMove).toHaveBeenCalledWith('42', 'Archive', { uid: true });
  });
});

describe('writes report missing messages instead of success', () => {
  let client: ReturnType<typeof makeClient>;
  let service: ImapService;

  beforeEach(() => {
    client = makeClient([42]);
    ({ service } = makeService(client));
  });

  afterEach(() => service.dispose());

  it('a move, delete or flag change of a missing UID fails and sends nothing', async () => {
    await expect(service.moveEmail('a', '999', 'INBOX', 'Archive')).rejects.toThrow(/not found/);
    await expect(service.deleteEmail('a', '999', 'INBOX')).rejects.toThrow(/not found/);
    await expect(service.deleteEmail('a', '999', 'INBOX', true)).rejects.toThrow(/not found/);
    await expect(service.setFlags('a', '999', 'INBOX', 'flag')).rejects.toThrow(/not found/);
    expect(client.messageMove).not.toHaveBeenCalled();
    expect(client.messageDelete).not.toHaveBeenCalled();
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('bulk move acts only on ids that exist and names the missing ones', async () => {
    client = makeClient([1, 3]);
    ({ service } = makeService(client));
    const result = await service.bulkMove('a', [1, 2, 3, 4], 'INBOX', 'Archive');
    expect(client.messageMove).toHaveBeenCalledWith('1,3', 'Archive', { uid: true });
    expect(result.total).toBe(4);
    expect(result.succeeded).toBe(2);
    expect(result.failed).toBe(2);
    expect(result.errors?.join(' ')).toMatch(/2 of 4 IDs not found in "INBOX": 2, 4/);
  });

  it('bulk delete and bulk flags count only ids that exist', async () => {
    client = makeClient([7]);
    ({ service } = makeService(client));
    const deleted = await service.bulkDelete('a', [7, 8], 'INBOX', true);
    expect(client.messageDelete).toHaveBeenCalledWith('7', { uid: true });
    expect(deleted).toMatchObject({ total: 2, succeeded: 1, failed: 1 });

    const flagged = await service.bulkSetFlags('a', [7, 8, 9], 'INBOX', 'flag');
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('7', ['\\Flagged'], { uid: true });
    expect(flagged).toMatchObject({ total: 3, succeeded: 1, failed: 2 });
  });

  it('a bulk call where no id exists sends no write at all', async () => {
    client = makeClient([]);
    ({ service } = makeService(client));
    const result = await service.bulkDelete('a', [5, 6], 'INBOX');
    expect(client.messageMove).not.toHaveBeenCalled();
    expect(result).toMatchObject({ total: 2, succeeded: 0, failed: 2 });
  });

  it('bulk refuses ids that are not UIDs', async () => {
    const result = await service.bulkSetFlags('a', [0, -1], 'INBOX', 'flag');
    expect(result.succeeded).toBe(0);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    await expect(service.previewBulk('a', [0], 'INBOX', 'flag')).rejects.toThrow(/not a valid UID/);
  });
});

describe('find_email_folder gives the UID that is valid in the folder it names', () => {
  /** Message-ID <m@x> is UID 9000 in All Mail and UID 17 in INBOX. */
  function gmailLikeClient(inboxHits: number[]) {
    const client = makeClient([9000]);
    client.list.mockResolvedValue([
      { name: 'All Mail', path: '[Gmail]/All Mail', listed: true, specialUse: '\\All' },
      { name: 'INBOX', path: 'INBOX', listed: true, specialUse: '\\Inbox' },
    ]);
    client.fetchOne.mockResolvedValue({ headers: Buffer.from('Message-ID: <m@x>\r\n\r\n') });
    let selected = '';
    client.getMailboxLock.mockImplementation(async (path: string) => {
      selected = path;
      return { release: vi.fn() };
    });
    client.search.mockImplementation(async (query: { uid?: string; header?: unknown }) =>
      query.header && selected === 'INBOX' ? inboxHits : [],
    );
    return client;
  }

  async function runTool(client: ReturnType<typeof makeClient>) {
    const { service } = makeService(client);
    let handler: (params: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
    const server = {
      registerTool: vi.fn((_n: string, _m: unknown, cb: typeof handler) => {
        handler = cb;
      }),
    };
    registerLocateTools(server as never, service);
    // biome-ignore lint/style/noNonNullAssertion: assigned by registerTool above
    const out = await handler!({
      account: 'a',
      emailId: '9000',
      sourceMailbox: '[Gmail]/All Mail',
    });
    service.dispose();
    return out.content[0].text;
  }

  it('returns the UID found in the folder', async () => {
    const { service } = makeService(gmailLikeClient([17]));
    const result = await service.findEmailFolder('a', '9000', '[Gmail]/All Mail');
    service.dispose();
    expect(result).toMatchObject({ folders: ['INBOX'], uids: [17] });
  });

  it('tells the model to use the folder UID, not the original one', async () => {
    const text = await runTool(gmailLikeClient([17]));
    expect(text).toMatch(/emailId 17 with sourceMailbox "INBOX"/);
    expect(text).toMatch(/not 9000/);
    expect(text).not.toMatch(/emailId 9000/);
  });

  it('names every match when the Message-ID is shared, and suggests none of them blindly', async () => {
    const text = await runTool(gmailLikeClient([17, 18]));
    expect(text).toMatch(/UIDs 17, 18/);
    expect(text).not.toMatch(/emailId 17 with/);
  });
});

describe('label names that would act as system flags', () => {
  it('validateLabelName refuses a leading backslash', () => {
    for (const name of ['\\Deleted', '\\deleted', '\\Seen', '\\Trash', ' \\Inbox']) {
      expect(() => validateLabelName(name), name).toThrow(/backslash/);
    }
    expect(validateLabelName('Work/Clients')).toBe('Work/Clients');
    expect(validateLabelName('My Label')).toBe('My Label');
  });

  it('validateKeywordName refuses characters an IMAP keyword cannot hold', () => {
    for (const name of ['a b', 'Café', '(x', 'x)', '{x', '50%', 'a*', 'say"hi', 'x]']) {
      expect(() => validateKeywordName(name), name).toThrow(/IMAP keywords/);
    }
    expect(validateKeywordName('Work-2024_$done')).toBe('Work-2024_$done');
  });

  function keywordClient() {
    const client = makeClient([1]);
    (client as unknown as { mailbox: unknown }).mailbox = { permanentFlags: new Set(['\\*']) };
    client.list.mockResolvedValue([]);
    return client as unknown as ImapFlow & ReturnType<typeof makeClient>;
  }

  function gmailClient() {
    const client = makeClient([1]);
    client.capabilities = new Set(['X-GM-EXT-1']);
    client.list.mockResolvedValue([]);
    return client as unknown as ImapFlow & ReturnType<typeof makeClient>;
  }

  it('the keyword strategy refuses system flags and non-atom names before sending', async () => {
    const client = keywordClient();
    const strategy = await detectLabelStrategy(client);
    expect(strategy.type).toBe('keyword');
    await expect(strategy.addLabel(client, '1', 'INBOX', '\\Deleted')).rejects.toThrow(/backslash/);
    await expect(strategy.removeLabel(client, '1', 'INBOX', '\\Seen')).rejects.toThrow(/backslash/);
    await expect(strategy.addLabel(client, '1', 'INBOX', 'two words')).rejects.toThrow(
      /IMAP keywords/,
    );
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    expect(client.messageFlagsRemove).not.toHaveBeenCalled();
  });

  it('the Gmail strategy refuses system labels but keeps labels with spaces', async () => {
    const client = gmailClient();
    const strategy = await detectLabelStrategy(client);
    expect(strategy.type).toBe('gmail');
    await expect(strategy.addLabel(client, '1', 'INBOX', '\\Trash')).rejects.toThrow(/backslash/);
    await expect(strategy.removeLabel(client, '1', 'INBOX', '\\Inbox')).rejects.toThrow(
      /backslash/,
    );
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();

    await strategy.addLabel(client, '1', 'INBOX', 'Client Work');
    expect(client.messageFlagsAdd).toHaveBeenCalledWith('1', ['Client Work'], {
      uid: true,
      useLabels: true,
    });
  });

  it('a label on a missing message is an error, not a silent success', async () => {
    const client = keywordClient();
    const strategy = await detectLabelStrategy(client);
    await expect(strategy.addLabel(client, '99', 'INBOX', 'Work')).rejects.toThrow(/not found/);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
  });

  it('triage and static rules go through the same check (ImapService.addLabel)', async () => {
    const client = keywordClient();
    const { service } = makeService(client as unknown as ReturnType<typeof makeClient>);
    await expect(service.addLabel('a', '1', 'INBOX', '\\Deleted')).rejects.toThrow(/backslash/);
    expect(client.messageFlagsAdd).not.toHaveBeenCalled();
    service.dispose();
  });

  it('a local rule with a system-flag label is refused when it is added', () => {
    const problems = validateLocalRule(
      { name: 'r', match: { from: 'x@example.com' }, actions: { labels: ['\\Seen'] } },
      [],
      [],
    );
    expect(problems.join(' ')).toMatch(/backslash/);
  });
});
