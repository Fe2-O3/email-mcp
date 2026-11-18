// Adapted from Mailoo (https://github.com/Bitfloo/mailoo, commit f537225), Copyright (c) 2026 Bitfloo, LGPL-3.0-or-later.
/**
 * Locks the public MCP surface: every tool, prompt and resource this server
 * registers, with the schemas a client builds calls from.
 *
 * Tool names, input/output schemas, prompt arguments and resource URIs are
 * public API (see CLAUDE.md): renaming one or changing its schema breaks
 * clients, so it needs a major version bump. This test fails on any such
 * change until the baseline is regenerated on purpose:
 *
 *   UPDATE_MCP_BASELINE=1 pnpm vitest run src/mcp-catalog.test.ts && pnpm format
 *
 * Descriptions and titles are deliberately not locked: they are prose, not contract.
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/server';

import registerAllPrompts from './prompts/register.js';
import registerAllResources from './resources/register.js';
import createServer from './server.js';
import registerAllTools from './tools/register.js';
import type { AppConfig, Toolset } from './types/index.js';

const baselinePath = join(dirname(fileURLToPath(import.meta.url)), 'mcp-catalog.baseline.json');

interface Catalog {
  tools: { name: string; inputSchema: unknown; outputSchema: unknown }[];
  prompts: { name: string; arguments: unknown }[];
  resources: { name: string; uri: string | null; uriTemplate: string | null }[];
}

type Mode = 'full' | 'readOnly' | 'core' | 'minimal';
type Baseline = Record<Mode, Catalog>;

/** Stands in for any service: every property is a function that returns an empty list. */
function serviceStub(): unknown {
  return new Proxy({}, { get: () => () => [] });
}

function configFor(readOnly: boolean, toolset: Toolset): AppConfig {
  return {
    settings: {
      rateLimit: 10,
      send: { maxAttachmentMb: 25 },
      // On, so the opt-in verification tool is part of the locked surface.
      verification: { enabled: true, includeMagicLinks: false },
      idleExit: 0,
      readOnly,
      toolset,
      cache: {
        enabled: false,
        mailboxes: [],
        windowDays: 0,
        readThrough: false,
        offlineReads: true,
        bodyMaxMb: 200,
        bodyMessages: 0,
        maxSizeMb: 1,
        syncInterval: 30,
      },
      watcher: { enabled: false, folders: ['INBOX'], idleTimeout: 1740 },
      hooks: {
        onNewEmail: 'notify',
        preset: 'priority-focus',
        autoLabel: false,
        autoFlag: false,
        batchDelay: 5,
        rules: [],
        alerts: {
          desktop: false,
          sound: false,
          urgencyThreshold: 'high',
          webhookUrl: '',
          webhookEvents: ['urgent', 'high'],
        },
      },
    },
    accounts: [],
  } as unknown as AppConfig;
}

/** Recursively sorts object keys so the baseline does not depend on property order. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, child]) => [key, canonical(child)]),
    );
  }
  return value;
}

const byName = (a: { name: string }, b: { name: string }): number =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

async function collect(readOnly: boolean, toolset: Toolset = 'full'): Promise<Catalog> {
  const server = createServer();
  const stub = serviceStub() as never;
  const connections = { getAccountNames: () => [], getAccount: () => undefined } as never;
  registerAllTools(
    server,
    connections,
    stub,
    stub,
    configFor(readOnly, toolset),
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
  );
  registerAllResources(server, connections, stub, stub, stub);
  registerAllPrompts(server);

  const client = new Client({ name: 'mcp-catalog-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport as never),
    server.connect(serverTransport as never),
  ]);
  try {
    const tools = await client.listTools();
    const prompts = await client.listPrompts();
    const resources = await client.listResources();
    const templates = await client.listResourceTemplates();
    if (tools.nextCursor || prompts.nextCursor || resources.nextCursor || templates.nextCursor) {
      throw new Error('catalog listing paginated; the test would drop a page');
    }
    return canonical({
      tools: tools.tools
        .map((tool) => ({
          name: tool.name,
          inputSchema: tool.inputSchema,
          outputSchema: tool.outputSchema ?? null,
        }))
        .sort(byName),
      prompts: prompts.prompts
        .map((prompt) => ({ name: prompt.name, arguments: prompt.arguments ?? null }))
        .sort(byName),
      resources: [
        ...resources.resources.map((r) => ({ name: r.name, uri: r.uri, uriTemplate: null })),
        ...templates.resourceTemplates.map((r) => ({
          name: r.name,
          uri: null,
          uriTemplate: r.uriTemplate,
        })),
      ].sort(byName),
    }) as Catalog;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

function describeChanges(baseline: Catalog, live: Catalog): string[] {
  const lines: string[] = [];
  (['tools', 'prompts', 'resources'] as const).forEach((kind) => {
    const before = new Map<string, unknown>(baseline[kind].map((item) => [item.name, item]));
    const after = new Map<string, unknown>(live[kind].map((item) => [item.name, item]));
    before.forEach((item, name) => {
      if (!after.has(name)) lines.push(`${kind}: removed "${name}"`);
      else if (JSON.stringify(item) !== JSON.stringify(after.get(name))) {
        lines.push(`${kind}: changed "${name}"`);
      }
    });
    after.forEach((_item, name) => {
      if (!before.has(name)) lines.push(`${kind}: added "${name}"`);
    });
  });
  return lines;
}

const REMINDER =
  'Tool names, input/output schemas, prompt arguments and resource URIs are public API. ' +
  'Renaming or changing one is a breaking change and needs a major version bump (see CLAUDE.md). ' +
  'If the change is intended, regenerate the baseline with: ' +
  'UPDATE_MCP_BASELINE=1 pnpm vitest run src/mcp-catalog.test.ts && pnpm format';

describe('MCP catalog baseline', () => {
  let live: Baseline;

  beforeAll(async () => {
    live = {
      full: await collect(false),
      readOnly: await collect(true),
      core: await collect(false, 'core'),
      minimal: await collect(false, 'minimal'),
    };
    if (process.env.UPDATE_MCP_BASELINE === '1') {
      writeFileSync(baselinePath, `${JSON.stringify(live, null, 2)}\n`);
    }
  });

  it('should have a committed baseline', () => {
    expect(existsSync(baselinePath), `${baselinePath} is missing. ${REMINDER}`).toBe(true);
  });

  it.each(['full', 'readOnly', 'core', 'minimal'] as const)(
    'should match the %s-mode baseline',
    (mode) => {
      const baseline = JSON.parse(readFileSync(baselinePath, 'utf8')) as Baseline;
      const changes = describeChanges(baseline[mode], live[mode]);
      expect(
        live[mode],
        `The ${mode}-mode MCP catalog changed:\n  ${changes.join('\n  ') || '(schema detail)'}\n${REMINDER}`,
      ).toEqual(baseline[mode]);
    },
  );

  it('should register no write tool in read-only mode', () => {
    const full = new Set(live.full.tools.map((tool) => tool.name));
    const readOnly = live.readOnly.tools.map((tool) => tool.name);
    expect(readOnly.every((name) => full.has(name))).toBe(true);
    expect(readOnly.length).toBeLessThan(full.size);
  });
});
