/**
 * MCP client installation subcommands.
 *
 * Manages registering / unregistering the imap-wizard server with MCP host
 * applications such as Claude Desktop, Claude Code, VS Code, Cursor, Windsurf, Codex and
 * OpenCode.
 *
 * - install          — interactive wizard to register with detected MCP clients
 * - install status   — show which clients are configured
 * - install remove   — interactively unregister from MCP clients
 */

import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
  cancel,
  confirm,
  intro,
  isCancel,
  log,
  multiselect,
  note,
  outro,
  select,
} from '@clack/prompts';
import { parse as parseTOML } from 'smol-toml';

import ensureInteractive from './guard.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Transport helpers
// ---------------------------------------------------------------------------

export type Transport = 'npx' | 'pnpm' | 'global' | 'node';

export interface ServerEntry {
  command: string;
  args: string[];
}

export function buildServerEntry(transport: Transport): ServerEntry {
  switch (transport) {
    case 'npx':
      return { command: 'npx', args: ['-y', 'imap-wizard', 'stdio'] };
    case 'pnpm':
      return { command: 'pnpm', args: ['dlx', 'imap-wizard', 'stdio'] };
    case 'global':
      return { command: 'imap-wizard', args: ['stdio'] };
    case 'node': {
      const mainJs = path.resolve(process.argv[1] ?? 'dist/main.js');
      return { command: process.execPath, args: [mainJs, 'stdio'] };
    }
    default:
      return { command: 'npx', args: ['-y', 'imap-wizard', 'stdio'] };
  }
}

