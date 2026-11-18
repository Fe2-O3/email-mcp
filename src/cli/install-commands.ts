/**
 * MCP client installation subcommands.
 *
 * Manages registering / unregistering the imap-wizard server with MCP host
 * applications such as Claude Desktop, VS Code, Cursor, and Windsurf.
 *
 * - install          — interactive wizard to register with detected MCP clients
 * - install status   — show which clients are configured
 * - install remove   — interactively unregister from MCP clients
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

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

import ensureInteractive from './guard.js';

// ---------------------------------------------------------------------------
// MCP client registry
// ---------------------------------------------------------------------------

interface McpClientDef {
  /** Human-readable name shown in prompts */
  name: string;
  /** Short id used internally */
  id: string;
  /** Absolute path to the JSON config file for this client */
  configPath: string;
  /** JSON key under which MCP servers live */
  serversKey: string;
}

function getClients(): McpClientDef[] {
  const platform = os.platform();
  const home = os.homedir();

  const clients: McpClientDef[] = [];

  if (platform === 'darwin') {
    clients.push({
      name: 'Claude Desktop',
      id: 'claude',
      configPath: path.join(
        home,
        'Library',
        'Application Support',
        'Claude',
        'claude_desktop_config.json',
      ),
      serversKey: 'mcpServers',
    });
  } else if (platform === 'linux') {
    clients.push({
      name: 'Claude Desktop',
      id: 'claude',
      configPath: path.join(
        process.env.XDG_CONFIG_HOME ?? path.join(home, '.config'),
        'Claude',
        'claude_desktop_config.json',
      ),
      serversKey: 'mcpServers',
    });
  } else if (platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(home, 'AppData', 'Roaming');
    clients.push({
      name: 'Claude Desktop',
      id: 'claude',
      configPath: path.join(appData, 'Claude', 'claude_desktop_config.json'),
      serversKey: 'mcpServers',
    });
  }

  // Cursor — ~/.cursor/mcp.json (all platforms)
  clients.push({
    name: 'Cursor',
    id: 'cursor',
    configPath: path.join(home, '.cursor', 'mcp.json'),
    serversKey: 'mcpServers',
  });

  // Windsurf / Codeium — ~/.codeium/windsurf/mcp_config.json
  clients.push({
    name: 'Windsurf',
    id: 'windsurf',
    configPath: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'),
    serversKey: 'mcpServers',
  });

  return clients;
}

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

async function writeJsonFile(filePath: string, data: Record<string, unknown>): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  // This is another app's file: write a temp file and rename it, and keep the
  // previous version beside it as <file>.imap-wizard.bak.
  const tmp = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  try {
    await fs.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf-8');
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

function isRegistered(config: Record<string, unknown>, serversKey: string): boolean {
  const servers = config[serversKey] as Record<string, unknown> | undefined;
  return servers != null && 'email' in servers;
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function runInstall(): Promise<void> {
  ensureInteractive();
  intro('imap-wizard › Install MCP Server');

  const clients = getClients();

  // Detect which clients exist on the system (parallel checks)
  const detected = await Promise.all(
    clients.map(async (client) => {
      const exists = await fileExists(client.configPath);
      const dirExists = await fileExists(path.dirname(client.configPath));
      let registered = false;
      if (exists) {
        const cfg = await readJsonFile(client.configPath);
        registered = isRegistered(cfg, client.serversKey);
      }
      return { ...client, exists: exists || dirExists, registered };
    }),
  );

  const available = detected.filter((c) => c.exists);
  if (available.length === 0) {
    log.warn('No supported MCP clients detected on this system.');
    log.info('Supported clients: Claude Desktop, Cursor, Windsurf');
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
    log.info(`Already configured: ${alreadyDone.map((c) => c.name).join(', ')}`);
  }

  // Let user pick which clients to install
  const choices = available.map((c) => ({
    value: c.id,
    label: c.name,
    hint: c.registered ? 'already configured — will update' : undefined,
  }));

  const selectedIds = await multiselect({
    message: 'Which MCP clients should imap-wizard be registered with?',
    options: choices,
    initialValues: available.filter((c) => !c.registered).map((c) => c.id),
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
  const selected = available.filter((c) => selectedIds.includes(c.id));

  // Write to each selected client (sequential — each read-modify-write must complete)
  await selected.reduce(async (prev, client) => {
    await prev;
    const existing = await readJsonFile(client.configPath);
    const servers = (existing[client.serversKey] as Record<string, unknown>) ?? {};
    servers.email = serverEntry;
    existing[client.serversKey] = servers;

    await writeJsonFile(client.configPath, existing);
    log.success(`${client.name} — registered (${client.configPath})`);
  }, Promise.resolve());

  // Show what was written
  note(
    JSON.stringify({ mcpServers: { email: serverEntry } }, null, 2),
    'Server entry written to selected clients',
  );

  // Restart hint
  const clientNames = selected.map((c) => c.name).join(', ');
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
      const exists = await fileExists(client.configPath);
      if (!exists) return { ...client, registered: false };
      const cfg = await readJsonFile(client.configPath);
      return { ...client, registered: isRegistered(cfg, client.serversKey) };
    }),
  );
  const registered = withStatus.filter((c) => c.registered);

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
      hint: c.configPath,
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
    const cfg = await readJsonFile(client.configPath);
    const servers = cfg[client.serversKey] as Record<string, unknown> | undefined;
    if (servers && 'email' in servers) {
      delete servers.email;
      if (Object.keys(servers).length === 0) {
        delete cfg[client.serversKey];
      }
    }
    await writeJsonFile(client.configPath, cfg);
    log.success(`${client.name} — unregistered`);
  }, Promise.resolve());

  const clientNames = selected.map((c) => c.name).join(', ');
  log.info(`Restart ${clientNames} for the changes to take effect.`);
  outro('Removal complete.');
}

async function runStatus(): Promise<void> {
  const clients = getClients();

  console.log('MCP Client Installation Status\n');

  const lines = await Promise.all(
    clients.map(async (client) => {
      const exists = await fileExists(client.configPath);
      if (!exists) {
        return `  ❌ ${client.name} — config not found`;
      }

      const cfg = await readJsonFile(client.configPath);
      if (isRegistered(cfg, client.serversKey)) {
        const servers = cfg[client.serversKey] as Record<string, unknown>;
        const entry = servers.email as ServerEntry | undefined;
        const cmd = entry?.command
          ? `${entry.command} ${(Array.isArray(entry.args) ? entry.args : []).join(' ')}`.trim()
          : 'unknown';
        return `  ✅ ${client.name} — registered (${cmd})\n     ${client.configPath}`;
      }

      return `  ⚠️  ${client.name} — not registered\n     ${client.configPath}`;
    }),
  );

  const anyFound = lines.some((l) => !l.includes('config not found'));
  for (const line of lines) console.log(line); // eslint-disable-line no-restricted-syntax

  if (!anyFound) {
    console.log('\n  No supported MCP clients detected.');
    console.log('  Supported: Claude Desktop, Cursor, Windsurf');
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
