/**
 * Attachments: which parts count, that each one is fetched by its own part number (so two with
 * the same name keep their own bytes), that saving never overwrites, and that one failure does
 * not hide the files that were saved.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import attachmentFolderName from '../utils/attachment-folder.js';
import ImapService, { assembleEmail, fetchBodyBundle, messageToEmailMeta } from './imap.service.js';

type Node = Record<string, unknown>;

const pdf = (part: string, filename: string, extra: Node = {}): Node => ({
  part,
  type: 'application/pdf',
  disposition: 'attachment',
  dispositionParameters: { filename },
  size: 100,
  ...extra,
});
const body: Node = { part: '1', type: 'text/plain', size: 10 };
const mixed = (...children: Node[]): Node => ({ type: 'multipart/mixed', childNodes: children });

/** A client whose part `n` downloads as the bytes `bytes[n]`; a part listed in `broken` fails. */
function buildService(structure: Node, bytes: Record<string, string>, broken: string[] = []) {
  const client = {
    usable: true,
    capabilities: new Set<string>(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    fetchOne: vi.fn().mockResolvedValue({
      uid: 9,
      envelope: { subject: 'S', messageId: '<s@x>' },
      flags: [],
      bodyStructure: structure,
      headers: Buffer.from('Subject: S\r\n\r\n', 'utf-8'),
    }),
    download: vi.fn(async (_uid: string, part: string) => {
      if (broken.includes(part)) throw new Error(`part ${part} failed`);
      return {
        content: (async function* () {
          yield Buffer.from(bytes[part] ?? `bytes-of-${part}`, 'utf-8');
        })(),
      };
    }),
  };
  const service = new ImapService({ getImapClient: async () => client } as never);
  return { service, client };
}

const attachmentsOf = (structure: Node) =>
  assembleEmail(
    { envelope: {}, bodyStructure: structure, headersRaw: '', complete: true },
    [],
    1,
  ).attachments.map((a) => a.filename);

describe('which parts are attachments', () => {
  it('lists an inline PDF and a part that has only a name, as well as marked attachments', () => {
    const structure = mixed(
      body,
      {
        part: '2',
        type: 'application/pdf',
        disposition: 'inline',
        dispositionParameters: { filename: 'inline.pdf' },
        size: 5,
      },
      { part: '3', type: 'application/pdf', parameters: { name: 'old-client.pdf' }, size: 5 },
      pdf('4', 'marked.pdf'),
    );
    expect(attachmentsOf(structure)).toEqual(['inline.pdf', 'old-client.pdf', 'marked.pdf']);
    expect(
      messageToEmailMeta({ uid: 1, envelope: {}, flags: new Set(), bodyStructure: structure })
        .hasAttachments,
    ).toBe(true);
  });

  it('skips inline images that the body refers to by Content-ID, and calendar parts', () => {
    const structure = mixed(
      body,
      {
        part: '2',
        type: 'image/png',
        disposition: 'inline',
        id: '<logo@x>',
        dispositionParameters: { filename: 'logo.png' },
        size: 5,
      },
      { part: '3', type: 'text/calendar', parameters: { name: 'invite.ics' }, size: 5 },
    );
    expect(attachmentsOf(structure)).toEqual([]);
    expect(
      messageToEmailMeta({ uid: 1, envelope: {}, flags: new Set(), bodyStructure: structure })
        .hasAttachments,
    ).toBe(false);
  });

  it('keeps a named text part as the body when it is the only text', async () => {
    const structure = {
      part: '1',
      type: 'text/plain',
      disposition: 'inline',
      dispositionParameters: { filename: 'note.txt' },
      size: 5,
    };
    expect(attachmentsOf(structure)).toEqual([]);
    const { client } = buildService(structure, { '1': 'hello' });
    const bundle = await fetchBodyBundle(
      { bodyStructure: structure, envelope: {} },
      client as never,
      9,
    );
    expect(bundle.bodyText).toBe('hello');
  });

  it('a named inline text part is an attachment when a real body exists beside it', async () => {
    const structure = mixed(body, {
      part: '2',
      type: 'text/plain',
      disposition: 'inline',
      dispositionParameters: { filename: 'notes.txt' },
      size: 500,
    });
    expect(attachmentsOf(structure)).toEqual(['notes.txt']);
  });

  it('forwards an inline PDF (fetchMessageAttachments)', async () => {
    const structure = mixed(body, {
      part: '2',
      type: 'application/pdf',
      disposition: 'inline',
      dispositionParameters: { filename: 'invoice.pdf' },
      size: 90,
    });
    const { service } = buildService(structure, { '2': 'INVOICE' });
    const parts = await service.fetchMessageAttachments('a', '9', 'INBOX');
    expect(parts.map((p) => [p.filename, Buffer.from(p.content, 'base64').toString()])).toEqual([
      ['invoice.pdf', 'INVOICE'],
    ]);
  });

  it('a single-part message that is itself an attachment can be downloaded', async () => {
    const structure = pdf('', 'only.pdf');
    delete structure.part;
    const { service, client } = buildService(structure, { '1': 'WHOLE' });
    const result = await service.downloadAttachment('a', '9', 'INBOX', 'only.pdf');
    expect(Buffer.from(result.contentBase64, 'base64').toString()).toBe('WHOLE');
    expect(client.download).toHaveBeenCalledWith('9', '1', { uid: true });
  });
});

describe('two attachments with the same name', () => {
  const structure = mixed(body, pdf('2', 'contract.pdf'), pdf('3', 'contract.pdf'));
  const bytes = { '2': 'UNSIGNED', '3': 'SIGNED' };
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'att-same-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('saves each with its own bytes', async () => {
    const { service } = buildService(structure, bytes);
    const { saved, failed } = await service.saveEmailAttachments('a', '9', 'INBOX', dir);
    expect(failed).toEqual([]);
    expect(saved.map((s) => path.basename(s.localPath))).toEqual([
      'contract.pdf',
      'contract-1.pdf',
    ]);
    expect(await fs.readFile(saved[0]?.localPath ?? '', 'utf8')).toBe('UNSIGNED');
    expect(await fs.readFile(saved[1]?.localPath ?? '', 'utf8')).toBe('SIGNED');
  });

  it('refuses a download by name alone and downloads the one asked for by occurrence', async () => {
    const { service } = buildService(structure, bytes);
    await expect(service.downloadAttachment('a', '9', 'INBOX', 'contract.pdf')).rejects.toThrow(
      /2 attachments are named "contract\.pdf".*occurrence/,
    );
    const second = await service.downloadAttachment(
      'a',
      '9',
      'INBOX',
      'contract.pdf',
      undefined,
      2,
    );
    expect(Buffer.from(second.contentBase64, 'base64').toString()).toBe('SIGNED');
    await expect(
      service.downloadAttachment('a', '9', 'INBOX', 'contract.pdf', undefined, 3),
    ).rejects.toThrow(/no occurrence 3/);
  });

  it('a single attachment is still found by name alone', async () => {
    const { service } = buildService(mixed(body, pdf('2', 'one.pdf')), { '2': 'ONE' });
    const one = await service.downloadAttachment('a', '9', 'INBOX', 'one.pdf');
    expect(Buffer.from(one.contentBase64, 'base64').toString()).toBe('ONE');
  });
});

