/**
 * SQLite-backed local mirror of server-side mail.
 *
 * Uses `node:sqlite`, built into Node 24 — no native module, no install step,
 * nothing to rebuild across Node or architecture changes. The project already
 * requires Node >= 24, so this adds zero runtime dependencies.
 *
 * This class is deliberately dumb: it stores and retrieves rows and knows
 * nothing about IMAP. Reconciliation lives in the sync engine, and hit/stale/
 * offline policy lives in the cached service wrapper.
 */

import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync as DatabaseSyncType } from 'node:sqlite';
import { MIGRATIONS, SCHEMA_SQL, SCHEMA_VERSION } from './schema.js';

// Loaded with require, not a static import: Node prints its "SQLite is
// experimental" notice the moment node:sqlite loads, and a static import loads
// it before any code runs, so main.ts could never filter the notice out
// (see quiet-warnings.ts). require runs in order, after that filter is set.
const { DatabaseSync } = createRequire(import.meta.url)(
  'node:sqlite',
) as typeof import('node:sqlite');
type DatabaseSync = DatabaseSyncType;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SyncTier = 'qresync' | 'condstore' | 'baseline';

/** A message as handed to the store for persistence. */
export interface CachedMessageInput {
  account: string;
  mailbox: string;
  uid: number;
  /** Cache epoch, as a decimal string — see schema.ts. */
  uidValidity: string;
  modseq?: string;
  envelope: unknown;
  bodyStructure?: unknown;
  flags: string[];
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  /** Epoch milliseconds. */
  internalDate: number;
  subject?: string;
  fromText?: string;
  preview?: string;
  hasAttachments: boolean;
}

/** A message as read back out of the mirror. */
export interface CachedMessage {
  account: string;
  mailbox: string;
  uid: number;
  uidValidity: string;
  modseq?: string;
  envelope: unknown;
  bodyStructure?: unknown;
  flags: string[];
  messageId?: string;
  inReplyTo?: string;
  references?: string[];
  internalDate: number;
  subject?: string;
  fromText?: string;
  preview?: string;
  bodyText?: string;
  bodyFetchedAt?: number;
  hasAttachments: boolean;
  cachedAt: number;
}

export interface MailboxState {
  account: string;
  mailbox: string;
  uidValidity: string;
  uidNext?: number;
  highestModseq?: string;
  syncTier: SyncTier;
  totalMessages?: number;
  unseenMessages?: number;
  lastSyncedAt?: number;
}

/** Immutable per (uid, uidValidity); see BodyBundle in imap.service.ts. */
export interface BodyBundleData {
  envelope: unknown;
  bodyStructure: unknown;
  headersRaw: string;
  bodyText?: string;
  bodyHtml?: string;
}

export interface BodyRow {
  status: 'ok' | 'skipped';
  skipReason?: string;
  extractorVersion: number;
  bundle?: BodyBundleData;
  fetchedAt: number;
}