// ---------------------------------------------------------------------------
// File I/O helpers
// ---------------------------------------------------------------------------

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await fs.readFile(filePath, 'utf-8');
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new Error('it is not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (err) {
    if (err instanceof Error && 'code' in err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
      return {};
    }
    throw new Error(
      `Failed to read ${filePath}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

async function writeTextFile(filePath: string, text: string): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  // This is another app's file: write a temp file and rename it, and keep the
  // previous version beside it as <file>.imap-wizard.bak.
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, text, 'utf-8');
    try {
      // Keep the owner's permissions (a config file may be 0600).
      await fs.chmod(tmp, (await fs.stat(filePath)).mode & 0o777);
    } catch {
      // First write: nothing to copy.
    }
    try {
      await fs.copyFile(filePath, `${filePath}.imap-wizard.bak`);
    } catch {
      // First write: nothing to keep.
    }
    await fs.rename(tmp, filePath);
  } catch (err) {
    await fs.rm(tmp, { force: true });
    throw err;
  }
}

async function writeJsonFile(filePath: string, data: Record<string, unknown>): Promise<void> {
  await writeTextFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// Codex config.toml: edit only the [mcp_servers.email] table, as text
// ---------------------------------------------------------------------------

const CODEX_HEADER = /^\s*\[\s*mcp_servers\s*\.\s*(?:email|"email"|'email')\s*\]\s*(?:#.*)?$/;
const ANY_HEADER = /^\s*\[/;

function tomlString(value: string): string {
  // A JSON string is a valid TOML basic string.
  return JSON.stringify(value);
}

function codexBlock(entry: ServerEntry): string[] {
  return [
    '[mcp_servers.email]',
    `command = ${tomlString(entry.command)}`,
    `args = [${entry.args.map(tomlString).join(', ')}]`,
  ];
}

/** [start, end) line range of the email table, without trailing blanks/comments. */
function findCodexRange(lines: string[]): [number, number] | null {
  const start = lines.findIndex((l) => CODEX_HEADER.test(l));
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (ANY_HEADER.test(lines[i] ?? '')) {
      end = i;
      break;
    }
  }
  while (end > start + 1 && /^\s*(#.*)?$/.test(lines[end - 1] ?? '')) end--;
  return [start, end];
}

function codexEmailTable(text: string): Record<string, unknown> | undefined {
  const servers = (parseTOML(text) as Record<string, unknown>).mcp_servers;
  if (typeof servers !== 'object' || servers === null) return undefined;
  const email = (servers as Record<string, unknown>).email;
  return typeof email === 'object' && email !== null
    ? (email as Record<string, unknown>)
    : undefined;
}

/** Returns the new file text. Throws if the result does not read back as asked. */
export function setCodexEntry(text: string, entry: ServerEntry): string {
  parseTOML(text); // refuse to edit a file that is already broken
  const lines = text.split('\n');
  const range = findCodexRange(lines);
  const block = codexBlock(entry);
  if (range) {
    lines.splice(range[0], range[1] - range[0], ...block);
  } else {
    while (lines.length > 0 && lines.at(-1) === '') lines.pop();
    if (lines.length > 0) lines.push('');
    lines.push(...block);
    lines.push('');
  }
  const next = lines.join('\n');
  let landed: Record<string, unknown> | undefined;
  try {
    landed = codexEmailTable(next);
  } catch {
    landed = undefined; // our edit clashed with how the file defines it
  }
  if (
    !landed ||
    landed.command !== entry.command ||
    JSON.stringify(landed.args) !== JSON.stringify(entry.args)
  ) {
    throw new Error(
      'Could not update [mcp_servers.email] safely. Add it to config.toml by hand (see the README).',
    );
  }
  return next;
}

export function removeCodexEntry(text: string): string {
  parseTOML(text);
  const lines = text.split('\n');
  const range = findCodexRange(lines);
  if (!range) return text;
  let [start] = range;
  let [, end] = range;
  // Do not leave two blank lines where the table was.
  if (lines[start - 1] === '' && (lines[end] === '' || end >= lines.length)) start--;
  else if (lines[end] === '' && start === 0) end++;
  lines.splice(start, end - start);
  const next = lines.join('\n');
  if (codexEmailTable(next)) {
    throw new Error(
      'Could not remove [mcp_servers.email] safely. Delete it from config.toml by hand.',
    );
  }
  return next;
}

// ---------------------------------------------------------------------------
// Claude Code: driven through its own CLI, never by editing its files
// ---------------------------------------------------------------------------

async function findOnPath(name: string): Promise<string | null> {
  const dirs = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const exts =
    os.platform() === 'win32'
      ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';').filter(Boolean)
      : [''];
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = path.join(dir, name + ext);
      try {
        // eslint-disable-next-line no-await-in-loop -- stop at the first hit
        const stat = await fs.stat(candidate);
        if (stat.isFile()) return candidate;
      } catch {
        // keep looking
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// MCP client registry
// ---------------------------------------------------------------------------

export interface ClientStatus {
  state: 'missing' | 'unregistered' | 'registered';
  /** The launch command, when registered and readable */
  command?: string;
}

export interface McpClient {
  /** Human-readable name shown in prompts */
  name: string;
  /** Short id used internally */
  id: string;
  /** Where the registration lives (file path, or a note for CLI-driven apps) */
  location: string;
  /** Message for status when the app is not installed */
  missingText: string;
  /** Is the app installed? */
  detect(): Promise<boolean>;
  status(): Promise<ClientStatus>;
  /** Register or update the `email` server */
  write(entry: ServerEntry): Promise<void>;
  /** Unregister the `email` server */
  remove(): Promise<void>;
}

function describeEntry(entry: unknown): string | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined;
  const e = entry as { command?: unknown; args?: unknown };
  if (Array.isArray(e.command)) return e.command.join(' ');
  if (typeof e.command !== 'string') return undefined;
  const args = Array.isArray(e.args) ? e.args.join(' ') : '';
  return `${e.command} ${args}`.trim();
}

interface JsonClientDef {
  name: string;
  id: string;
  configPath: string;
  /** JSON key under which MCP servers live */
  serversKey: string;
  /** Build the stored entry (existing is the old entry, so extra keys survive) */
  toEntry?: (entry: ServerEntry, existing: unknown) => Record<string, unknown>;
}

function jsonClient(def: JsonClientDef): McpClient {
  const serversOf = (cfg: Record<string, unknown>): Record<string, unknown> | undefined => {
    const v = cfg[def.serversKey];
    return typeof v === 'object' && v !== null && !Array.isArray(v)
      ? (v as Record<string, unknown>)
      : undefined;
  };
  return {
    name: def.name,
    id: def.id,
    location: def.configPath,
    missingText: 'config not found',
    detect: async () =>
      (await fileExists(def.configPath)) || (await fileExists(path.dirname(def.configPath))),
    async status() {
      if (!(await fileExists(def.configPath))) return { state: 'missing' };
      const servers = serversOf(await readJsonFile(def.configPath));
      if (!servers || !('email' in servers)) return { state: 'unregistered' };
      return { state: 'registered', command: describeEntry(servers.email) ?? 'unknown' };
    },
    async write(entry) {
      const cfg = await readJsonFile(def.configPath);
      const servers = serversOf(cfg) ?? {};
      servers.email = def.toEntry
        ? def.toEntry(entry, servers.email)
        : { command: entry.command, args: entry.args };
      cfg[def.serversKey] = servers;
      await writeJsonFile(def.configPath, cfg);
    },
    async remove() {
      const cfg = await readJsonFile(def.configPath);
      const servers = serversOf(cfg);
      if (servers && 'email' in servers) {
        delete servers.email;
        if (Object.keys(servers).length === 0) delete cfg[def.serversKey];
      }
      await writeJsonFile(def.configPath, cfg);
    },
  };
}

function codexClient(): McpClient {
  const codexHome = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  const readText = async (): Promise<string> => {
    try {
      return await fs.readFile(configPath, 'utf-8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return '';
      throw err;
    }
  };
  const guarded = async <T>(fn: (text: string) => T): Promise<T> => {
    try {
      return fn(await readText());
    } catch (err) {
      throw new Error(
        `Failed to read ${configPath}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  return {
    name: 'Codex',
    id: 'codex',
    location: configPath,
    missingText: 'config not found',
    detect: async () => (await fileExists(configPath)) || (await fileExists(codexHome)),
    async status() {
      if (!(await fileExists(configPath))) return { state: 'missing' };
      const table = await guarded(codexEmailTable);
      if (!table) return { state: 'unregistered' };
      return { state: 'registered', command: describeEntry(table) ?? 'unknown' };
    },
    async write(entry) {
      const next = await guarded((text) => setCodexEntry(text, entry));
      await writeTextFile(configPath, next);
    },
    async remove() {
      const text = await readText();
      const next = await guarded(removeCodexEntry);
      if (next !== text) await writeTextFile(configPath, next);
    },
  };
}

function claudeCodeClient(): McpClient {
  const run = async (args: string[]): Promise<boolean> => {
    const bin = await findOnPath('claude');
    if (!bin) throw new Error('The claude command was not found on PATH.');
    try {
      await execFileAsync(bin, args, { timeout: 30_000, windowsHide: true });
      return true;
    } catch (err) {
      const code = (err as { code?: unknown }).code;
      if (typeof code === 'number') return false; // ran, exited non-zero
      throw new Error(
        `claude ${args.slice(0, 2).join(' ')} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };
  return {
    name: 'Claude Code',
    id: 'claude-code',
    location: 'claude mcp (user scope)',
    missingText: 'claude command not found',
    detect: async () => (await findOnPath('claude')) !== null,
    async status() {
      if ((await findOnPath('claude')) === null) return { state: 'missing' };
      return (await run(['mcp', 'get', 'email']))
        ? { state: 'registered' }
        : { state: 'unregistered' };
    },
    async write(entry) {
      // `add` refuses a name that already exists, so clear any old one first.
      await run(['mcp', 'remove', '--scope', 'user', 'email']);
      const ok = await run([
        'mcp',
        'add',
        '--scope',
        'user',
        'email',
        '--',
        entry.command,
        ...entry.args,
      ]);
      if (!ok) throw new Error('claude mcp add failed. Run it by hand to see why.');
    },
    async remove() {
      const ok = await run(['mcp', 'remove', '--scope', 'user', 'email']);
      if (!ok) throw new Error('claude mcp remove failed. Run it by hand to see why.');
    },
  };
}

export function getClients(): McpClient[] {
  const platform = os.platform();
  const home = os.homedir();
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');

  const clients: McpClient[] = [];

  // Claude Desktop
  let desktopDir = path.join(xdgConfig, 'Claude');
  if (platform === 'darwin')
    desktopDir = path.join(home, 'Library', 'Application Support', 'Claude');
  else if (platform === 'win32') desktopDir = path.join(appData, 'Claude');
  clients.push(
    jsonClient({
      name: 'Claude Desktop',
      id: 'claude',
      configPath: path.join(desktopDir, 'claude_desktop_config.json'),
      serversKey: 'mcpServers',
    }),
  );

  clients.push(claudeCodeClient());

  // Cursor — ~/.cursor/mcp.json (all platforms)
  clients.push(
    jsonClient({
      name: 'Cursor',
      id: 'cursor',
      configPath: path.join(home, '.cursor', 'mcp.json'),
      serversKey: 'mcpServers',
    }),
  );

  // Windsurf / Codeium — ~/.codeium/windsurf/mcp_config.json
  clients.push(
    jsonClient({
      name: 'Windsurf',
      id: 'windsurf',
      configPath: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
      serversKey: 'mcpServers',
    }),
  );

  // VS Code (GitHub Copilot) — user-level mcp.json, top-level "servers" key
  let codeUser = path.join(xdgConfig, 'Code', 'User');
  if (platform === 'darwin')
    codeUser = path.join(home, 'Library', 'Application Support', 'Code', 'User');
  else if (platform === 'win32') codeUser = path.join(appData, 'Code', 'User');
  clients.push(
    jsonClient({
      name: 'VS Code',
      id: 'vscode',
      configPath: path.join(codeUser, 'mcp.json'),
      serversKey: 'servers',
      toEntry: (entry, existing) => ({
        ...(typeof existing === 'object' && existing !== null ? existing : {}),
        type: 'stdio',
        command: entry.command,
        args: entry.args,
      }),
    }),
  );

  clients.push(codexClient());

  // OpenCode — ~/.config/opencode/opencode.json
  clients.push(
    jsonClient({
      name: 'OpenCode',
      id: 'opencode',
      configPath: path.join(xdgConfig, 'opencode', 'opencode.json'),
      serversKey: 'mcp',
      toEntry: (entry, existing) => ({
        // Keep what the owner added by hand, such as a longer timeout.
        ...(typeof existing === 'object' && existing !== null ? existing : {}),
        type: 'local',
        command: [entry.command, ...entry.args],
        enabled: true,
      }),
    }),
  );

  return clients;
}

const SUPPORTED_NAMES = 'Claude Desktop, Claude Code, Cursor, Windsurf, VS Code, Codex, OpenCode';

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

export async function runInstall(): Promise<void> {
  ensureInteractive();
  intro('imap-wizard › Install MCP Server');

  const clients = getClients();

  // Detect which clients exist on the system (parallel checks)
  const detected = await Promise.all(
    clients.map(async (client) => {
      if (!(await client.detect())) return { client, found: false, registered: false };
      // Asking Claude Code costs a process start; it can only fail soft here.
      const st = await client.status().catch((): ClientStatus => ({ state: 'unregistered' }));
      return { client, found: true, registered: st.state === 'registered' };
    }),
  );

  const available = detected.filter((c) => c.found);
  if (available.length === 0) {
    log.warn('No supported MCP clients detected on this system.');
    log.info(`Supported clients: ${SUPPORTED_NAMES}`);
    note(
      JSON.stringify({ mcpServers: { email: buildServerEntry('npx') } }, null, 2),
      'Manual configuration — add this to your MCP client config',
    );
    outro('Done.');
    return;
  }

  // Show detected clients
  const alreadyDone = available.filter((c) => c.registered);
  if (alreadyDone.length > 0) {
    log.info(`Already configured: ${alreadyDone.map((c) => c.client.name).join(', ')}`);
  }

  // Let user pick which clients to install
  const choices = available.map((c) => ({
    value: c.client.id,
    label: c.client.name,
    hint: c.registered ? 'already configured — will update' : undefined,
  }));

  const selectedIds = await multiselect({
    message: 'Which MCP clients should imap-wizard be registered with?',
    options: choices,
    initialValues: available.filter((c) => !c.registered).map((c) => c.client.id),
    required: true,
  });
  if (isCancel(selectedIds)) {
    cancel('Cancelled.');
    return;
  }

  // Ask for transport preference
  const transport = await select<Transport>({
    message: 'How should the MCP client launch imap-wizard?',
    options: [
      {
        value: 'npx' as Transport,
        label: 'npx (auto-downloads, always latest)',
        hint: 'recommended for most users',
      },
      {
        value: 'pnpm' as Transport,
        label: 'pnpm dlx (auto-downloads via pnpm)',
      },
      {
        value: 'global' as Transport,
        label: 'Global install (imap-wizard on PATH)',
        hint: 'requires: npm i -g imap-wizard',
      },
      {
        value: 'node' as Transport,
        label: 'Direct node (current dist/main.js)',
        hint: 'dev / local clone',
      },
    ],
  });
  if (isCancel(transport)) {
    cancel('Cancelled.');
    return;
  }

  const serverEntry = buildServerEntry(transport);
  const selected = available.filter((c) => selectedIds.includes(c.client.id));

  // Write to each selected client (sequential — each read-modify-write must complete)
  await selected.reduce(async (prev, { client }) => {
    await prev;
    await client.write(serverEntry);
    log.success(`${client.name} — registered (${client.location})`);
  }, Promise.resolve());

  // Show what was written
  note(
    JSON.stringify({ mcpServers: { email: serverEntry } }, null, 2),
    'Launch command written to selected clients',
  );

  // Restart hint
  const clientNames = selected.map((c) => c.client.name).join(', ');
  log.info(`Restart ${clientNames} for the changes to take effect.`);
  outro('Installation complete!');
}

async function runRemove(): Promise<void> {
  ensureInteractive();
  intro('imap-wizard › Remove MCP Server');

  const clients = getClients();

  // Find clients that have imap-wizard registered (parallel checks)
  const withStatus = await Promise.all(
    clients.map(async (client) => {
      const st = await client.status();
      return { client, registered: st.state === 'registered' };
    }),
  );
  const registered = withStatus.filter((c) => c.registered).map((c) => c.client);

  if (registered.length === 0) {
    log.info('imap-wizard is not registered with any detected MCP clients.');
    outro('Nothing to remove.');
    return;
  }

  const selectedIds = await multiselect({
    message: 'Unregister imap-wizard from which clients?',
    options: registered.map((c) => ({
      value: c.id,
      label: c.name,
      hint: c.location,
    })),
    initialValues: registered.map((c) => c.id),
    required: true,
  });
  if (isCancel(selectedIds)) {
    cancel('Cancelled.');
    return;
  }

  const shouldRemove = await confirm({
    message: `Remove imap-wizard from ${selectedIds.length} client(s)?`,
    initialValue: false,
  });
  if (isCancel(shouldRemove) || !shouldRemove) {
    cancel('Cancelled.');
    return;
  }

  const selected = registered.filter((c) => selectedIds.includes(c.id));

  // Sequential removal — each client's config must be read, modified, written
  await selected.reduce(async (prev, client) => {
    await prev;
    await client.remove();
    log.success(`${client.name} — unregistered`);
  }, Promise.resolve());

  const clientNames = selected.map((c) => c.name).join(', ');
  log.info(`Restart ${clientNames} for the changes to take effect.`);
  outro('Removal complete.');
}

async function runStatus(): Promise<void> {
  const clients = getClients();

  console.log('MCP Client Installation Status\n');

  const results = await Promise.all(
    clients.map(async (client) => ({ client, st: await client.status() })),
  );

  for (const { client, st } of results) {
    if (st.state === 'missing') {
      console.log(`  ❌ ${client.name} — ${client.missingText}`); // eslint-disable-line no-restricted-syntax
    } else if (st.state === 'registered') {
      const cmd = st.command ? ` (${st.command})` : '';
      console.log(`  ✅ ${client.name} — registered${cmd}\n     ${client.location}`); // eslint-disable-line no-restricted-syntax
    } else {
      console.log(`  ⚠️  ${client.name} — not registered\n     ${client.location}`); // eslint-disable-line no-restricted-syntax
    }
  }

  if (results.every((r) => r.st.state === 'missing')) {
    console.log('\n  No supported MCP clients detected.');
    console.log(`  Supported: ${SUPPORTED_NAMES}`);
  }
}

// ---------------------------------------------------------------------------
// Usage & router
// ---------------------------------------------------------------------------

function printUsage(): void {
  console.log(`Usage: imap-wizard install [subcommand]

Subcommands:
  (default)   Register imap-wizard with detected MCP clients
  status      Show registration status for all detected clients
  remove      Unregister imap-wizard from MCP clients
`);
}

export default async function runInstallCommand(subcommand?: string): Promise<void> {
  switch (subcommand) {
    case undefined:
    case 'add':
      await runInstall();
      break;
    case 'status':
      await runStatus();
      break;
    case 'remove':
    case 'uninstall':
      await runRemove();
      break;
    case 'help':
    case '--help':
      printUsage();
      break;
    default:
      console.error(`Unknown install command: ${subcommand}\n`);
      printUsage();
  }
}