describe('saved names never collide and nothing is overwritten', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'att-names-'));
  });
  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  it('a.pdf, a.pdf, a-1.pdf and A.PDF all land in different files, even on a case-blind disk', async () => {
    const structure = mixed(
      body,
      pdf('2', 'a.pdf'),
      pdf('3', 'a.pdf'),
      pdf('4', 'a-1.pdf'),
      pdf('5', 'A.PDF'),
    );
    const { service } = buildService(structure, {
      '2': 'one',
      '3': 'two',
      '4': 'three',
      '5': 'four',
    });
    const { saved, failed } = await service.saveEmailAttachments('a', '9', 'INBOX', dir);
    expect(failed).toEqual([]);
    expect(saved).toHaveLength(4);
    expect(new Set(saved.map((s) => s.localPath.toLowerCase())).size).toBe(4);
    const contents = await Promise.all(saved.map((s) => fs.readFile(s.localPath, 'utf8')));
    expect(contents).toEqual(['one', 'two', 'three', 'four']);
  });

  it('saving the same message again keeps the files already there', async () => {
    const structure = mixed(body, pdf('2', 'a.pdf'));
    const first = await buildService(structure, { '2': 'FIRST' }).service.saveEmailAttachments(
      'a',
      '9',
      'INBOX',
      dir,
    );
    await fs.writeFile(first.saved[0]?.localPath ?? '', 'EDITED BY THE USER');
    const second = await buildService(structure, { '2': 'FIRST' }).service.saveEmailAttachments(
      'a',
      '9',
      'INBOX',
      dir,
    );
    expect(await fs.readFile(first.saved[0]?.localPath ?? '', 'utf8')).toBe('EDITED BY THE USER');
    expect(second.saved[0]?.localPath).not.toBe(first.saved[0]?.localPath);
  });

  it('refuses dot-names and run-on-open types, and saves the rest', async () => {
    const structure = mixed(
      body,
      pdf('2', '.pre-commit-config.yaml'),
      pdf('3', 'run.command'),
      pdf('4', 'Thing.APP'),
      pdf('5', 'x.scpt'),
      pdf('6', 'setup.sh'),
      pdf('7', 'com.evil.plist'),
      pdf('8', 'fine.pdf'),
    );
    const { service } = buildService(structure, {});
    const { saved, failed } = await service.saveEmailAttachments('a', '9', 'INBOX', dir);
    expect(saved.map((s) => s.filename)).toEqual(['fine.pdf']);
    expect(failed.map((f) => f.filename)).toEqual([
      '.pre-commit-config.yaml',
      'run.command',
      'Thing.APP',
      'x.scpt',
      'setup.sh',
      'com.evil.plist',
    ]);
    expect(failed[0]?.error).toMatch(/start with a dot/);
    expect(await fs.readdir(dir)).toEqual(['fine.pdf']);
  });

  it('one failing download out of three returns two saved files and one error', async () => {
    const structure = mixed(body, pdf('2', 'a.pdf'), pdf('3', 'b.pdf'), pdf('4', 'c.pdf'));
    const { service } = buildService(structure, {}, ['3']);
    const { saved, failed } = await service.saveEmailAttachments('a', '9', 'INBOX', dir);
    expect(saved.map((s) => s.filename)).toEqual(['a.pdf', 'c.pdf']);
    expect(failed).toEqual([{ filename: 'b.pdf', error: 'part 3 failed' }]);
  });

  it('reports an attachment over the size limit instead of dropping it silently', async () => {
    const structure = mixed(
      body,
      pdf('2', 'huge.pdf', { size: 30 * 1024 * 1024 }),
      pdf('3', 'ok.pdf'),
    );
    const { service } = buildService(structure, {});
    const { saved, failed } = await service.saveEmailAttachments('a', '9', 'INBOX', dir);
    expect(saved.map((s) => s.filename)).toEqual(['ok.pdf']);
    expect(failed[0]).toMatchObject({ filename: 'huge.pdf', error: expect.stringMatching(/25MB/) });
  });
});

