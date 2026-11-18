/**
 * The safety layer over the ManageSieve client.
 *
 *   - Every script that is saved or activated is scanned, includes too. A forward
 *     to an address outside `sieve.allowed_redirects` is refused, and so is a
 *     `filter` program outside `sieve.allowed_programs`; nothing a tool passes can
 *     change those lists or get around them. An include of a server-wide script
 *     (which cannot be read) is refused too.
 *   - Saving previews by default (diff plus risky actions). Saving over the active
 *     script makes it live at once (RFC 5804), and the preview says so.
 *   - Before a script is replaced or deleted it is copied to
 *     `imapwiz-backup-<timestamp>-<name>`. If the backup fails, nothing is changed.
 *   - The active script cannot be deleted, nor can a script the active one includes
 *     (directly or through other scripts); deactivating everything needs
 *     `disableAll: true`. A backup that is the only copy of a deleted script cannot
 *     be deleted either.
 */

import type { AccountConfig } from '../types/index.js';
import { lineDiff } from '../utils/line-diff.js';
import type SieveService from './sieve.service.js';
import type { SieveScriptInfo, SieveSession, SieveStatus } from './sieve.service.js';
import {
  assertSieveScriptContent,
  assertSieveScriptName,
  SieveCommandError,
} from './sieve.service.js';
import type { SieveFinding, SieveScan } from './sieve-scan.js';
import { scanWithIncludes } from './sieve-scan.js';

export const BACKUP_PREFIX = 'imapwiz-backup-';

/** Keeps backup names within the 128 characters every server must accept. */
const MAX_PORTABLE_NAME = 128;

export interface ServerCheck {
  supported: boolean;
  ok: boolean;
  message: string;
  warnings?: string;
}

export interface CheckReport {
  name: string;
  server: ServerCheck;
  scan: SieveScan;
  /** Findings added here: fileinto to a folder that does not exist. */
  folderFindings: SieveFinding[];
  blocked: boolean;
}

export interface PutReport extends CheckReport {
  applied: boolean;
  exists: boolean;
  /** The script is the active one, so saving it changes live filtering. */
  live: boolean;
  /** Set when the script is live because the active script includes it. */
  liveVia?: string;
  diff: string[];
  backup?: string;
  /** Why the write was refused, when it was. */
  refused?: string;
  serverWarnings?: string;
}

export interface ActivateReport {
  applied: boolean;
  name: string;
  previous: string | null;
  scan?: SieveScan;
  blocked: boolean;
  refused?: string;
}

export interface DeleteReport {
  applied: boolean;
  name: string;
  backup?: string;
  refused?: string;
}

export interface SieveManagerDeps {
  sieve: SieveService;
  /** The human-edited allowlist from config.toml, as loaded at start-up. Read only. */
  allowlist: readonly string[];
  /**
   * Reads the allowlist fresh from config.toml. When given it is used on every
   * scan, so removing an address takes effect in a running process.
   */
  readAllowlist?: () => Promise<readonly string[]>;
  /** Server programs `filter` may run (`sieve.allowed_programs`), as loaded at start-up. */
  allowedPrograms?: readonly string[];
  /** Reads `sieve.allowed_programs` fresh from config.toml on every scan. */
  readAllowedPrograms?: () => Promise<readonly string[]>;
  /** Folder paths of the account, or null when they cannot be listed. */
  listFolders: (account: string) => Promise<string[] | null>;
  now?: () => Date;
}

