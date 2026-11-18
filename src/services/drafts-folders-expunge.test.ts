/**
 * Drafts, folders and expunge: the paths that can lose mail for good.
 *
 * - send_draft sends only a real draft (Drafts folder, \Draft flag) and moves
 *   it to Trash afterwards, instead of re-sending any message and erasing it.
 * - delete_mailbox refuses a folder that still holds mail, has subfolders, or
 *   is the parent of a protected folder; padded names hit the protected check.
 * - A server without UIDPLUS (delete) or without MOVE and UIDPLUS (move) ends
 *   with a plain EXPUNGE; the owner decided that is allowed but always said.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { IConnectionManager } from '../connections/types.js';
import ImapService from './imap.service.js';
import { detectLabelStrategy } from './label-strategy.js';
import SmtpService from './smtp.service.js';

const xdgDirs = vi.hoisted(() => ({ root: '' }));
vi.mock('../config/xdg.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../config/xdg.js')>();
  const nodePath = await import('node:path');
  const nodeOs = await import('node:os');
  xdgDirs.root = nodePath.join(nodeOs.tmpdir(), `imap-wizard-drafts-test-${process.pid}`);
  return {
    ...real,
    SCHEDULED_DIR: nodePath.join(xdgDirs.root, 'scheduled'),
    SCHEDULED_SENT_DIR: nodePath.join(xdgDirs.root, 'scheduled', 'sent'),
  };
});
vi.mock('../logging.js', () => ({ mcpLog: vi.fn(async () => undefined) }));

type Listed = {
  path: string;
  name?: string;
  delimiter?: string;
  specialUse?: string;
  flags?: Set<string>;
  listed?: boolean;
};

interface FakeOptions {
  capabilities?: string[];
  mailboxes?: Listed[];
  /** UIDs present per folder. */
  present?: Record<string, number[]>;
  /** UIDs already marked \Deleted per folder. */
  deleted?: Record<string, number[]>;
  /** Flags per UID (any folder). */
  flags?: Record<number, string[]>;
  messages?: Record<string, number>;
  uidValidity?: bigint;
  appendResult?: Record<string, unknown>;
}

const DEFAULT_MAILBOXES: Listed[] = [
  { path: 'INBOX', delimiter: '/' },
  { path: 'Drafts', delimiter: '/', specialUse: '\\Drafts' },
  { path: 'Trash', delimiter: '/', specialUse: '\\Trash' },
  { path: 'Sent', delimiter: '/', specialUse: '\\Sent' },
  { path: 'Clients', delimiter: '/' },
  { path: 'Empty', delimiter: '/' },
  { path: 'Projects', delimiter: '/' },
  { path: 'Projects/2025', delimiter: '/' },
  { path: 'Mail', delimiter: '/', flags: new Set(['\\Noselect']) },
  { path: 'Mail/Sent', delimiter: '/', specialUse: '\\Sent' },
  { path: 'All Mail', delimiter: '/', specialUse: '\\All' },
  { path: 'Important', delimiter: '/', specialUse: '\\Important' },
];

function fakeClient(options: FakeOptions = {}) {
  let selected = '';
  const present = options.present ?? {};
  const client = {
    usable: true,
    capabilities: new Set(options.capabilities ?? ['UIDPLUS', 'MOVE']),
    namespace: { prefix: '', delimiter: '/' },
    get mailbox() {
      return { path: selected, uidValidity: options.uidValidity ?? 7n };
    },
    list: vi.fn(async () =>
      (options.mailboxes ?? DEFAULT_MAILBOXES).map((m) => ({
        name: m.path.split('/').pop(),
        listed: true,
        flags: new Set<string>(),
        ...m,
      })),
    ),
    getMailboxLock: vi.fn(async (p: string) => {
      selected = p;
      return { release: vi.fn() };
    }),
    status: vi.fn(async (p: string) => ({ messages: options.messages?.[p] ?? 0 })),
    search: vi.fn(async (query: { uid?: string; deleted?: boolean }) => {
      if (query.deleted) return options.deleted?.[selected] ?? [];
      if (query.uid) {
        return query.uid
          .split(',')
          .map(Number)
          .filter((uid) => (present[selected] ?? []).includes(uid));
      }
      return [];
    }),
    fetchOne: vi.fn(async (uid: string) => {
      const n = Number(uid);
      if (!(present[selected] ?? []).includes(n)) return false;
      return { uid: n, flags: new Set(options.flags?.[n] ?? []) };
    }),
    append: vi.fn(async () => options.appendResult ?? { uid: 31, uidValidity: 7n }),
    messageMove: vi.fn().mockResolvedValue(true),
    messageDelete: vi.fn().mockResolvedValue(true),
    messageFlagsAdd: vi.fn().mockResolvedValue(true),
    mailboxDelete: vi.fn().mockResolvedValue(true),
    mailboxRename: vi.fn().mockResolvedValue(true),
    mailboxCreate: vi.fn().mockResolvedValue(true),
  };
  return client;
}

