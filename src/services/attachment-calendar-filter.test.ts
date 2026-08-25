/**
 * Calendar invitations are surfaced through the calendar tools, so they are
 * filtered out of the attachment list. The predicate has to be exact.
 *
 * Matching the media type by substring hides real attachments whose type
 * merely contains the word "calendar". Matching the filename alone lets a
 * genuine `text/calendar` part through as an ordinary attachment. Both halves
 * are needed, and the attachment filter and the calendar-part locator must
 * agree — if they disagree a part can be dropped from attachments and never
 * found as calendar, disappearing from both surfaces.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import ImapService from './imap.service.js';

function buildService(part: { type: string; filename: string }): ImapService {
  const client = {
    usable: true,
    capabilities: new Set<string>(),
    getMailboxLock: vi.fn().mockResolvedValue({ release: vi.fn() }),
    fetchOne: vi.fn().mockResolvedValue({
      uid: 9,
      envelope: { subject: 'S', messageId: '<s@x>' },
      flags: [],
      bodyStructure: {
        type: 'multipart/mixed',
        childNodes: [
          { part: '1', type: 'text/plain', size: 10 },
          {
            part: '2',
            type: part.type,
            disposition: 'attachment',
            dispositionParameters: { filename: part.filename },
            size: 100,
          },
        ],
      },
      headers: Buffer.from('Subject: S\r\n\r\n', 'utf-8'),
    }),
    download: vi.fn().mockImplementation(async () => ({
      content: (async function* () {
        yield Buffer.from('DATA', 'utf-8');
      })(),
    })),
  };
  return new ImapService({ getImapClient: async () => client } as never);
}

describe('calendar parts are filtered from attachments by media type, not substring', () => {
  let destDir: string;

  beforeEach(async () => {
    destDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cal-filter-'));
  });

  afterEach(async () => {
    await fs.rm(destDir, { recursive: true, force: true });
  });

  const filtered = [
    { name: 'text/calendar with an .ics name', type: 'text/calendar', filename: 'invite.ics' },
    // The regression this test exists for: a real calendar part whose filename
    // carries no extension. A filename-only predicate lets this through.
    { name: 'text/calendar with no extension', type: 'text/calendar', filename: 'invite' },
    { name: 'text/calendar with parameters', type: 'text/calendar; method=REQUEST', filename: 'x' },
    // A generic type is common for calendar parts from older clients.
    {
      name: 'octet-stream with an .ics name',
      type: 'application/octet-stream',
      filename: 'meeting.ics',
    },
  ];

  for (const c of filtered) {
    it(`filters out ${c.name}`, async () => {
      const service = buildService({ type: c.type, filename: c.filename });
      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', destDir);
      expect(saved).toHaveLength(0);
    });
  }

  const kept = [
    // The regression the previous fix was reaching for: a substring match on
    // "calendar" hid ordinary attachments from calendar software.
    {
      name: 'a vendor type containing the word calendar',
      type: 'application/x-calendar-export',
      filename: 'report.pdf',
    },
    { name: 'a plain pdf', type: 'application/pdf', filename: 'invoice.pdf' },
    // Only the final extension counts.
    {
      name: 'a filename that merely mentions ics',
      type: 'application/pdf',
      filename: 'ics-fee.pdf',
    },
  ];

  for (const c of kept) {
    it(`keeps ${c.name}`, async () => {
      const service = buildService({ type: c.type, filename: c.filename });
      const saved = await service.saveEmailAttachments('test', '9', 'INBOX', destDir);
      expect(saved).toHaveLength(1);
    });
  }
});
