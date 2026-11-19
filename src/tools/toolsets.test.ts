import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/server';

import { AppConfigFileSchema, SettingsSchema } from '../config/schema.js';
import createServer from '../server.js';
import type { AppConfig, ToolGroup, Toolset } from '../types/index.js';
import registerAllTools from './register.js';
import {
  CORE_TOOLS,
  DEFAULT_TOOL_GROUPS,
  MINIMAL_TOOLS,
  normalizeToolGroups,
  TOOL_GROUP_NAMES,
  TOOL_GROUPS,
} from './toolsets.js';

function configFor(
  readOnly: boolean,
  toolset: Toolset,
  tools?: ToolGroup[],
  codes = false,
): AppConfig {
  return {
    settings: {
      readOnly,
      toolset,
      ...(tools ? { tools } : {}),
      verification: { enabled: codes, includeMagicLinks: false },
    },
    accounts: [],
  } as unknown as AppConfig;
}

async function toolNames(
  readOnly: boolean,
  toolset: Toolset,
  tools?: ToolGroup[],
  codes = false,
): Promise<string[]> {
  return (await listTools(readOnly, toolset, tools, codes)).map((tool) => tool.name).sort();
}

async function listTools(
  readOnly: boolean,
  toolset: Toolset,
  tools?: ToolGroup[],
  codes = false,
): Promise<{ name: string; inputSchema: { properties?: Record<string, unknown> } }[]> {
  const server = createServer();
  const stub = new Proxy({}, { get: () => () => [] }) as never;
  registerAllTools(
    server,
    { getAccountNames: () => [] } as never,
    stub,
    stub,
    configFor(readOnly, toolset, tools, codes),
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
  );
  const client = new Client({ name: 'toolset-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport as never),
    server.connect(serverTransport as never),
  ]);
  try {
    return (await client.listTools()).tools as never;
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

describe('toolset registration', () => {
  it('registers exactly the minimal list in minimal mode', async () => {
    expect(await toolNames(false, 'minimal')).toEqual([...MINIMAL_TOOLS].sort());
  });

  it('registers exactly the core list in core mode', async () => {
    expect(await toolNames(false, 'core')).toEqual([...CORE_TOOLS].sort());
  });

  it('nests minimal inside core inside full', async () => {
    const minimal = await toolNames(false, 'minimal');
    const core = await toolNames(false, 'core');
    const full = await toolNames(false, 'full');
    expect(minimal.length).toBeLessThan(core.length);
    expect(core.length).toBeLessThan(full.length);
    expect(minimal.every((name) => core.includes(name))).toBe(true);
    expect(core.every((name) => full.includes(name))).toBe(true);
  });

  it.each(['minimal', 'core', 'full'] as const)(
    'read_only keeps only the read tools of the %s toolset',
    async (toolset) => {
      const writable = await toolNames(false, toolset);
      const readOnly = await toolNames(true, toolset);
      expect(readOnly.every((name) => writable.includes(name))).toBe(true);
      expect(readOnly.length).toBeLessThan(writable.length);
      ['send_email', 'reply_email', 'delete_email', 'mark_email', 'save_draft'].forEach((name) => {
        expect(readOnly).not.toContain(name);
      });
    },
  );

  it('hides the calendar and reminder write tools in read_only mode', async () => {
    const writable = await toolNames(false, 'full');
    const readOnly = await toolNames(true, 'full');
    ['add_to_calendar', 'create_reminder'].forEach((name) => {
      expect(writable).toContain(name);
      expect(readOnly).not.toContain(name);
    });
    expect(readOnly).toContain('list_events');
  });

  it('keeps only the read tools of minimal mode when read-only', async () => {
    expect(await toolNames(true, 'minimal')).toEqual([
      'get_email',
      'get_thread',
      'list_accounts',
      'list_emails',
      'list_mailboxes',
      'search_emails',
    ]);
  });
});

describe('toolset setting', () => {
  it('defaults to full', () => {
    expect(SettingsSchema.parse({}).toolset).toBe('full');
  });

  it.each(['full', 'core', 'minimal'])('accepts %s', (value) => {
    expect(SettingsSchema.parse({ toolset: value }).toolset).toBe(value);
  });

  it('rejects an unknown value', () => {
    expect(() => SettingsSchema.parse({ toolset: 'everything' })).toThrow();
    expect(
      AppConfigFileSchema.safeParse({
        settings: { toolset: 'tiny' },
        accounts: [],
      }).success,
    ).toBe(false);
  });
});

describe('tool groups', () => {
  const groupTools = (groups: ToolGroup[]) =>
    groups.flatMap((g) => [...TOOL_GROUPS[g].tools]).sort();

  it('puts every registered tool in exactly one group', async () => {
    // A new tool that no group names would silently vanish for anyone using
    // the tools setting. This catches it. Codes on, so every tool registers.
    const full = await toolNames(false, 'full', undefined, true);
    const grouped = groupTools(TOOL_GROUP_NAMES);
    expect(grouped).toEqual(full);
    expect(new Set(grouped).size).toBe(grouped.length);
  });

  it('registers exactly the ticked groups, plus read', async () => {
    expect(await toolNames(false, 'full', ['send'])).toEqual(groupTools(['read', 'send']));
    expect(await toolNames(false, 'full', ['tidy', 'alerts'])).toEqual(
      groupTools(['read', 'tidy', 'alerts']),
    );
  });

  it('starts new setups careful: read, drafts, tidy up, calendar', () => {
    expect(DEFAULT_TOOL_GROUPS).toEqual(['read', 'drafts', 'tidy', 'calendar']);
  });

  it('lists every risky feature as a box that starts off', () => {
    for (const g of ['send', 'delete', 'rules', 'codes'] as ToolGroup[]) {
      expect(TOOL_GROUP_NAMES).toContain(g);
      expect(TOOL_GROUPS[g].on).toBe(false);
    }
  });

  it('turns the sign-in code catcher on with its box, even when the setting is off', async () => {
    expect(await toolNames(false, 'full', ['codes'])).toContain('get_verification_code');
  });

  it('keeps the code catcher off without its box, even when the setting is on', async () => {
    expect(await toolNames(false, 'full', ['send'], true)).not.toContain('get_verification_code');
  });

  it('without a box list, the old setting still decides the code catcher', async () => {
    expect(await toolNames(false, 'full', undefined, true)).toContain('get_verification_code');
    expect(await toolNames(false, 'full')).not.toContain('get_verification_code');
  });

  it('keeps read on when nothing is ticked', async () => {
    expect(await toolNames(false, 'full', [])).toEqual(groupTools(['read']));
  });

  it('bulk_action offers delete only when the delete box is ticked', async () => {
    const actionsFor = async (groups: ToolGroup[]) => {
      const bulk = (await listTools(false, 'full', groups)).find((t) => t.name === 'bulk_action');
      return (bulk?.inputSchema.properties?.action as { enum?: string[] } | undefined)?.enum;
    };
    expect(await actionsFor(['tidy'])).not.toContain('delete');
    expect(await actionsFor(['tidy'])).toContain('move');
    expect(await actionsFor(['tidy', 'delete'])).toContain('delete');
    expect(await actionsFor([...TOOL_GROUP_NAMES])).toContain('delete');
  });

  it('wins over the toolset preset', async () => {
    const names = await toolNames(false, 'minimal', ['rules']);
    expect(names).toContain('sieve_status');
    expect(names).not.toContain('send_email');
  });

  it('still hides write tools in read_only mode', async () => {
    const names = await toolNames(true, 'full', ['send', 'tidy', 'delete', 'calendar']);
    ['send_email', 'move_email', 'delete_email', 'add_to_calendar'].forEach((name) => {
      expect(names).not.toContain(name);
    });
    expect(names).toContain('list_events');
    expect(names).toContain('get_email');
  });

  it('normalizes order, duplicates and the missing read group', () => {
    expect(normalizeToolGroups(['alerts', 'send', 'send'])).toEqual(['read', 'send', 'alerts']);
  });

  it('validates the setting', () => {
    expect(SettingsSchema.parse({}).tools).toBeUndefined();
    expect(SettingsSchema.parse({ tools: ['read', 'send'] }).tools).toEqual(['read', 'send']);
    expect(() => SettingsSchema.parse({ tools: ['everything'] })).toThrow();
  });
});