function serviceFor(client: ReturnType<typeof fakeClient>) {
  const connections = {
    getAccount: () => ({
      name: 'a',
      email: 'me@example.test',
      smtp: { host: 'smtp.example.test' },
    }),
    getAccountNames: () => ['a'],
    getImapClient: vi.fn(async () => client),
    getSmtpTransport: vi.fn(),
    closeAll: vi.fn(),
    invalidateSmtpTransport: vi.fn(),
  } as unknown as IConnectionManager;
  return new ImapService(connections);
}

describe('send_draft sends only a real draft', () => {
  it('refuses a folder other than Drafts, by name or by padding', async () => {
    const client = fakeClient({ present: { INBOX: [12] }, flags: { 12: ['\\Draft'] } });
    const service = serviceFor(client);
    for (const mailbox of ['INBOX', 'Sent', 'Nope']) {
      await expect(service.fetchDraft('a', 12, mailbox)).rejects.toThrow(
        /only sends from the Drafts folder/,
      );
    }
    expect(client.fetchOne).not.toHaveBeenCalled();
    service.dispose();
  });

  it('refuses a message in Drafts that is not marked \\Draft', async () => {
    const client = fakeClient({ present: { Drafts: [12] }, flags: { 12: ['\\Seen'] } });
    const service = serviceFor(client);
    await expect(service.fetchDraft('a', 12)).rejects.toThrow(/not marked as a draft/);
    await expect(service.fetchDraft('a', 12, ' Drafts ')).rejects.toThrow(/not marked as a draft/);
    service.dispose();
  });

  it('sendDraft of a refused message sends nothing and removes nothing', async () => {
    const client = fakeClient({ present: { INBOX: [12] } });
    const imap = serviceFor(client);
    const trashDraft = vi.spyOn(imap, 'trashDraft');
    const sendMail = vi.fn();
    const smtp = new SmtpService(
      {
        getAccount: () => ({ email: 'me@example.test', smtp: { host: 'smtp.example.test' } }),
        getSmtpTransport: async () => ({ sendMail }),
        invalidateSmtpTransport: vi.fn(),
      } as never,
      { tryConsume: () => true } as never,
      imap,
    );
    await expect(smtp.sendDraft('a', 12, 'INBOX')).rejects.toThrow(/Drafts folder/);
    expect(sendMail).not.toHaveBeenCalled();
    expect(trashDraft).not.toHaveBeenCalled();
    expect(client.messageDelete).not.toHaveBeenCalled();
    expect(client.messageMove).not.toHaveBeenCalled();
    imap.dispose();
  });
});

