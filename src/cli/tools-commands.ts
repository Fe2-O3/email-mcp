/**
 * Choose which tools the AI gets, by ticking groups.
 *
 * - tools              — tick boxes (interactive)
 * - tools show         — what is on now
 * - tools set a,b,c    — set the groups without prompts (scripts, CI)
 * - tools reset        — drop the choice; the toolset preset decides again
 */

import { cancel, intro, isCancel, log, multiselect, outro } from '@clack/prompts';

import {
  CONFIG_FILE,
  configExists,
  loadRawConfig,
  setToolGroupsInConfig,
} from '../config/loader.js';
import type { RawAppConfig } from '../config/schema.js';
import {
  CORE_TOOLS,
  MINIMAL_TOOLS,
  normalizeToolGroups,
  TOOL_GROUP_NAMES,
  TOOL_GROUPS,
} from '../tools/toolsets.js';
import type { ToolGroup } from '../types/index.js';
import ensureInteractive from './guard.js';

const TOTAL_TOOLS = TOOL_GROUP_NAMES.reduce((n, g) => n + TOOL_GROUPS[g].tools.length, 0);

function printToolsUsage(): void {
  console.log(`Usage: imap-wizard tools [subcommand]

Pick what your AI can do. Each box turns on a group of tools.

Subcommands:
  (none)          Tick boxes to choose groups
  show            Show what is on now
  set <groups>    Set groups without prompts, comma-separated
                  (${TOOL_GROUP_NAMES.join(', ')})
  reset           Drop the choice and go back to the toolset preset

Restart your AI app after a change so it sees the new tool list.
`);
}

/** Tool count for a set of groups ("read" always included). */
export function countTools(groups: readonly ToolGroup[]): number {
  return normalizeToolGroups(groups).reduce((n, g) => n + TOOL_GROUPS[g].tools.length, 0);
}

/** Options for the tick boxes, shared with the setup wizard. */
export function toolGroupOptions(): { value: ToolGroup; label: string; hint: string }[] {
  return TOOL_GROUP_NAMES.map((g) => ({
    value: g,
    label: TOOL_GROUPS[g].label,
    hint:
      g === 'read'
        ? `${TOOL_GROUPS[g].hint} (always on)`
        : `${TOOL_GROUPS[g].hint}, ${TOOL_GROUPS[g].tools.length} tools`,
  }));
}

/** Parse "read, send" into groups. Throws on an unknown name. */
export function parseGroupList(input: string): ToolGroup[] {
  const names = input
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const bad = names.filter((n) => !(TOOL_GROUP_NAMES as string[]).includes(n));
  if (bad.length > 0) {
    throw new Error(
      `Unknown tool group: ${bad.join(', ')}. Choose from: ${TOOL_GROUP_NAMES.join(', ')}.`,
    );
  }
  return normalizeToolGroups(names as ToolGroup[]);
}

/** One line on what the current settings turn on. */
export function describeChoice(settings: RawAppConfig['settings']): string {
  if (settings.tools) {
    const groups = normalizeToolGroups(settings.tools);
    const labels = groups.map((g) => TOOL_GROUPS[g].label.toLowerCase());
    return `${labels.join(', ')} (${countTools(groups)} of ${TOTAL_TOOLS} tools)`;
  }
  const count =
    settings.toolset === 'minimal'
      ? MINIMAL_TOOLS.length
      : settings.toolset === 'core'
        ? CORE_TOOLS.length
        : TOTAL_TOOLS;
  return `the "${settings.toolset}" preset (${count} of ${TOTAL_TOOLS} tools)`;
}

async function loadExisting(): Promise<RawAppConfig> {
  if (!(await configExists())) {
    throw new Error(`No config file at ${CONFIG_FILE}. Run 'imap-wizard setup' first.`);
  }
  return loadRawConfig();
}

function readOnlyNote(config: RawAppConfig): void {
  if (config.settings.read_only) {
    log.warning('Read-only mode is on, so tools that change mail stay hidden anyway.');
  }
}

async function showTools(): Promise<void> {
  const config = await loadExisting();
  const on = new Set<ToolGroup>(
    config.settings.tools ? normalizeToolGroups(config.settings.tools) : [],
  );
  console.log(`Your AI can use: ${describeChoice(config.settings)}\n`);
  if (config.settings.tools) {
    for (const g of TOOL_GROUP_NAMES) {
      console.log(`  [${on.has(g) ? 'x' : ' '}] ${TOOL_GROUPS[g].label}`);
    }
    console.log('');
  }
  if (config.settings.read_only) {
    console.log('Read-only mode is on: tools that change mail are hidden.\n');
  }
}

async function setTools(groups: ToolGroup[]): Promise<void> {
  const config = await loadExisting();
  await setToolGroupsInConfig(groups);
  console.log(`Saved. Your AI can use: ${describeChoice({ ...config.settings, tools: groups })}`);
  console.log('Restart your AI app to load the new tool list.');
}

async function resetTools(): Promise<void> {
  const config = await loadExisting();
  await setToolGroupsInConfig(null);
  const { tools: _dropped, ...rest } = config.settings;
  console.log(`Saved. Your AI can use: ${describeChoice(rest)}`);
  console.log('Restart your AI app to load the new tool list.');
}

async function pickTools(): Promise<void> {
  ensureInteractive();
  intro('imap-wizard tools');
  const config = await loadExisting();
  log.info(`Now on: ${describeChoice(config.settings)}`);

  const current = config.settings.tools
    ? normalizeToolGroups(config.settings.tools)
    : config.settings.toolset === 'full'
      ? [...TOOL_GROUP_NAMES]
      : (['read', 'send'] as ToolGroup[]);
  const picked = await multiselect<ToolGroup>({
    message: 'What should your AI be able to do? (space to tick, enter to save)',
    options: toolGroupOptions(),
    initialValues: current,
    required: false,
  });
  if (isCancel(picked)) {
    cancel('Nothing was changed.');
    return;
  }
  const groups = normalizeToolGroups(picked);
  if (!picked.includes('read')) log.info('Read mail stays on: the other groups need it.');
  await setToolGroupsInConfig(groups);
  readOnlyNote(config);
  outro(
    `Saved. Your AI can now: ${describeChoice({ ...config.settings, tools: groups })}. Restart your AI app to load it.`,
  );
}

export default async function runToolsCommand(subcommand?: string, arg?: string): Promise<void> {
  switch (subcommand) {
    case undefined:
      await pickTools();
      break;
    case 'show':
      await showTools();
      break;
    case 'set':
      if (!arg) throw new Error('Name the groups, for example: imap-wizard tools set read,send');
      await setTools(parseGroupList(arg));
      break;
    case 'reset':
      await resetTools();
      break;
    case 'help':
    case '--help':
    case '-h':
      printToolsUsage();
      break;
    default:
      printToolsUsage();
      throw new Error(`Unknown tools subcommand: ${subcommand}`);
  }
}
