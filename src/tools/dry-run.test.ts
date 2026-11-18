/**
 * dryRun on the write tools: every check a real run makes (account, folders, message IDs,
 * protected folders, recipients, attachment paths) happens, and nothing is changed.
 *
 * The IMAP client below counts every command that writes, and the SMTP transport counts sends.
 * A dry run must leave all of those at zero.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import ImapService from '../services/imap.service.js';
import SmtpService from '../services/smtp.service.js';
import registerBulkTools from './bulk.tool.js';
import registerDraftTools from './drafts.tool.js';
import registerFolderTools from './folders.tool.js';
import registerLabelTools from './label.tool.js';
import registerManageTools from './manage.tool.js';
import registerSendTools from './send.tool.js';

type Result = { isError?: boolean; content: { text: string }[] };
type Handler = (args: Record<string, unknown>) => Promise<Result>;

const WRITE_COMMANDS = [
  'messageMove',
  'messageDelete',
  'messageFlagsAdd',
  'messageFlagsRemove',
  'messageFlagsSet',
  'mailboxCreate',
  'mailboxRename',
  'mailboxDelete',
  'append',
  'messageCopy',
] as const;

const MAILBOXES = [
  { path: 'INBOX', flags: new Set<string>() },
  { path: 'Archive', specialUse: '\\Archive', flags: new Set<string>() },
  { path: 'Trash', specialUse: '\\Trash', flags: new Set<string>() },
  { path: 'Drafts', specialUse: '\\Drafts', flags: new Set<string>() },
  { path: 'Projects', flags: new Set<string>() },
  { path: 'Receipts', flags: new Set<string>() },
  { path: '[Gmail]/All Mail', specialUse: '\\All', flags: new Set<string>() },
];

const EXISTING_UIDS = [10, 11, 12];

function buildClient() {
  const release = vi.fn();
  const writes = Object.fromEntries(
    WRITE_COMMANDS.map((c) => [c, vi.fn().mockResolvedValue(true)]),
  );
  const client = {
    usable: true,
    namespace: { prefix: '' },
    capabilities: new Set(['X-GM-EXT-1']),
    list: vi.fn().mockResolvedValue(MAILBOXES.map((m) => ({ ...m, name: m.path }))),
    getMailboxLock: vi.fn().mockResolvedValue({ release }),
    search: vi.fn(async (q: { uid: string }) =>
      q.uid
        .split(',')
        .map(Number)
        .filter((n) => EXISTING_UIDS.includes(n)),
    ),
    status: vi.fn().mockResolvedValue({ messages: 5 }),
    ...writes,
  };
  return { client, writes };
}

function buildSmtp(imap: unknown) {
  const sendMail = vi.fn().mockResolvedValue({ messageId: '<sent@example.test>' });
  const getSmtpTransport = vi.fn(async () => ({ sendMail }));
  const tryConsume = vi.fn(() => true);
  const smtp = new SmtpService(
    {
      getAccount: () => ({
        email: 'me@example.test',
        fullName: 'Me',
        smtp: { host: 'smtp.example.test' },
      }),
      getSmtpTransport,
    } as never,
    { tryConsume, remaining: () => 5 } as never,
    imap as never,
  );
  return { smtp, sendMail, getSmtpTransport, tryConsume };
}

function setup() {
  const { client, writes } = buildClient();
  const imap = new ImapService({
    getImapClient: async () => client,
    getAccount: () => ({
      email: 'me@example.test',
      smtp: { host: 'smtp.example.test' },
    }),
  } as never);
  const appendSent = vi.fn();
  const deleteDraft = vi.fn();
  const original = {
    subject: 'Hello',
    date: '2026-08-01T10:00:00Z',
    messageId: '<orig@example.test>',
    from: { name: 'Alice', address: 'alice@example.test' },
    to: [{ address: 'me@example.test' }],
    bodyText: 'hi',
  };
  const imapForSmtp = {
    getEmail: vi.fn(async () => ({ ...original })),
    fetchMessageAttachments: vi.fn(async () => []),
    fetchDraft: vi.fn(async () => ({
      email: { ...original, to: [{ address: 'bob@example.test' }], subject: 'Draft subject' },
      mailbox: 'Drafts',
    })),
    appendSent,
    deleteDraft,
  };
  const smtpParts = buildSmtp(imapForSmtp);

  const handlers = new Map<string, Handler>();
  const fakeServer = {
    registerTool: (name: string, _cfg: unknown, h: Handler) => {
      handlers.set(name, h);
    },
  } as never;
  registerManageTools(fakeServer, imap);
  registerBulkTools(fakeServer, imap);
  registerFolderTools(fakeServer, imap);
  registerLabelTools(fakeServer, imap);
  registerSendTools(fakeServer, smtpParts.smtp);
  registerDraftTools(fakeServer, imap, smtpParts.smtp);
  const call = (name: string, args: Record<string, unknown>) =>
    (handlers.get(name) as Handler)(args);

  const expectNothingWritten = () => {
    for (const [name, fn] of Object.entries(writes)) {
      expect(fn, name).not.toHaveBeenCalled();
    }
    expect(smtpParts.sendMail).not.toHaveBeenCalled();
    expect(smtpParts.getSmtpTransport).not.toHaveBeenCalled();
    expect(smtpParts.tryConsume).not.toHaveBeenCalled();
    expect(appendSent).not.toHaveBeenCalled();
    expect(deleteDraft).not.toHaveBeenCalled();
  };
  return { call, writes, expectNothingWritten, ...smtpParts, imapForSmtp };
}

const text = (r: Result) => r.content[0].text;

describe('dryRun: moving and deleting mail', () => {
  it('move_email reports the move and writes nothing', async () => {
    const t = setup();
    const r = await t.call('move_email', {
      account: 'a',
      emailId: '10',
      sourceMailbox: 'INBOX',
      destinationMailbox: 'Archive',
      dryRun: true,
    });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/^\[DRY RUN\] Would move email 10 from "INBOX" to "Archive"/);
    expect(text(r)).toMatch(/Nothing was changed/);
    t.expectNothingWritten();
  });

  it('move_email says what a real run would hit: missing folder, missing message, virtual folder', async () => {
    const t = setup();
    const move = (over: Record<string, unknown>) =>
      t.call('move_email', {
        account: 'a',
        emailId: '10',
        sourceMailbox: 'INBOX',
        destinationMailbox: 'Archive',
        dryRun: true,
        ...over,
      });
    expect(text(await move({ destinationMailbox: 'Nope' }))).toMatch(
      /Would fail: Mailbox "Nope" does not exist/,
    );
    expect(text(await move({ sourceMailbox: 'Nope' }))).toMatch(/does not exist/);
    expect(text(await move({ emailId: '999' }))).toMatch(/Would fail: Email 999 not found/);
    expect(text(await move({ emailId: 'abc' }))).toMatch(/not a numeric UID/);
    expect(text(await move({ sourceMailbox: '[Gmail]/All Mail' }))).toMatch(/virtual folder/);
    expect((await move({ emailId: '999' })).isError).toBe(true);
    t.expectNothingWritten();
  });

  it('without dryRun the same call does write', async () => {
    const t = setup();
    await t.call('move_email', {
      account: 'a',
      emailId: '10',
      sourceMailbox: 'INBOX',
      destinationMailbox: 'Archive',
      dryRun: false,
    });
    expect(t.writes.messageMove).toHaveBeenCalledTimes(1);
  });

  it('delete_email previews Trash and permanent deletion', async () => {
    const t = setup();
    const soft = await t.call('delete_email', {
      account: 'a',
      emailId: '11',
      mailbox: 'INBOX',
      dryRun: true,
    });
    expect(text(soft)).toMatch(/Would move email 11 from "INBOX" to Trash \("Trash"\)/);
    const hard = await t.call('delete_email', {
      account: 'a',
      emailId: '11',
      mailbox: 'INBOX',
      permanent: true,
      dryRun: true,
    });
    expect(text(hard)).toMatch(/Would permanently delete email 11/);
    const gone = await t.call('delete_email', {
      account: 'a',
      emailId: '99',
      mailbox: 'INBOX',
      dryRun: true,
    });
    expect(gone.isError).toBe(true);
    t.expectNothingWritten();
  });

  it('bulk_action counts which IDs exist and checks the destination', async () => {
    const t = setup();
    const r = await t.call('bulk_action', {
      account: 'a',
      mailbox: 'INBOX',
      action: 'move',
      ids: [10, 11, 77],
      destination: 'Archive',
      dryRun: true,
    });
    expect(text(r)).toMatch(/Would move to "Archive": 2 of 3 messages in "INBOX"/);
    expect(text(r)).toMatch(/1 of 3 IDs are not in "INBOX" \(77\)/);

    const noDest = await t.call('bulk_action', {
      account: 'a',
      mailbox: 'INBOX',
      action: 'move',
      ids: [10],
      dryRun: true,
    });
    expect(noDest.isError).toBe(true);
    const badDest = await t.call('bulk_action', {
      account: 'a',
      mailbox: 'INBOX',
      action: 'move',
      ids: [10],
      destination: 'Nope',
      dryRun: true,
    });
    expect(text(badDest)).toMatch(/does not exist/);

    for (const action of ['delete', 'mark_read', 'flag']) {
      const ok = await t.call('bulk_action', {
        account: 'a',
        mailbox: 'INBOX',
        action,
        ids: [10],
        dryRun: true,
      });
      expect(ok.isError, action).toBeUndefined();
    }
    t.expectNothingWritten();
  });
});

describe('dryRun: folders and labels', () => {
  it('create_mailbox refuses a name that is taken, previews a free one', async () => {
    const t = setup();
    const free = await t.call('create_mailbox', { account: 'a', path: 'Taxes', dryRun: true });
    expect(text(free)).toMatch(/Would create mailbox "Taxes"/);
    const taken = await t.call('create_mailbox', { account: 'a', path: 'Projects', dryRun: true });
    expect(text(taken)).toMatch(/already exists/);
    t.expectNothingWritten();
  });

  it('rename_mailbox and delete_mailbox apply the protected-folder rule', async () => {
    const t = setup();
    const ok = await t.call('rename_mailbox', {
      account: 'a',
      path: 'Projects',
      new_path: 'Work',
      dryRun: true,
    });
    expect(text(ok)).toMatch(/Would rename mailbox "Projects" to "Work"/);
    const taken = await t.call('rename_mailbox', {
      account: 'a',
      path: 'Projects',
      new_path: 'Receipts',
      dryRun: true,
    });
    expect(text(taken)).toMatch(/already exists/);
    for (const protectedPath of ['INBOX', 'Trash', 'Drafts']) {
      const r = await t.call('delete_mailbox', { account: 'a', path: protectedPath, dryRun: true });
      expect(r.isError, protectedPath).toBe(true);
      expect(text(r)).toMatch(/cannot be deleted/);
    }
    const missing = await t.call('delete_mailbox', { account: 'a', path: 'Nope', dryRun: true });
    expect(text(missing)).toMatch(/does not exist/);
    const del = await t.call('delete_mailbox', { account: 'a', path: 'Projects', dryRun: true });
    expect(text(del)).toMatch(/Would permanently delete mailbox "Projects"/);
    expect(text(del)).toMatch(/5 message/);
    t.expectNothingWritten();
  });

  it('delete_label checks the label exists', async () => {
    const t = setup();
    const ok = await t.call('delete_label', { account: 'a', name: 'Receipts', dryRun: true });
    expect(text(ok)).toMatch(/Would delete label "Receipts"/);
    const missing = await t.call('delete_label', { account: 'a', name: 'Ghost', dryRun: true });
    expect(text(missing)).toMatch(/does not exist/);
    t.expectNothingWritten();
  });
});

describe('dryRun: sending', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'dry-run-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('send_email shows recipients and attachments, and sends, files and counts nothing', async () => {
    const t = setup();
    const file = path.join(dir, 'plan.txt');
    await writeFile(file, 'the plan');
    const r = await t.call('send_email', {
      account: 'a',
      to: ['bob@example.test'],
      cc: ['carol@example.test'],
      subject: 'Plan',
      body: 'see attached',
      attachments: [{ path: file }],
      dryRun: true,
    });
    expect(r.isError).toBeUndefined();
    expect(text(r)).toMatch(/Would send this email/);
    expect(text(r)).toContain('To: bob@example.test');
    expect(text(r)).toContain('Cc: carol@example.test');
    expect(text(r)).toContain('Attachment: plan.txt, 8 bytes');
    t.expectNothingWritten();
  });

  it('send_email dry run refuses a protected attachment path', async () => {
    const t = setup();
    const r = await t.call('send_email', {
      account: 'a',
      to: ['bob@example.test'],
      subject: 'x',
      body: 'x',
      attachments: [{ path: '/etc/hosts' }],
      dryRun: true,
    });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/Would fail: .*protected location/);
    t.expectNothingWritten();
  });

  it('send_email dry run does not record the send, so the real one still goes through', async () => {
    const t = setup();
    const args = { account: 'a', to: ['bob@example.test'], subject: 'Once', body: 'x' };
    await t.call('send_email', { ...args, dryRun: true });
    await t.call('send_email', { ...args, dryRun: true });
    const real = await t.call('send_email', { ...args, dryRun: false });
    expect(real.isError).toBeUndefined();
    expect(t.sendMail).toHaveBeenCalledTimes(1);
  });

  it('reply_email and forward_email work out recipients without sending', async () => {
    const t = setup();
    const reply = await t.call('reply_email', {
      account: 'a',
      emailId: '10',
      mailbox: 'INBOX',
      body: 'ok',
      dryRun: true,
    });
    expect(text(reply)).toContain('To: alice@example.test');
    expect(text(reply)).toContain('Subject: Re: Hello');
    const fwd = await t.call('forward_email', {
      account: 'a',
      emailId: '10',
      mailbox: 'INBOX',
      to: ['dan@example.test'],
      dryRun: true,
    });
    expect(text(fwd)).toContain('To: dan@example.test');
    expect(text(fwd)).toContain('Subject: Fwd: Hello');
    t.expectNothingWritten();
  });

  it('send_draft reads the draft but neither sends nor deletes it', async () => {
    const t = setup();
    const r = await t.call('send_draft', { account: 'a', id: 5, dryRun: true });
    expect(text(r)).toMatch(/Would send this draft/);
    expect(text(r)).toContain('To: bob@example.test');
    expect(text(r)).toMatch(/removed from "Drafts"/);
    t.expectNothingWritten();
  });

  it('send_draft dry run flags a draft with no recipients', async () => {
    const t = setup();
    t.imapForSmtp.fetchDraft.mockResolvedValueOnce({
      email: { subject: 's', to: [], bodyText: 'x' } as never,
      mailbox: 'Drafts',
    });
    const r = await t.call('send_draft', { account: 'a', id: 5, dryRun: true });
    expect(r.isError).toBe(true);
    expect(text(r)).toMatch(/no recipients/);
    t.expectNothingWritten();
  });
});