describe('a sent or cancelled draft goes to Trash', () => {
  it('moves the draft to Trash and never expunges it', async () => {
    const client = fakeClient({ present: { Drafts: [5] }, flags: { 5: ['\\Draft'] } });
    const service = serviceFor(client);
    const warnings = await service.trashDraft('a', 5, 'Drafts');
    expect(client.messageMove).toHaveBeenCalledWith('5', 'Trash', { uid: true });
    expect(client.messageDelete).not.toHaveBeenCalled();
    expect(warnings).toEqual([]);
    service.dispose();
  });

  it('leaves the message alone when it is not a draft', async () => {
    const client = fakeClient({ present: { Drafts: [5] }, flags: { 5: [] } });
    const service = serviceFor(client);
    await expect(service.trashDraft('a', 5, 'Drafts')).rejects.toThrow(/not a draft/);
    expect(client.messageMove).not.toHaveBeenCalled();
    service.dispose();
  });

  it('moves nothing when the folder was renumbered (UIDVALIDITY changed)', async () => {
    const client = fakeClient({
      present: { Drafts: [5] },
      flags: { 5: ['\\Draft'] },
      uidValidity: 99n,
    });
    const service = serviceFor(client);
    await expect(service.trashDraft('a', 5, 'Drafts', '7')).rejects.toThrow(/renumbered/);
    expect(client.messageMove).not.toHaveBeenCalled();
    expect(client.messageDelete).not.toHaveBeenCalled();
    service.dispose();
  });

  it('warns when the server has neither MOVE nor UIDPLUS', async () => {
    const client = fakeClient({
      capabilities: [],
      present: { Drafts: [5] },
      deleted: { Drafts: [5, 8] },
      flags: { 5: ['\\Draft'] },
    });
    const service = serviceFor(client);
    const warnings = await service.trashDraft('a', 5, 'Drafts');
    expect(warnings.join(' ')).toMatch(/neither MOVE nor UIDPLUS/);
    expect(warnings.join(' ')).toMatch(/1 other message/);
    service.dispose();
  });
});

describe('a draft id the server did not report', () => {
  it('saveDraft gives no id rather than 0', async () => {
    const client = fakeClient({ appendResult: { destination: 'Drafts' } });
    const service = serviceFor(client);
    const result = await service.saveDraft('a', { to: [], subject: 's', body: 'b' });
    expect(result).toEqual({ mailbox: 'Drafts' });
    service.dispose();
  });

  it('saveDraft passes on the id and the folder numbering when the server reports them', async () => {
    const client = fakeClient({ appendResult: { uid: 31, uidValidity: 7n } });
    const service = serviceFor(client);
    const result = await service.saveDraft('a', { to: [], subject: 's', body: 'b' });
    expect(result).toEqual({ id: 31, mailbox: 'Drafts', uidValidity: '7' });
    service.dispose();
  });

  it('the scheduler stores no draft id when there is none, and the folder numbering when there is', async () => {
    const { default: SchedulerService } = await import('./scheduler.service.js');
    const sendAt = new Date(Date.now() + 3_600_000).toISOString();
    try {
      const noId = new SchedulerService(
        {} as never,
        { saveDraft: async () => ({ mailbox: 'Drafts' }) } as never,
      );
      const a = await noId.schedule('a', {
        to: ['x@example.test'],
        subject: 's',
        body: 'b',
        sendAt,
      });
      expect(a.draftMessageId).toBeUndefined();
      expect(a.draftMailbox).toBeUndefined();

      const withId = new SchedulerService(
        {} as never,
        { saveDraft: async () => ({ id: 57, mailbox: 'Drafts', uidValidity: '7' }) } as never,
      );
      const b = await withId.schedule('a', {
        to: ['x@example.test'],
        subject: 's',
        body: 'b',
        sendAt,
      });
      expect(b).toMatchObject({ draftMessageId: '57', draftUidValidity: '7' });
    } finally {
      await fs.rm(xdgDirs.root, { recursive: true, force: true });
    }
    expect(xdgDirs.root.startsWith(os.tmpdir())).toBe(true);
    expect(path.basename(xdgDirs.root)).toMatch(/^imap-wizard-drafts-test-/);
  });
});