describe('the folder a message saves into', () => {
  it('includes the mailbox, so the same UID in two folders never shares a folder', () => {
    const a = attachmentFolderName('work', 'INBOX', '5');
    const b = attachmentFolderName('work', 'Archive', '5');
    expect(a).not.toBe(b);
    expect(attachmentFolderName('work', 'a/b', '5')).not.toBe(
      attachmentFolderName('work', 'a_b', '5'),
    );
    expect(a).toMatch(/^[a-zA-Z0-9-_]+$/);
  });
});

describe('a body that did not download completely', () => {
  const structure = { part: '1', type: 'text/plain', size: 5 };

  it('is marked incomplete on the Email when the part is missing on the server', async () => {
    const { client } = buildService(structure, {}, ['1']);
    const bundle = await fetchBodyBundle(
      { bodyStructure: structure, envelope: {} },
      client as never,
      9,
    );
    expect(bundle.complete).toBe(false);
    expect(assembleEmail(bundle, [], 9).bodyIncomplete).toBe(true);
    const whole = await fetchBodyBundle(
      { bodyStructure: structure, envelope: {} },
      buildService(structure, { '1': 'hi' }).client as never,
      9,
    );
    expect(assembleEmail(whole, [], 9).bodyIncomplete).toBeUndefined();
  });

  it('fails the read when the connection dropped, instead of showing an empty body', async () => {
    const dropped = {
      download: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('closed'), { code: 'NoConnection' })),
    };
    await expect(
      fetchBodyBundle({ bodyStructure: structure, envelope: {} }, dropped as never, 9),
    ).rejects.toThrow('closed');
  });
});
