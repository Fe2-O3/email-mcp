import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import CacheStore, { forgetCachedAccount } from './store.js';

function makeMessage(overrides: Record<string, unknown> = {}) {
  return {
    account: 'work',
    mailbox: 'INBOX',
    uid: 1,
    uidValidity: '100',
    envelope: { subject: 'Hello' },
    flags: ['\\Seen'],
    messageId: '<a@example.com>',
    internalDate: Date.parse('2026-08-01T10:00:00Z'),
    subject: 'Hello',
    fromText: 'Ada <ada@example.com>',
    hasAttachments: false,
    ...overrides,
  };
}

describe('CacheStore', () => {
  let store: CacheStore;

  beforeEach(() => {
    store = new CacheStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  describe('messages', () => {
    it('round-trips a message', () => {
      store.putMessages([makeMessage()]);

      const found = store.getMessage('work', 'INBOX', 1, '100');

      expect(found).toMatchObject({
        uid: 1,
        subject: 'Hello',
        flags: ['\\Seen'],
        messageId: '<a@example.com>',
      });
    });

    it('returns undefined for a message from a different UIDVALIDITY', () => {
      store.putMessages([makeMessage({ uidValidity: '100' })]);

      // Same UID, new epoch — this is a different message entirely.
      expect(store.getMessage('work', 'INBOX', 1, '999')).toBeUndefined();
    });

    it('upserts rather than duplicating on re-sync', () => {
      store.putMessages([makeMessage({ flags: ['\\Seen'] })]);
      store.putMessages([makeMessage({ flags: ['\\Seen', '\\Flagged'] })]);

      expect(store.getMessage('work', 'INBOX', 1, '100')?.flags).toEqual(['\\Seen', '\\Flagged']);
      expect(store.countMessages('work', 'INBOX')).toBe(1);
    });

    it('preserves an already-fetched body when re-syncing metadata', () => {
      store.putMessages([makeMessage()]);
      store.putBody('work', 'INBOX', 1, '100', 'the full body text');

      // A metadata resync (e.g. a flag change) must not wipe the body and
      // force another download.
      store.putMessages([makeMessage({ flags: ['\\Seen', '\\Flagged'] })]);

      expect(store.getMessage('work', 'INBOX', 1, '100')?.bodyText).toBe('the full body text');
    });
  });

  describe('pagination', () => {
    beforeEach(() => {
      const base = Date.parse('2026-08-01T10:00:00Z');
      store.putMessages(
        Array.from({ length: 25 }, (_, i) =>
          makeMessage({
            uid: i + 1,
            subject: `Message ${i + 1}`,
            messageId: `<${i + 1}@example.com>`,
            // Ascending dates, so the newest is uid 25.
            internalDate: base + i * 60_000,
          }),
        ),
      );
    });

    it('returns newest first', () => {
      const page = store.listMessages('work', 'INBOX', '100', { page: 1, pageSize: 5 });

      expect(page.items.map((m) => m.uid)).toEqual([25, 24, 23, 22, 21]);
      expect(page.total).toBe(25);
      expect(page.hasMore).toBe(true);
    });

    it('pages deeper without rescanning', () => {
      const page = store.listMessages('work', 'INBOX', '100', { page: 5, pageSize: 5 });

      expect(page.items.map((m) => m.uid)).toEqual([5, 4, 3, 2, 1]);
      expect(page.hasMore).toBe(false);
    });
  });

  describe('full-text search', () => {
    it('finds a message by body text', () => {
      store.putMessages([makeMessage({ uid: 1, subject: 'Rechnung' })]);
      store.putBody('work', 'INBOX', 1, '100', 'Anbei die Rechnung für August.');

      const hits = store.searchMessages('work', 'INBOX', '100', 'Rechnung');

      expect(hits.map((m) => m.uid)).toEqual([1]);
    });

    it('does not return a message after it is purged', () => {
      store.putMessages([makeMessage({ uid: 1 })]);
      store.putBody('work', 'INBOX', 1, '100', 'findable text');
      store.deleteMessages('work', 'INBOX', [1], '100');

      // A stale FTS index would still match here — the triggers must keep the
      // index and the table in step.
      expect(store.searchMessages('work', 'INBOX', '100', 'findable')).toEqual([]);
    });
  });

  describe('mailbox state', () => {
    it('round-trips watermarks including 64-bit values', () => {
      // Beyond Number.MAX_SAFE_INTEGER: must survive as an exact string.
      const bigModseq = '9223372036854775807';
      store.putMailboxState({
        account: 'work',
        mailbox: 'INBOX',
        uidValidity: '100',
        uidNext: 42,
        highestModseq: bigModseq,
        syncTier: 'qresync',
      });

      const state = store.getMailboxState('work', 'INBOX');

      expect(state?.highestModseq).toBe(bigModseq);
      expect(state?.uidNext).toBe(42);
      expect(state?.syncTier).toBe('qresync');
    });

    it('purges every message of the old epoch when UIDVALIDITY changes', () => {
      store.putMailboxState({
        account: 'work',
        mailbox: 'INBOX',
        uidValidity: '100',
        syncTier: 'baseline',
      });
      store.putMessages([makeMessage({ uid: 1 }), makeMessage({ uid: 2 })]);

      const purged = store.resetEpoch('work', 'INBOX', '200');

      expect(purged).toBe(2);
      expect(store.countMessages('work', 'INBOX')).toBe(0);
      expect(store.getMailboxState('work', 'INBOX')?.uidValidity).toBe('200');
    });

    it('leaves other mailboxes untouched when one epoch resets', () => {
      store.putMessages([
        makeMessage({ uid: 1, mailbox: 'INBOX' }),
        makeMessage({ uid: 1, mailbox: 'Archive' }),
      ]);

      store.resetEpoch('work', 'INBOX', '200');

      expect(store.countMessages('work', 'Archive')).toBe(1);
    });
  });
});

const bundle = (text = 'hello') => ({
  envelope: { subject: 'Hello', date: '2026-08-01T10:00:00.000Z' },
  bodyStructure: { type: 'text/plain' },
  headersRaw: 'Subject: Hello\r\n',
  bodyText: text,
});

describe('message_body', () => {
  let store: CacheStore;

  beforeEach(() => {
    store = new CacheStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('round-trips a bundle and a skipped row', () => {
    store.putBodyBundle('work', 'INBOX', 1, '100', bundle(), 1);
    store.markBodySkipped('work', 'INBOX', 2, '100', 'oversize', 1);

    expect(store.getBody('work', 'INBOX', 1, '100')).toMatchObject({
      status: 'ok',
      extractorVersion: 1,
      bundle: bundle(),
    });
    expect(store.getBody('work', 'INBOX', 2, '100')).toMatchObject({
      status: 'skipped',
      skipReason: 'oversize',
      bundle: undefined,
    });
    expect(store.getBody('work', 'INBOX', 1, '999')).toBeUndefined();
  });

  it('deleting a message row deletes its body', () => {
    store.putMessages([makeMessage()]);
    store.putBodyBundle('work', 'INBOX', 1, '100', bundle(), 1);

    store.deleteMessages('work', 'INBOX', [1], '100');

    expect(store.getBody('work', 'INBOX', 1, '100')).toBeUndefined();
  });

  it('resetEpoch deletes bodies of other generations, including orphans', () => {
    store.putMessages([makeMessage({ uid: 1, uidValidity: '100' })]);
    store.putBodyBundle('work', 'INBOX', 1, '100', bundle(), 1);
    // No message row for this one: only resetEpoch can reach it.
    store.putBodyBundle('work', 'INBOX', 77, '100', bundle(), 1);
    store.putBodyBundle('work', 'INBOX', 5, '200', bundle(), 1);

    store.resetEpoch('work', 'INBOX', '200');

    expect(store.getBody('work', 'INBOX', 1, '100')).toBeUndefined();
    expect(store.getBody('work', 'INBOX', 77, '100')).toBeUndefined();
    expect(store.getBody('work', 'INBOX', 5, '200')).toBeDefined();
  });

  it('clear removes bodies', () => {
    store.putBodyBundle('work', 'INBOX', 1, '100', bundle(), 1);
    store.clear();
    expect(store.getBody('work', 'INBOX', 1, '100')).toBeUndefined();
  });

  it('forgetBodies removes every generation of the given uids', () => {
    store.putBodyBundle('work', 'INBOX', 1, '100', bundle(), 1);
    store.putBodyBundle('work', 'INBOX', 1, '200', bundle(), 1);
    store.putBodyBundle('work', 'INBOX', 2, '200', bundle(), 1);

    store.forgetBodies('work', 'INBOX', [1]);

    expect(store.getBody('work', 'INBOX', 1, '100')).toBeUndefined();
    expect(store.getBody('work', 'INBOX', 1, '200')).toBeUndefined();
    expect(store.getBody('work', 'INBOX', 2, '200')).toBeDefined();
  });

  it('counts bytes of ok bodies only', () => {
    store.putBodyBundle('work', 'INBOX', 1, '100', bundle('héllo'), 1);
    store.markBodySkipped('work', 'INBOX', 2, '100', 'oversize', 1);

    expect(store.bodyBytes()).toBe(
      Buffer.byteLength('Subject: Hello\r\n') + Buffer.byteLength('héllo'),
    );
  });

  describe('listUidsMissingBody', () => {
    it('is newest first, excludes ok and skipped, includes stale extractor versions', () => {
      store.putMessages([
        makeMessage({ uid: 1, internalDate: 1000 }),
        makeMessage({ uid: 2, internalDate: 4000 }),
        makeMessage({ uid: 3, internalDate: 3000 }),
        makeMessage({ uid: 4, internalDate: 2000 }),
        makeMessage({ uid: 5, internalDate: 5000 }),
      ]);
      store.putBodyBundle('work', 'INBOX', 2, '100', bundle(), 2); // current: excluded
      store.markBodySkipped('work', 'INBOX', 3, '100', 'error', 2); // skipped: excluded
      store.putBodyBundle('work', 'INBOX', 5, '100', bundle(), 1); // stale: included

      expect(store.listUidsMissingBody('work', 'INBOX', '100', 10, 2)).toEqual([5, 4, 1]);
      expect(store.listUidsMissingBody('work', 'INBOX', '100', 2, 2)).toEqual([5, 4]);
    });

    it('can be limited to the newest N messages', () => {
      store.putMessages([
        makeMessage({ uid: 1, internalDate: 1000 }),
        makeMessage({ uid: 2, internalDate: 2000 }),
        makeMessage({ uid: 3, internalDate: 3000 }),
      ]);

      expect(store.listUidsMissingBody('work', 'INBOX', '100', 10, 1, 2)).toEqual([3, 2]);
    });
  });

  it('evictBodiesLru deletes the least recently accessed first', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(1_000_000);
      store.putBodyBundle('work', 'INBOX', 1, '100', bundle(), 1);
      vi.setSystemTime(2_000_000);
      store.putBodyBundle('work', 'INBOX', 2, '100', bundle(), 1);
      vi.setSystemTime(3_000_000);
      store.markBodySkipped('work', 'INBOX', 3, '100', 'error', 1);

      expect(store.evictBodiesLru(2)).toBe(2);
      expect(store.getBody('work', 'INBOX', 1, '100')).toBeUndefined();
      expect(store.getBody('work', 'INBOX', 2, '100')).toBeUndefined();
      expect(store.getBody('work', 'INBOX', 3, '100')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('touchBody is throttled to once per hour', () => {
    vi.useFakeTimers();
    try {
      const t0 = 10_000_000;
      vi.setSystemTime(t0);
      store.putBodyBundle('work', 'INBOX', 1, '100', bundle(), 1);

      vi.setSystemTime(t0 + 30 * 60 * 1000);
      store.touchBody('work', 'INBOX', 1, '100');
      store.markBodySkipped('work', 'INBOX', 2, '100', 'error', 1); // newer than uid 1
      // Within the hour the touch was a no-op, so uid 1 is still the oldest.
      expect(store.evictBodiesLru(1)).toBe(1);
      expect(store.getBody('work', 'INBOX', 1, '100')).toBeUndefined();

      store.putBodyBundle('work', 'INBOX', 1, '100', bundle(), 1);
      vi.setSystemTime(t0 + 30 * 60 * 1000 + 61 * 60 * 1000);
      store.touchBody('work', 'INBOX', 1, '100');
      // After the hour it moved to the front of the LRU: uid 2 is now older.
      expect(store.evictBodiesLru(1)).toBe(1);
      expect(store.getBody('work', 'INBOX', 2, '100')).toBeUndefined();
      expect(store.getBody('work', 'INBOX', 1, '100')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  describe('findBodyAnyGeneration', () => {
    it('uses mailbox_state to choose between generations', () => {
      store.putBodyBundle('work', 'INBOX', 1, '100', bundle('old'), 1);
      store.putBodyBundle('work', 'INBOX', 1, '200', bundle('new'), 1);
      store.putMailboxState({
        account: 'work',
        mailbox: 'INBOX',
        uidValidity: '200',
        syncTier: 'baseline',
      });

      expect(store.findBodyAnyGeneration('work', 'INBOX', 1)).toMatchObject({
        uidValidity: '200',
        bundle: { bodyText: 'new' },
      });
    });

    it('accepts a single generation without mailbox_state, rejects ambiguity', () => {
      store.putBodyBundle('work', 'INBOX', 1, '100', bundle(), 1);
      expect(store.findBodyAnyGeneration('work', 'INBOX', 1)?.uidValidity).toBe('100');

      store.putBodyBundle('work', 'INBOX', 1, '200', bundle(), 1);
      expect(store.findBodyAnyGeneration('work', 'INBOX', 1)).toBeUndefined();
    });
  });
});

describe('schema migration', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cache-migrate-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The v1 schema, verbatim apart from comments. */
  const V1_SQL = `
    CREATE TABLE mailbox_state (
      account TEXT NOT NULL, mailbox TEXT NOT NULL, uid_validity TEXT NOT NULL,
      uid_next INTEGER, highest_modseq TEXT, sync_tier TEXT NOT NULL,
      total_messages INTEGER, unseen_messages INTEGER, last_synced_at INTEGER,
      PRIMARY KEY (account, mailbox)
    );
    CREATE TABLE message (
      account TEXT NOT NULL, mailbox TEXT NOT NULL, uid INTEGER NOT NULL,
      uid_validity TEXT NOT NULL, modseq TEXT, envelope_json TEXT NOT NULL,
      body_structure_json TEXT, flags_json TEXT NOT NULL, message_id TEXT,
      in_reply_to TEXT, references_json TEXT, internal_date INTEGER NOT NULL,
      subject TEXT, from_text TEXT, preview TEXT, body_text TEXT,
      body_fetched_at INTEGER, has_attachments INTEGER NOT NULL DEFAULT 0,
      cached_at INTEGER NOT NULL,
      PRIMARY KEY (account, mailbox, uid, uid_validity)
    );
    CREATE VIRTUAL TABLE message_fts USING fts5(
      subject, from_text, body_text, content='message', content_rowid='rowid',
      tokenize='porter unicode61'
    );
    CREATE TRIGGER message_fts_insert AFTER INSERT ON message BEGIN
      INSERT INTO message_fts (rowid, subject, from_text, body_text)
      VALUES (new.rowid, new.subject, new.from_text, new.body_text);
    END;
    CREATE TRIGGER message_fts_delete AFTER DELETE ON message BEGIN
      INSERT INTO message_fts (message_fts, rowid, subject, from_text, body_text)
      VALUES ('delete', old.rowid, old.subject, old.from_text, old.body_text);
    END;
    CREATE TRIGGER message_fts_update AFTER UPDATE ON message BEGIN
      INSERT INTO message_fts (message_fts, rowid, subject, from_text, body_text)
      VALUES ('delete', old.rowid, old.subject, old.from_text, old.body_text);
      INSERT INTO message_fts (rowid, subject, from_text, body_text)
      VALUES (new.rowid, new.subject, new.from_text, new.body_text);
    END;
    PRAGMA user_version = 1;
  `;

  function makeV1File(): string {
    const file = path.join(dir, 'cache.db');
    const db = new DatabaseSync(file);
    db.exec(V1_SQL);
    db.prepare(
      `INSERT INTO message (account, mailbox, uid, uid_validity, envelope_json, flags_json,
         internal_date, subject, from_text, cached_at)
       VALUES ('work', 'INBOX', 1, '100', '{}', '[]', 1000, 'Quarterly report', 'ada', 1)`,
    ).run();
    db.close();
    return file;
  }

  function inspect(file: string, sql: string): unknown[] {
    const db = new DatabaseSync(file);
    try {
      return db.prepare(sql).all() as unknown[];
    } finally {
      db.close();
    }
  }

  it('upgrades a v1 file, keeping its messages', () => {
    const file = makeV1File();

    new CacheStore(file).close();

    expect(inspect(file, 'PRAGMA user_version')).toEqual([{ user_version: 2 }]);
    expect(
      inspect(file, "SELECT name FROM sqlite_master WHERE name = 'message_body'"),
    ).toHaveLength(1);
    expect(inspect(file, 'SELECT subject FROM message')).toEqual([{ subject: 'Quarterly report' }]);
  });

  it('is idempotent on re-open', () => {
    const file = makeV1File();
    new CacheStore(file).close();

    const store = new CacheStore(file);
    expect(store.getMessage('work', 'INBOX', 1, '100')?.subject).toBe('Quarterly report');
    store.close();
    expect(inspect(file, 'PRAGMA user_version')).toEqual([{ user_version: 2 }]);
  });

  // An older build that wiped a newer build's tables made the two fight over the file.
  it('leaves a file from a newer build untouched and refuses to open it', () => {
    const file = path.join(dir, 'cache.db');
    const first = new CacheStore(file);
    first.putBodyBundle('work', 'INBOX', 1, '100', bundle(), 1);
    first.close();
    const db = new DatabaseSync(file);
    db.exec('PRAGMA user_version = 99');
    db.close();

    expect(() => new CacheStore(file)).toThrow(/newer version of IMAP Wizard/);
    expect(inspect(file, 'PRAGMA user_version')).toEqual([{ user_version: 99 }]);
    expect(inspect(file, 'SELECT uid FROM message_body')).toEqual([{ uid: 1 }]);
  });

  // A broken file used to keep the mirror off on every start, forever.
  it('sets a file that is not a database aside and starts a fresh one', () => {
    const file = path.join(dir, 'cache.db');
    fs.writeFileSync(file, 'x'.repeat(4096));

    const store = new CacheStore(file);
    store.putBodyBundle('work', 'INBOX', 1, '100', bundle(), 1);
    expect(store.getBody('work', 'INBOX', 1, '100')).toBeDefined();
    store.close();

    const aside = fs.readdirSync(dir).filter((name) => name.startsWith('cache.db.corrupt-'));
    expect(aside).toHaveLength(1);
    expect(fs.readFileSync(path.join(dir, aside[0]), 'utf8')).toBe('x'.repeat(4096));
  });

  it('rebuilds instead of failing when a migration step throws', () => {
    const file = makeV1File();

    const store = new CacheStore(file, [{ to: 2, sql: 'THIS IS NOT SQL' }]);

    expect(store.getMessage('work', 'INBOX', 1, '100')).toBeUndefined();
    store.putBodyBundle('work', 'INBOX', 1, '100', bundle(), 1);
    expect(store.getBody('work', 'INBOX', 1, '100')).toBeDefined();
    store.close();
    expect(inspect(file, 'PRAGMA user_version')).toEqual([{ user_version: 2 }]);
  });

  it('a flags-only update does not reindex message_fts, but a subject change does', () => {
    const file = makeV1File();
    const store = new CacheStore(file);
    store.close();

    const db = new DatabaseSync(file);
    try {
      const countFor = (term: string) =>
        (
          db
            .prepare('SELECT COUNT(*) AS n FROM message_fts WHERE message_fts MATCH ?')
            .get(term) as {
            n: number;
          }
        ).n;
      expect(countFor('quarterly')).toBe(1);

      // The migrated trigger must be the column-scoped one, not the v1 one.
      const trigger = db
        .prepare("SELECT sql FROM sqlite_master WHERE name = 'message_fts_update'")
        .get() as { sql: string };
      expect(trigger.sql).toContain('UPDATE OF subject, from_text, body_text');

      db.exec('UPDATE message SET flags_json = \'["\\\\Seen"]\'');
      db.exec("INSERT INTO message_fts(message_fts) VALUES ('integrity-check')");
      expect(countFor('quarterly')).toBe(1);

      db.exec("UPDATE message SET subject = 'Annual summary'");
      db.exec("INSERT INTO message_fts(message_fts) VALUES ('integrity-check')");
      expect(countFor('quarterly')).toBe(0);
      expect(countFor('annual')).toBe(1);
    } finally {
      db.close();
    }
  });
});

describe('CacheStore account identity', () => {
  let store: CacheStore;

  function seed(): void {
    store.putMessages([
      {
        account: 'work',
        mailbox: 'INBOX',
        uid: 1,
        uidValidity: '100',
        envelope: {},
        flags: [],
        internalDate: 1,
        hasAttachments: false,
      },
    ]);
    store.putBodyBundle(
      'work',
      'INBOX',
      1,
      '100',
      { envelope: {}, bodyStructure: {}, headersRaw: 'h' },
      1,
    );
  }

  beforeEach(() => {
    store = new CacheStore(':memory:');
  });

  afterEach(() => {
    store.close();
  });

  it('keeps the mirror while the account still points at the same server and login', () => {
    expect(store.bindAccountIdentity('work', 'server-a')).toBe(false);
    seed();
    expect(store.bindAccountIdentity('work', 'server-a')).toBe(false);
    expect(store.countMessages('work', 'INBOX')).toBe(1);
  });

  // Same name, same UIDVALIDITY and UID on a new server: the old body would be served.
  it('drops the mirror of an account name that now points at another server or login', () => {
    store.bindAccountIdentity('work', 'server-a');
    seed();

    expect(store.bindAccountIdentity('work', 'server-b')).toBe(true);
    expect(store.countMessages('work', 'INBOX')).toBe(0);
    expect(store.getBody('work', 'INBOX', 1, '100')).toBeUndefined();
    expect(store.bindAccountIdentity('work', 'server-b')).toBe(false);
  });

  it('forgets the identity when an account is cleared', () => {
    store.bindAccountIdentity('work', 'server-a');
    store.clear('work');
    expect(store.bindAccountIdentity('work', 'server-b')).toBe(false);
  });
});

describe('forgetCachedAccount', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'imap-wizard-forget-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("drops a deleted account's mail and keeps the others'", () => {
    const file = path.join(dir, 'cache.db');
    const store = new CacheStore(file);
    for (const account of ['work', 'home']) {
      store.putBodyBundle(
        account,
        'INBOX',
        1,
        '100',
        { envelope: {}, bodyStructure: {}, headersRaw: 'h' },
        1,
      );
    }
    store.close();

    expect(forgetCachedAccount(file, 'work')).toBe(true);

    const after = new CacheStore(file);
    expect(after.getBody('work', 'INBOX', 1, '100')).toBeUndefined();
    expect(after.getBody('home', 'INBOX', 1, '100')).toBeDefined();
    after.close();
  });

  it('does not create a cache file that is not there', () => {
    const file = path.join(dir, 'cache.db');
    expect(forgetCachedAccount(file, 'work')).toBe(false);
    expect(fs.existsSync(file)).toBe(false);
  });
});