describe('delete_mailbox and rename_mailbox', () => {
  it('refuses a folder that still holds mail and reports the count', async () => {
    const client = fakeClient({ messages: { Clients: 5 } });
    const service = serviceFor(client);
    await expect(service.deleteMailbox('a', 'Clients')).rejects.toThrow(/still holds 5 message/);
    expect(client.mailboxDelete).not.toHaveBeenCalled();
    service.dispose();
  });

  it('deletes an empty folder', async () => {
    const client = fakeClient();
    const service = serviceFor(client);
    await service.deleteMailbox('a', ' Empty ');
    expect(client.mailboxDelete).toHaveBeenCalledWith('Empty');
    service.dispose();
  });

  it('refuses a folder with subfolders', async () => {
    const client = fakeClient();
    const service = serviceFor(client);
    await expect(service.deleteMailbox('a', 'Projects')).rejects.toThrow(/subfolder/);
    expect(client.mailboxDelete).not.toHaveBeenCalled();
    service.dispose();
  });

  it('refuses to delete or rename the parent of a protected folder', async () => {
    const client = fakeClient();
    const service = serviceFor(client);
    await expect(service.deleteMailbox('a', 'Mail')).rejects.toThrow(
      /protected folder "Mail\/Sent"/,
    );
    await expect(service.renameMailbox('a', 'Mail', 'Old')).rejects.toThrow(
      /protected folder "Mail\/Sent"/,
    );
    expect(client.mailboxDelete).not.toHaveBeenCalled();
    expect(client.mailboxRename).not.toHaveBeenCalled();
    service.dispose();
  });

  it.each([' Sent', 'Sent/', '/Sent', './Sent', 'Sent//', ' INBOX', 'INBOX/', 'Trash/'])(
    'a padded name "%s" still hits the protected check',
    async (name) => {
      const client = fakeClient();
      const service = serviceFor(client);
      await expect(service.deleteMailbox('a', name)).rejects.toThrow(/cannot be deleted/);
      await expect(service.renameMailbox('a', name, 'Other')).rejects.toThrow(/cannot be renamed/);
      expect(client.mailboxDelete).not.toHaveBeenCalled();
      expect(client.mailboxRename).not.toHaveBeenCalled();
      service.dispose();
    },
  );

  it('the dry run refuses what the real call refuses', async () => {
    const client = fakeClient({ messages: { Clients: 3 } });
    const service = serviceFor(client);
    await expect(service.previewDeleteMailbox('a', 'Clients')).rejects.toThrow(/3 message/);
    await expect(service.previewDeleteMailbox('a', 'Mail')).rejects.toThrow(/protected folder/);
    service.dispose();
  });
});

describe('virtual folders are refused on every delete path', () => {
  it('permanent delete from All Mail is refused like a move to Trash', async () => {
    const client = fakeClient({ present: { 'All Mail': [9] } });
    const service = serviceFor(client);
    await expect(service.deleteEmail('a', '9', 'All Mail', true)).rejects.toThrow(/virtual folder/);
    await expect(service.bulkDelete('a', [9], 'All Mail', true)).rejects.toThrow(/virtual folder/);
    await expect(service.previewDelete('a', '9', 'All Mail', true)).rejects.toThrow(
      /virtual folder/,
    );
    expect(client.messageDelete).not.toHaveBeenCalled();
    service.dispose();
  });

  it('a different spelling or Gmail Important does not slip past the check', async () => {
    const client = fakeClient({ present: { 'all mail': [9], Important: [9] } });
    const service = serviceFor(client);
    await expect(service.moveEmail('a', '9', 'all mail', 'Clients')).rejects.toThrow(
      /virtual folder/,
    );
    await expect(service.moveEmail('a', '9', 'Important', 'Clients')).rejects.toThrow(
      /virtual folder \(\\Important\)/,
    );
    expect(client.messageMove).not.toHaveBeenCalled();
    service.dispose();
  });

  it('a namespace prefix does not slip past the check', async () => {
    const client = fakeClient({
      mailboxes: [
        { path: 'INBOX', delimiter: '.' },
        { path: 'INBOX.All', delimiter: '.', specialUse: '\\All' },
      ],
      present: { All: [9] },
    });
    client.namespace = { prefix: 'INBOX.', delimiter: '.' };
    const service = serviceFor(client);
    await expect(service.moveEmail('a', '9', 'All', 'INBOX')).rejects.toThrow(/virtual folder/);
    service.dispose();
  });
});