export function backupName(name: string, at: Date, taken: ReadonlySet<string>): string {
  const stamp = at
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const head = `${BACKUP_PREFIX}${stamp}-`;
  const base = `${head}${name}`.slice(0, MAX_PORTABLE_NAME);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX_PORTABLE_NAME - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Names under which servers put other users' mail or shared folders. */
const OTHER_NAMESPACE = /^(?:#?(?:shared|user|users|public|other users)|~[^./\\]*)(?:[./\\]|$)/i;

/**
 * The script names a backup could have been made from: the part after the
 * timestamp, with and without the `-N` suffix added when two backups collide.
 */
function backupOriginals(backup: string): string[] {
  const rest = backup.slice(BACKUP_PREFIX.length).replace(/^\d{8}T\d{6}Z-/, '');
  const bare = rest.replace(/-\d+$/, '');
  return bare === rest ? [rest] : [rest, bare];
}

function folderMatches(folder: string, folders: readonly string[]): boolean {
  if (/^inbox$/i.test(folder)) return true;
  return folders.some((f) => f === folder);
}

export default class SieveManager {
  private readonly allowlist: readonly string[];

  private readonly programs: readonly string[];

  constructor(private readonly deps: SieveManagerDeps) {
    this.allowlist = Object.freeze([...deps.allowlist]);
    this.programs = Object.freeze([...(deps.allowedPrograms ?? [])]);
  }

  /** The forwarding allowlist as it stands in config.toml now (a copy). */
  async allowedRedirects(): Promise<string[]> {
    return [...(await this.currentAllowlist())];
  }

  /** Fresh from config.toml when a reader is wired in; an unreadable file allows nothing. */
  private async currentAllowlist(): Promise<readonly string[]> {
    if (!this.deps.readAllowlist) return this.allowlist;
    try {
      return await this.deps.readAllowlist();
    } catch {
      return [];
    }
  }

  /** The `filter` program allowlist as it stands in config.toml now (a copy). */
  async allowedPrograms(): Promise<string[]> {
    return [...(await this.currentPrograms())];
  }

  /** Allowed `filter` programs, read like the redirect list: unreadable means none. */
  private async currentPrograms(): Promise<readonly string[]> {
    if (!this.deps.readAllowedPrograms) return this.programs;
    try {
      return await this.deps.readAllowedPrograms();
    } catch {
      return [];
    }
  }

  async status(account: AccountConfig): Promise<SieveStatus> {
    return this.deps.sieve.status(account);
  }

  async listScripts(account: AccountConfig): Promise<SieveScriptInfo[]> {
    return this.deps.sieve.withSession(account, (s) => s.listScripts());
  }

  async getScript(
    account: AccountConfig,
    name: string,
  ): Promise<{ name: string; content: string; active: boolean }> {
    return this.deps.sieve.withSession(account, async (s) => {
      const scripts = await s.listScripts();
      const content = await s.getScript(name);
      return { name, content, active: scripts.some((x) => x.name === name && x.active) };
    });
  }

  /** Server check (when offered) plus the risky-action scan, on a script given or stored. */
  async checkScript(
    account: AccountConfig,
    input: { name?: string; content?: string },
  ): Promise<CheckReport> {
    // Too large: refuse before any connection is opened or any scanning is done.
    if (input.content !== undefined) assertSieveScriptContent(input.content);
    return this.deps.sieve.withSession(account, async (s) => {
      const name = input.name ?? '(unsaved script)';
      const content = input.content ?? (await s.getScript(name));
      return this.check(account, s, name, content);
    });
  }

  async putScript(
    account: AccountConfig,
    name: string,
    content: string,
    apply: boolean,
  ): Promise<PutReport> {
    // Refuse a bad name or an oversized script now, in a preview too, before any connection.
    assertSieveScriptName(name);
    assertSieveScriptContent(content);
    return this.deps.sieve.withSession(account, async (s) => {
      const scripts = await s.listScripts();
      const existing = scripts.find((x) => x.name === name);
      const before = existing ? await s.getScript(name) : '';
      const report: PutReport = {
        ...(await this.check(account, s, name, content)),
        applied: false,
        exists: Boolean(existing),
        live: Boolean(existing?.active),
        diff: lineDiff(before, content),
      };
      // A script the active one includes is live too, even though it is not active.
      const active = scripts.find((x) => x.active);
      if (active && active.name !== name) {
        // Only read, to learn what is live: a server-wide include in the active script
        // must not stop an unrelated script from being saved.
        const activeScan = await this.scan(s, active.name, await s.getScript(active.name), {
          blockGlobalIncludes: false,
        });
        if (activeScan.includes.some((inc) => !inc.global && inc.name === name)) {
          report.live = true;
          report.liveVia = active.name;
        }
      }
      if (report.blocked) {
        report.refused = report.scan.blocked
          ? 'The script forwards mail or runs actions that cannot be allowed (see BLOCKED lines).'
          : 'The server rejected the script.';
        return report;
      }
      if (!apply) return report;

      if (existing) {
        report.backup = await this.backup(s, scripts, name, before);
      }
      try {
        const { warnings } = await s.putScript(name, content);
        report.serverWarnings = warnings ? s.scrub(warnings) : undefined;
      } catch (err) {
        if (!(err instanceof SieveCommandError)) throw err;
        report.refused = `The server refused the script: ${s.scrub(err.serverMessage)}`;
        // The refused upload changed nothing, so its backup is only clutter that
        // counts against the server's script limit.
        if (report.backup) {
          try {
            await s.deleteScript(report.backup);
            report.backup = undefined;
          } catch {
            // Keep it listed: the text says where it is.
          }
        }
        return report;
      }
      report.applied = true;
      return report;
    });
  }

  async activateScript(
    account: AccountConfig,
    name: string,
    disableAll: boolean,
    apply: boolean,
  ): Promise<ActivateReport> {
    if (name === '' && !disableAll) {
      throw new Error(
        'Give a script name, or set disableAll: true to turn off every server-side rule',
      );
    }
    if (name !== '' && disableAll) {
      throw new Error('disableAll: true deactivates every script; leave the name empty');
    }
    return this.deps.sieve.withSession(account, async (s) => {
      const scripts = await s.listScripts();
      const previous = scripts.find((x) => x.active)?.name ?? null;
      const report: ActivateReport = { applied: false, name, previous, blocked: false };
      if (name !== '') {
        if (!scripts.some((x) => x.name === name)) {
          report.refused = `There is no script named "${name}"`;
          return report;
        }
        const content = await s.getScript(name);
        report.scan = await this.scan(s, name, content);
        report.blocked = report.scan.blocked;
        if (report.blocked) {
          report.refused =
            'The script forwards mail or runs actions that cannot be allowed (see BLOCKED lines).';
          return report;
        }
      }
      if (!apply) return report;
      await s.setActive(name);
      report.applied = true;
      return report;
    });
  }

  async deleteScript(account: AccountConfig, name: string, apply: boolean): Promise<DeleteReport> {
    return this.deps.sieve.withSession(account, async (s) => {
      const scripts = await s.listScripts();
      const target = scripts.find((x) => x.name === name);
      const report: DeleteReport = { applied: false, name };
      if (!target) {
        report.refused = `There is no script named "${name}"`;
        return report;
      }
      if (target.active) {
        report.refused =
          `"${name}" is the active script. Activate another script first, or deactivate ` +
          'all with sieve_activate_script disableAll: true.';
        return report;
      }
      if (name.startsWith(BACKUP_PREFIX)) {
        const originals = new Set(backupOriginals(name));
        const hasCopy = scripts.some(
          (x) =>
            x.name !== name &&
            (x.name.startsWith(BACKUP_PREFIX)
              ? backupOriginals(x.name).some((o) => originals.has(o))
              : originals.has(x.name)),
        );
        if (!hasCopy) {
          report.refused =
            `"${name}" is the only copy of a script that no longer exists. ` +
            'Save it back under its old name with sieve_put_script first if you want to keep it.';
          return report;
        }
      }
      const active = scripts.find((x) => x.active);
      if (active) {
        const activeScan = await this.scan(s, active.name, await s.getScript(active.name), {
          blockGlobalIncludes: false,
        });
        if (activeScan.findings.some((f) => f.action === 'parse')) {
          report.refused =
            `The active script "${active.name}" could not be read, so it cannot be checked ` +
            `for an include of "${name}". Deactivate it first with sieve_activate_script disableAll: true.`;
          return report;
        }
        if (activeScan.includes.some((inc) => !inc.global && inc.name === name)) {
          const includer =
            activeScan.findings.find((f) => f.action === 'include' && f.target === name)?.script ??
            active.name;
          report.refused =
            `"${name}" is included by ${JSON.stringify(includer)}` +
            (includer === active.name
              ? ', the active script'
              : `, which the active script ${JSON.stringify(active.name)} includes`) +
            `, so deleting it would break the active script. Change the active script first, or deactivate all with sieve_activate_script disableAll: true.`;
          return report;
        }
      }
      if (!apply) return report;
      if (!name.startsWith(BACKUP_PREFIX)) {
        report.backup = await this.backup(s, scripts, name, await s.getScript(name));
      }
      await s.deleteScript(name);
      report.applied = true;
      return report;
    });
  }

  // -------------------------------------------------------------------------

  private async backup(
    s: SieveSession,
    scripts: readonly SieveScriptInfo[],
    name: string,
    content: string,
  ): Promise<string> {
    const target = backupName(
      name,
      (this.deps.now ?? (() => new Date()))(),
      new Set(scripts.map((x) => x.name)),
    );
    try {
      await s.putScript(target, content);
    } catch (err) {
      const why = err instanceof SieveCommandError ? s.scrub(err.serverMessage) : String(err);
      throw new Error(`Could not save the backup "${target}", so nothing was changed: ${why}`);
    }
    return target;
  }

  private async scan(
    s: SieveSession,
    name: string,
    content: string,
    options: { blockGlobalIncludes?: boolean } = {},
  ): Promise<SieveScan> {
    let names: Set<string> | undefined;
    const allowlist = await this.currentAllowlist();
    const allowedPrograms = await this.currentPrograms();
    return scanWithIncludes(
      name,
      content,
      allowlist,
      async (included) => {
        if (included === name) return content;
        names ??= new Set((await s.listScripts()).map((x) => x.name));
        // A script that is not listed does not exist. A listed one that cannot be
        // read fails the whole operation: an unchecked include is not allowed.
        return names.has(included) ? s.getScript(included) : null;
      },
      { allowedPrograms, blockGlobalIncludes: options.blockGlobalIncludes },
    );
  }

  private async check(
    account: AccountConfig,
    s: SieveSession,
    name: string,
    content: string,
  ): Promise<CheckReport> {
    const scan = await this.scan(s, name, content);
    const checked = await s.checkScript(content);
    const server: ServerCheck = {
      ...checked,
      message: s.scrub(checked.message),
      warnings: checked.warnings ? s.scrub(checked.warnings) : undefined,
    };
    const folderFindings: SieveFinding[] = [];
    if (scan.fileinto.length > 0) {
      const folders = await this.deps.listFolders(account.name).catch(() => null);
      scan.fileinto.forEach(({ folder, line }) => {
        if (OTHER_NAMESPACE.test(folder)) {
          folderFindings.push({
            severity: 'warn',
            action: 'fileinto',
            line,
            target: folder,
            message: `Files mail into "${folder}", which looks like another user's or a shared folder; the mail would leave your own mailbox`,
          });
        }
        if (folder.includes('${')) {
          folderFindings.push({
            severity: 'warn',
            action: 'fileinto',
            line,
            target: folder,
            message: `Files mail into a folder built from variables (${folder}); it could not be checked`,
          });
        } else if (folders === null) {
          folderFindings.push({
            severity: 'warn',
            action: 'fileinto',
            line,
            target: folder,
            message: `Files mail into "${folder}"; the folder list could not be read to check it exists`,
          });
        } else if (!folderMatches(folder, folders)) {
          folderFindings.push({
            severity: 'warn',
            action: 'fileinto',
            line,
            target: folder,
            message: `Files mail into "${folder}", which does not exist (the server may refuse or fall back to INBOX)`,
          });
        }
      });
    }
    return {
      name,
      server,
      scan,
      folderFindings,
      blocked: scan.blocked || (server.supported && !server.ok),
    };
  }
}