export interface PageOptions {
  page: number;
  pageSize: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** Raw row shape as returned by SQLite. */
interface MailboxStateRow {
  account: string;
  mailbox: string;
  uid_validity: string;
  uid_next: number | null;
  highest_modseq: string | null;
  sync_tier: string;
  total_messages: number | null;
  unseen_messages: number | null;
  last_synced_at: number | null;
}

interface MessageRow {
  account: string;
  mailbox: string;
  uid: number;
  uid_validity: string;
  modseq: string | null;
  envelope_json: string;
  body_structure_json: string | null;
  flags_json: string;
  message_id: string | null;
  in_reply_to: string | null;
  references_json: string | null;
  internal_date: number;
  subject: string | null;
  from_text: string | null;
  preview: string | null;
  body_text: string | null;
  body_fetched_at: number | null;
  has_attachments: number;
  cached_at: number;
}

interface BodyDbRow {
  uid_validity: string;
  status: string;
  skip_reason: string | null;
  extractor_version: number;
  envelope_json: string | null;
  body_structure_json: string | null;
  headers_raw: string | null;
  body_text: string | null;
  body_html: string | null;
  fetched_at: number;
}

function rowToBody(row: BodyDbRow): BodyRow {
  const ok = row.status === 'ok';
  return {
    status: ok ? 'ok' : 'skipped',
    skipReason: row.skip_reason ?? undefined,
    extractorVersion: row.extractor_version,
    fetchedAt: row.fetched_at,
    bundle: ok
      ? {
          envelope: row.envelope_json ? JSON.parse(row.envelope_json) : undefined,
          bodyStructure: row.body_structure_json ? JSON.parse(row.body_structure_json) : undefined,
          headersRaw: row.headers_raw ?? '',
          bodyText: row.body_text ?? undefined,
          bodyHtml: row.body_html ?? undefined,
        }
      : undefined,
  };
}

/** accessed_at is only rewritten when older than this, so reads are not writes. */
const TOUCH_THROTTLE_MS = 60 * 60 * 1000;

function rowToMessage(row: MessageRow): CachedMessage {
  return {
    account: row.account,
    mailbox: row.mailbox,
    uid: row.uid,
    uidValidity: row.uid_validity,
    modseq: row.modseq ?? undefined,
    envelope: JSON.parse(row.envelope_json),
    bodyStructure: row.body_structure_json ? JSON.parse(row.body_structure_json) : undefined,
    flags: JSON.parse(row.flags_json),
    messageId: row.message_id ?? undefined,
    inReplyTo: row.in_reply_to ?? undefined,
    references: row.references_json ? JSON.parse(row.references_json) : undefined,
    internalDate: row.internal_date,
    subject: row.subject ?? undefined,
    fromText: row.from_text ?? undefined,
    preview: row.preview ?? undefined,
    bodyText: row.body_text ?? undefined,
    bodyFetchedAt: row.body_fetched_at ?? undefined,
    hasAttachments: row.has_attachments === 1,
    cachedAt: row.cached_at,
  };
}

/**
 * Escape a user query for FTS5 MATCH.
 *
 * FTS5 has its own query syntax where bare `-`, `*`, `"` and `:` are
 * operators. Users type mail search terms, not FTS5 expressions, so each token
 * is quoted and treated literally rather than risking a syntax error on a
 * subject line like "Re: Q3 -- draft".
 */
function toFtsQuery(query: string): string {
  const tokens = query.match(/[\p{L}\p{N}_]+/gu) ?? [];
  return tokens.map((t) => `"${t}"`).join(' ');
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

/** SQLite result codes for a file that is not, or no longer, a readable database. */
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

export default class CacheStore {
  private db!: DatabaseSync;

  /** Opens the file and applies the schema; a failure closes it again. */
  private openDb(dbPath: string): void {
    // `timeout` sets busy_timeout, so concurrent readers wait rather than
    // failing immediately with SQLITE_BUSY.
    this.db = new DatabaseSync(dbPath, { timeout: 5000 });
    try {
      // WAL lets readers proceed during a write — important because sync runs in
      // the background while tool calls read. NORMAL trades an fsync per commit
      // for a small crash window, which is the right call for regenerable data.
      this.db.exec('PRAGMA journal_mode = WAL');
      this.db.exec('PRAGMA synchronous = NORMAL');
      this.db.exec('PRAGMA foreign_keys = ON');
      this.migrate();
    } catch (err) {
      this.db.close();
      throw err;
    }
  }

  private static isNotADatabase(err: unknown): boolean {
    const { errcode } = (err ?? {}) as { errcode?: unknown };
    return errcode === SQLITE_NOTADB || errcode === SQLITE_CORRUPT;
  }

  /**
   * @param dbPath filesystem path, or ':memory:' for tests.
   */
  constructor(
    dbPath: string,
    /** Injectable so tests can exercise the failure path. */
    private migrations: Array<{ to: number; sql: string }> = MIGRATIONS,
  ) {
    if (dbPath !== ':memory:') {
      // 0700: the mirror holds message bodies, so it is owner-only. This plus
      // full-disk encryption is the documented at-rest posture.
      const dir = path.dirname(dbPath);
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      // A folder that already existed keeps its old mode, and the -wal and
      // -shm files SQLite creates copy the database file's mode: so make the
      // folder owner-only and create the database file owner-only up front.
      fs.chmodSync(dir, 0o700);
      fs.closeSync(fs.openSync(dbPath, 'a', 0o600));
    }

    try {
      this.openDb(dbPath);
    } catch (err) {
      if (dbPath === ':memory:' || !CacheStore.isNotADatabase(err)) throw err;
      // The mirror is regenerable: keep the broken file for a look, start a fresh one.
      const aside = `${dbPath}.corrupt-${Date.now()}`;
      fs.renameSync(dbPath, aside);
      for (const side of [`${dbPath}-wal`, `${dbPath}-shm`]) fs.rmSync(side, { force: true });
      fs.closeSync(fs.openSync(dbPath, 'a', 0o600));
      this.openDb(dbPath);
    }

    if (dbPath !== ':memory:') {
      for (const file of [dbPath, `${dbPath}-wal`, `${dbPath}-shm`]) {
        try {
          fs.chmodSync(file, 0o600);
        } catch {
          // The side files exist only while the database is in use.
        }
      }
    }
  }

  /**
   * Apply the schema. A file written by a newer build is left alone and this
   * process runs without the mirror: rebuilding it would wipe the tables of a
   * newer version running beside this one, which would then rebuild them on
   * its next open, and the two would take turns. A failed upgrade step
   * rebuilds, since the mirror is regenerable.
   */
  private migrate(): void {
    const { user_version: version } = this.db.prepare('PRAGMA user_version').get() as {
      user_version: number;
    };

    if (version > SCHEMA_VERSION) {
      throw new Error(
        `the cache was written by a newer version of IMAP Wizard (schema ${version}, this one reads ${SCHEMA_VERSION}). The local mirror stays off in this process; update it, or close the newer one and delete the cache file.`,
      );
    }

    // Creates anything missing, including tables added since the file was
    // written. Steps below only change what already exists.
    this.db.exec(SCHEMA_SQL);

    try {
      this.migrations
        .filter((m) => m.to > version)
        .sort((x, y) => x.to - y.to)
        .forEach((m) => {
          this.transaction(() => {
            this.db.exec(m.sql);
            this.db.exec(`PRAGMA user_version = ${m.to}`);
          });
        });
    } catch {
      // A half-migrated mirror is worse than an empty one, and the mirror is
      // regenerable, so a failed step must never stop startup.
      this.rebuild();
      return;
    }

    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /** Discard every table and recreate the current schema. */
  private rebuild(): void {
    this.db.exec('DROP TABLE IF EXISTS message_fts');
    this.db.exec('DROP TABLE IF EXISTS message_body');
    this.db.exec('DROP TABLE IF EXISTS message');
    this.db.exec('DROP TABLE IF EXISTS mailbox_state');
    this.db.exec('DROP TABLE IF EXISTS account_identity');
    this.db.exec(SCHEMA_SQL);
    this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  }

  /**
   * Run `fn` inside an immediate transaction.
   *
   * BEGIN IMMEDIATE rather than the default deferred: busy_timeout does not
   * apply when a read transaction tries to upgrade to a write, which is the
   * usual source of spurious SQLITE_BUSY errors.
   */
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /**
   * Query helpers.
   *
   * `node:sqlite` types rows as `Record<string, SQLOutputValue>`, which never
   * structurally overlaps a concrete row interface. The cast is unavoidable;
   * confining it to these two helpers keeps it from spreading across every
   * query, and the row interfaces stay the single description of table shape.
   */
  private queryAll<T>(sql: string, ...params: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  private queryOne<T>(sql: string, ...params: (string | number | null)[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // Messages
  // -------------------------------------------------------------------------

  /**
   * Insert or update messages.
   *
   * An already-downloaded body is preserved: a metadata resync (a flag change,
   * say) must not discard content and force a second download.
   */
  putMessages(messages: CachedMessageInput[]): void {
    if (messages.length === 0) return;

    const stmt = this.db.prepare(`
      INSERT INTO message (
        account, mailbox, uid, uid_validity, modseq,
        envelope_json, body_structure_json, flags_json,
        message_id, in_reply_to, references_json,
        internal_date, subject, from_text, preview,
        has_attachments, cached_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (account, mailbox, uid, uid_validity) DO UPDATE SET
        modseq              = excluded.modseq,
        envelope_json       = excluded.envelope_json,
        body_structure_json = excluded.body_structure_json,
        flags_json          = excluded.flags_json,
        message_id          = excluded.message_id,
        in_reply_to         = excluded.in_reply_to,
        references_json     = excluded.references_json,
        internal_date       = excluded.internal_date,
        subject             = excluded.subject,
        from_text           = excluded.from_text,
        preview             = excluded.preview,
        has_attachments     = excluded.has_attachments,
        cached_at           = excluded.cached_at
    `);

    const now = Date.now();
    this.transaction(() => {
      messages.forEach((m) => {
        stmt.run(
          m.account,
          m.mailbox,
          m.uid,
          m.uidValidity,
          m.modseq ?? null,
          JSON.stringify(m.envelope),
          m.bodyStructure ? JSON.stringify(m.bodyStructure) : null,
          JSON.stringify(m.flags),
          m.messageId ?? null,
          m.inReplyTo ?? null,
          m.references ? JSON.stringify(m.references) : null,
          m.internalDate,
          m.subject ?? null,
          m.fromText ?? null,
          m.preview ?? null,
          m.hasAttachments ? 1 : 0,
          now,
        );
      });
    });
  }

  /** Attach a downloaded body to an existing message. */
  putBody(
    account: string,
    mailbox: string,
    uid: number,
    uidValidity: string,
    bodyText: string,
  ): void {
    this.db
      .prepare(`
        UPDATE message SET body_text = ?, body_fetched_at = ?
        WHERE account = ? AND mailbox = ? AND uid = ? AND uid_validity = ?
      `)
      .run(bodyText, Date.now(), account, mailbox, uid, uidValidity);
  }

  getMessage(
    account: string,
    mailbox: string,
    uid: number,
    uidValidity: string,
  ): CachedMessage | undefined {
    const row = this.queryOne<MessageRow>(
      `SELECT * FROM message
       WHERE account = ? AND mailbox = ? AND uid = ? AND uid_validity = ?`,
      account,
      mailbox,
      uid,
      uidValidity,
    );

    return row ? rowToMessage(row) : undefined;
  }

  /** Look a message up by Message-ID across every mailbox of an account. */
  findByMessageId(account: string, messageId: string): CachedMessage[] {
    return this.queryAll<MessageRow>(
      'SELECT * FROM message WHERE account = ? AND message_id = ?',
      account,
      messageId,
    ).map(rowToMessage);
  }

  /** Newest-first page. Costs the same at page 50 as at page 1. */
  listMessages(
    account: string,
    mailbox: string,
    uidValidity: string,
    options: PageOptions,
  ): Page<CachedMessage> {
    const { page, pageSize } = options;
    const offset = (page - 1) * pageSize;

    const total =
      this.queryOne<{ total: number }>(
        `SELECT COUNT(*) AS total FROM message
         WHERE account = ? AND mailbox = ? AND uid_validity = ?`,
        account,
        mailbox,
        uidValidity,
      )?.total ?? 0;

    const rows = this.queryAll<MessageRow>(
      `SELECT * FROM message
       WHERE account = ? AND mailbox = ? AND uid_validity = ?
       ORDER BY internal_date DESC
       LIMIT ? OFFSET ?`,
      account,
      mailbox,
      uidValidity,
      pageSize,
      offset,
    );

    return {
      items: rows.map(rowToMessage),
      total,
      page,
      pageSize,
      hasMore: offset + rows.length < total,
    };
  }

  /** Full-text search over subject, sender and body, ranked by bm25. */
  searchMessages(
    account: string,
    mailbox: string,
    uidValidity: string,
    query: string,
    limit = 100,
  ): CachedMessage[] {
    const ftsQuery = toFtsQuery(query);
    if (ftsQuery.length === 0) return [];

    return this.queryAll<MessageRow>(
      `SELECT m.* FROM message_fts f
       JOIN message m ON m.rowid = f.rowid
       WHERE message_fts MATCH ?
         AND m.account = ? AND m.mailbox = ? AND m.uid_validity = ?
       ORDER BY bm25(message_fts)
       LIMIT ?`,
      ftsQuery,
      account,
      mailbox,
      uidValidity,
      limit,
    ).map(rowToMessage);
  }

  /**
   * Every cached UID for one mailbox generation.
   *
   * Used by the sync engine to diff against the server's UID set, which on a
   * server without QRESYNC is the only way a deletion is ever detected.
   */
  listAllUids(account: string, mailbox: string, uidValidity: string): number[] {
    return this.queryAll<{ uid: number }>(
      `SELECT uid FROM message
       WHERE account = ? AND mailbox = ? AND uid_validity = ?`,
      account,
      mailbox,
      uidValidity,
    ).map((r) => r.uid);
  }

  countMessages(account: string, mailbox: string): number {
    return (
      this.queryOne<{ total: number }>(
        'SELECT COUNT(*) AS total FROM message WHERE account = ? AND mailbox = ?',
        account,
        mailbox,
      )?.total ?? 0
    );
  }

  deleteMessages(account: string, mailbox: string, uids: number[], uidValidity: string): void {
    if (uids.length === 0) return;

    const stmt = this.db.prepare(`
      DELETE FROM message
      WHERE account = ? AND mailbox = ? AND uid = ? AND uid_validity = ?
    `);

    this.transaction(() => {
      uids.forEach((uid) => {
        stmt.run(account, mailbox, uid, uidValidity);
      });
    });
  }

  /**
   * Delete messages older than a cutoff (epoch milliseconds on internal_date).
   *
   * Enforces the `window_days` mirror cap: without it the sync engine fetches
   * `1:*` forever and the local mirror grows without bound.
   *
   * @returns how many messages were discarded.
   */
  pruneOlderThan(account: string, mailbox: string, uidValidity: string, cutoffMs: number): number {
    return this.transaction(() => {
      const { changes } = this.db
        .prepare(`
          DELETE FROM message
          WHERE account = ? AND mailbox = ? AND uid_validity = ? AND internal_date < ?
        `)
        .run(account, mailbox, uidValidity, cutoffMs);

      return Number(changes);
    });
  }

  /**
   * Delete the oldest messages first, across every mailbox.
   *
   * Enforces the `max_size_mb` backstop. Oldest-first keeps the mirror useful
   * for recent mail while the budget holds, and a bounded chunk per call keeps
   * any single sync from stalling on a huge delete.
   *
   * @returns how many messages were discarded.
   */
  pruneOldest(limit: number): number {
    return this.transaction(() => {
      const { changes } = this.db
        .prepare(`
          DELETE FROM message WHERE rowid IN (
            SELECT rowid FROM message ORDER BY internal_date ASC LIMIT ?
          )
        `)
        .run(limit);

      return Number(changes);
    });
  }

  /**
   * Reclaim freed pages so `sizeBytes()` reflects the prune.
   *
   * SQLite keeps deleted rows as freelist pages, which `page_count` still
   * counts — without this the size guard would never observe its own work.
   * Called only when a sync actually discarded messages.
   */
  vacuum(): void {
    this.db.exec('VACUUM');
  }

  // -------------------------------------------------------------------------
  // Message bodies (immutable per uid + uidValidity)
  // -------------------------------------------------------------------------

  getBody(account: string, mailbox: string, uid: number, uidValidity: string): BodyRow | undefined {
    const row = this.queryOne<BodyDbRow>(
      `SELECT * FROM message_body
       WHERE account = ? AND mailbox = ? AND uid = ? AND uid_validity = ?`,
      account,
      mailbox,
      uid,
      uidValidity,
    );
    return row ? rowToBody(row) : undefined;
  }

  putBodyBundle(
    account: string,
    mailbox: string,
    uid: number,
    uidValidity: string,
    bundle: BodyBundleData,
    extractorVersion: number,
  ): void {
    const bytes =
      Buffer.byteLength(bundle.headersRaw, 'utf-8') +
      Buffer.byteLength(bundle.bodyText ?? '', 'utf-8') +
      Buffer.byteLength(bundle.bodyHtml ?? '', 'utf-8');
    const now = Date.now();

    this.db
      .prepare(`
        INSERT OR REPLACE INTO message_body (
          account, mailbox, uid, uid_validity, status, skip_reason, extractor_version,
          envelope_json, body_structure_json, headers_raw, body_text, body_html,
          bytes, fetched_at, accessed_at
        ) VALUES (?, ?, ?, ?, 'ok', NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        account,
        mailbox,
        uid,
        uidValidity,
        extractorVersion,
        JSON.stringify(bundle.envelope ?? null),
        JSON.stringify(bundle.bodyStructure ?? null),
        bundle.headersRaw,
        bundle.bodyText ?? null,
        bundle.bodyHtml ?? null,
        bytes,
        now,
        now,
      );
  }

  /** Remember that a message was not cached, and why, so it is not retried blindly. */
  markBodySkipped(
    account: string,
    mailbox: string,
    uid: number,
    uidValidity: string,
    reason: string,
    extractorVersion: number,
  ): void {
    const now = Date.now();
    this.db
      .prepare(`
        INSERT OR REPLACE INTO message_body (
          account, mailbox, uid, uid_validity, status, skip_reason, extractor_version,
          bytes, fetched_at, accessed_at
        ) VALUES (?, ?, ?, ?, 'skipped', ?, ?, 0, ?, ?)
      `)
      .run(account, mailbox, uid, uidValidity, reason, extractorVersion, now, now);
  }

  /** Record a read for LRU. Skipped when accessed within the last hour. */
  touchBody(account: string, mailbox: string, uid: number, uidValidity: string): void {
    const now = Date.now();
    this.db
      .prepare(`
        UPDATE message_body SET accessed_at = ?
        WHERE account = ? AND mailbox = ? AND uid = ? AND uid_validity = ?
          AND accessed_at < ?
      `)
      .run(now, account, mailbox, uid, uidValidity, now - TOUCH_THROTTLE_MS);
  }

  /** Drop bodies of these UIDs in every generation. Frees space early; not needed for correctness. */
  forgetBodies(account: string, mailbox: string, uids: number[]): void {
    if (uids.length === 0) return;
    const stmt = this.db.prepare(
      'DELETE FROM message_body WHERE account = ? AND mailbox = ? AND uid = ?',
    );
    this.transaction(() => {
      uids.forEach((uid) => {
        stmt.run(account, mailbox, uid);
      });
    });
  }

  /**
   * Offline lookup when the server cannot confirm the current UIDVALIDITY.
   *
   * mailbox_state is the best record of the current generation. Without it, a
   * single stored generation is accepted; several are ambiguous, so a miss.
   */
  findBodyAnyGeneration(
    account: string,
    mailbox: string,
    uid: number,
  ): (BodyRow & { uidValidity: string }) | undefined {
    const rows = this.queryAll<BodyDbRow>(
      `SELECT * FROM message_body
       WHERE account = ? AND mailbox = ? AND uid = ? AND status = 'ok'`,
      account,
      mailbox,
      uid,
    );
    if (rows.length === 0) return undefined;

    const state = this.getMailboxState(account, mailbox);
    const chosen = state ? rows.find((r) => r.uid_validity === state.uidValidity) : undefined;
    const row = chosen ?? (state === undefined && rows.length === 1 ? rows[0] : undefined);
    return row ? { ...rowToBody(row), uidValidity: row.uid_validity } : undefined;
  }

  /**
   * Mirrored UIDs with no usable body, newest first.
   *
   * Skipped rows are excluded on purpose (backfill must not retry them); ok
   * rows written by an older extractor count as missing. `newestN` limits the
   * candidates to the newest N messages of the mailbox.
   */
  listUidsMissingBody(
    account: string,
    mailbox: string,
    uidValidity: string,
    limit: number,
    extractorVersion: number,
    newestN?: number,
  ): number[] {
    const windowSql =
      newestN === undefined
        ? 'SELECT m.uid, m.internal_date FROM message m WHERE m.account = ? AND m.mailbox = ? AND m.uid_validity = ?'
        : `SELECT m.uid, m.internal_date FROM message m
           WHERE m.account = ? AND m.mailbox = ? AND m.uid_validity = ?
           ORDER BY m.internal_date DESC LIMIT ${Math.max(0, Math.floor(newestN))}`;

    return this.queryAll<{ uid: number }>(
      `SELECT w.uid FROM (${windowSql}) w
       LEFT JOIN message_body b
         ON b.account = ? AND b.mailbox = ? AND b.uid = w.uid AND b.uid_validity = ?
       WHERE b.uid IS NULL OR (b.status = 'ok' AND b.extractor_version < ?)
       ORDER BY w.internal_date DESC
       LIMIT ?`,
      account,
      mailbox,
      uidValidity,
      account,
      mailbox,
      uidValidity,
      extractorVersion,
      limit,
    ).map((r) => r.uid);
  }

  /** Bytes held by cached bodies. */
  bodyBytes(): number {
    return (
      this.queryOne<{ total: number | null }>(
        "SELECT SUM(bytes) AS total FROM message_body WHERE status = 'ok'",
      )?.total ?? 0
    );
  }

  /** Number of bodies with real content. */
  countOkBodies(): number {
    return (
      this.queryOne<{ total: number }>(
        "SELECT COUNT(*) AS total FROM message_body WHERE status = 'ok'",
      )?.total ?? 0
    );
  }

  /** Delete the least recently read rows, skipped ones included. */
  evictBodiesLru(limitRows: number): number {
    const { changes } = this.db
      .prepare(`
        DELETE FROM message_body WHERE rowid IN (
          SELECT rowid FROM message_body ORDER BY accessed_at ASC LIMIT ?
        )
      `)
      .run(limitRows);
    return Number(changes);
  }

  // -------------------------------------------------------------------------
  // Mailbox state
  // -------------------------------------------------------------------------

  putMailboxState(state: MailboxState): void {
    this.db
      .prepare(`
        INSERT INTO mailbox_state (
          account, mailbox, uid_validity, uid_next, highest_modseq,
          sync_tier, total_messages, unseen_messages, last_synced_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (account, mailbox) DO UPDATE SET
          uid_validity    = excluded.uid_validity,
          uid_next        = excluded.uid_next,
          highest_modseq  = excluded.highest_modseq,
          sync_tier       = excluded.sync_tier,
          total_messages  = excluded.total_messages,
          unseen_messages = excluded.unseen_messages,
          last_synced_at  = excluded.last_synced_at
      `)
      .run(
        state.account,
        state.mailbox,
        state.uidValidity,
        state.uidNext ?? null,
        state.highestModseq ?? null,
        state.syncTier,
        state.totalMessages ?? null,
        state.unseenMessages ?? null,
        state.lastSyncedAt ?? Date.now(),
      );
  }

  getMailboxState(account: string, mailbox: string): MailboxState | undefined {
    const row = this.queryOne<MailboxStateRow>(
      'SELECT * FROM mailbox_state WHERE account = ? AND mailbox = ?',
      account,
      mailbox,
    );

    if (!row) return undefined;

    return {
      account: row.account,
      mailbox: row.mailbox,
      uidValidity: row.uid_validity,
      uidNext: row.uid_next ?? undefined,
      highestModseq: row.highest_modseq ?? undefined,
      syncTier: row.sync_tier as SyncTier,
      totalMessages: row.total_messages ?? undefined,
      unseenMessages: row.unseen_messages ?? undefined,
      lastSyncedAt: row.last_synced_at ?? undefined,
    };
  }

  /**
   * Start a new cache epoch for a mailbox.
   *
   * Called when the server reports a UIDVALIDITY different from the stored
   * one: every cached UID for that mailbox now refers to a different message,
   * so the generation is dropped wholesale.
   *
   * @returns how many messages were discarded.
   */
  resetEpoch(account: string, mailbox: string, newUidValidity: string): number {
    return this.transaction(() => {
      const { changes } = this.db
        .prepare(`
          DELETE FROM message
          WHERE account = ? AND mailbox = ? AND uid_validity <> ?
        `)
        .run(account, mailbox, newUidValidity);

      // Bodies for UIDs with no message row are not reached by the gc trigger.
      this.db
        .prepare(`
          DELETE FROM message_body
          WHERE account = ? AND mailbox = ? AND uid_validity <> ?
        `)
        .run(account, mailbox, newUidValidity);

      this.db
        .prepare(`
          INSERT INTO mailbox_state (account, mailbox, uid_validity, sync_tier)
          VALUES (?, ?, ?, 'baseline')
          ON CONFLICT (account, mailbox) DO UPDATE SET
            uid_validity   = excluded.uid_validity,
            uid_next       = NULL,
            highest_modseq = NULL
        `)
        .run(account, mailbox, newUidValidity);

      return Number(changes);
    });
  }

  // -------------------------------------------------------------------------
  // Maintenance
  // -------------------------------------------------------------------------

  /** Drop mirrored mail. Never touches the outbox, which is a separate file. */
  clear(account?: string): void {
    this.transaction(() => {
      if (account) {
        this.db.prepare('DELETE FROM message WHERE account = ?').run(account);
        this.db.prepare('DELETE FROM message_body WHERE account = ?').run(account);
        this.db.prepare('DELETE FROM mailbox_state WHERE account = ?').run(account);
        this.db.prepare('DELETE FROM account_identity WHERE account = ?').run(account);
      } else {
        this.db.exec('DELETE FROM message');
        this.db.exec('DELETE FROM message_body');
        this.db.exec('DELETE FROM mailbox_state');
        this.db.exec('DELETE FROM account_identity');
      }
    });
  }

  /**
   * Record which server and login an account name points at, and drop its
   * mirrored mail when that changed: the new server can reuse the same
   * UIDVALIDITY and UIDs for different messages. A name seen for the first
   * time is recorded as it is.
   *
   * @returns true when rows were dropped.
   */
  bindAccountIdentity(account: string, fingerprint: string): boolean {
    const row = this.queryOne<{ fingerprint: string }>(
      'SELECT fingerprint FROM account_identity WHERE account = ?',
      account,
    );
    if (row?.fingerprint === fingerprint) return false;
    const changed = row !== undefined;
    if (changed) this.clear(account);
    this.db
      .prepare(`
        INSERT INTO account_identity (account, fingerprint) VALUES (?, ?)
        ON CONFLICT (account) DO UPDATE SET fingerprint = excluded.fingerprint
      `)
      .run(account, fingerprint);
    return changed;
  }

  /** On-disk size in bytes, for `cache status`. */
  sizeBytes(): number {
    return (
      this.queryOne<{ size: number }>(
        'SELECT page_count * page_size AS size FROM pragma_page_count(), pragma_page_size()',
      )?.size ?? 0
    );
  }
}

/**
 * Drop one account's mirrored mail from the cache file, for `account delete`.
 * A missing or unusable cache is left alone: there is nothing to forget, and a
 * cache problem must not fail the delete. Opening never creates the file.
 *
 * @returns true when the file was opened and cleared.
 */
export function forgetCachedAccount(dbPath: string, account: string): boolean {
  if (!fs.existsSync(dbPath)) return false;
  let store: CacheStore | undefined;
  try {
    store = new CacheStore(dbPath);
    store.clear(account);
    return true;
  } catch {
    return false;
  } finally {
    store?.close();
  }
}