describe('plain EXPUNGE is always said (owner decision 1b)', () => {
  it('permanent delete without UIDPLUS warns and counts the other marked messages', async () => {
    const client = fakeClient({
      capabilities: ['MOVE'],
      present: { Clients: [42] },
      deleted: { Clients: [3, 4] },
    });
    const service = serviceFor(client);
    const warnings = await service.deleteEmail('a', '42', 'Clients', true);
    expect(client.messageDelete).toHaveBeenCalled();
    expect(warnings.join(' ')).toMatch(/lacks UIDPLUS/);
    expect(warnings.join(' ')).toMatch(/2 other message/);
    service.dispose();
  });

  it('permanent delete with UIDPLUS has no warning', async () => {
    const client = fakeClient({ present: { Clients: [42] }, deleted: { Clients: [3] } });
    const service = serviceFor(client);
    expect(await service.deleteEmail('a', '42', 'Clients', true)).toEqual([]);
    service.dispose();
  });

  it('a move or delete to Trash without MOVE and UIDPLUS warns; with MOVE it does not', async () => {
    const bare = fakeClient({ capabilities: [], present: { Clients: [42] } });
    const s1 = serviceFor(bare);
    expect((await s1.moveEmail('a', '42', 'Clients', 'Empty')).join(' ')).toMatch(
      /neither MOVE nor UIDPLUS/,
    );
    expect((await s1.deleteEmail('a', '42', 'Clients')).join(' ')).toMatch(
      /neither MOVE nor UIDPLUS/,
    );
    const bulk = await s1.bulkMove('a', [42], 'Clients', 'Empty');
    expect(bulk.warnings?.join(' ')).toMatch(/neither MOVE nor UIDPLUS/);
    s1.dispose();

    const modern = fakeClient({ capabilities: ['MOVE'], present: { Clients: [42] } });
    const s2 = serviceFor(modern);
    expect(await s2.moveEmail('a', '42', 'Clients', 'Empty')).toEqual([]);
    s2.dispose();
  });

  it('the dry run says it too', async () => {
    const client = fakeClient({
      capabilities: [],
      present: { Clients: [42] },
      deleted: { Clients: [7] },
    });
    const service = serviceFor(client);
    const plan = await service.previewDelete('a', '42', 'Clients', true);
    expect(plan.notes.join(' ')).toMatch(/would end with a plain EXPUNGE/);
    expect(plan.notes.join(' ')).toMatch(/would also remove 1 other message/);
    service.dispose();
  });
});

describe('Gmail label paths', () => {
  function gmail() {
    const client = fakeClient({
      capabilities: ['X-GM-EXT-1', 'UIDPLUS', 'MOVE'],
      mailboxes: [
        { path: 'INBOX', delimiter: '/' },
        { path: '[Gmail]', delimiter: '/', flags: new Set(['\\Noselect']) },
        { path: '[Gmail]/Trash', delimiter: '/', specialUse: '\\Trash' },
        { path: 'Work', delimiter: '/' },
        { path: 'Work/Urgent', delimiter: '/' },
        { path: 'Urgent', delimiter: '/' },
      ],
      present: { Work: [3] },
    });
    return client;
  }

  it('lists nested labels by their full path', async () => {
    const client = gmail();
    const strategy = await detectLabelStrategy(client as never);
    const names = (await strategy.listLabels(client as never)).map((l) => l.name);
    expect(names).toEqual(['Work', 'Work/Urgent', 'Urgent']);
  });

  it('delete_label refuses INBOX and system labels', async () => {
    const client = gmail();
    const strategy = await detectLabelStrategy(client as never);
    await expect(strategy.deleteLabel(client as never, 'INBOX')).rejects.toThrow(
      /cannot be deleted/,
    );
    await expect(strategy.deleteLabel(client as never, '[Gmail]/Trash')).rejects.toThrow(
      /cannot be deleted/,
    );
    expect(client.mailboxDelete).not.toHaveBeenCalled();
    await strategy.deleteLabel(client as never, 'Work/Urgent');
    expect(client.mailboxDelete).toHaveBeenCalledWith('Work/Urgent');
  });

  it('a permanent delete from a label folder says it may only remove the label', async () => {
    const client = gmail();
    const service = serviceFor(client);
    const warnings = await service.deleteEmail('a', '3', 'Work', true);
    expect(warnings.join(' ')).toMatch(/only removes this label/);
    service.dispose();
  });
});
