import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/server';

import { AppConfigFileSchema, SettingsSchema } from '../config/schema.js';
import createServer from '../server.js';
import type { AppConfig, Toolset } from '../types/index.js';
import registerAllTools from './register.js';
import { CORE_TOOLS, MINIMAL_TOOLS } from './toolsets.js';

function configFor(readOnly: boolean, toolset: Toolset): AppConfig {
  return {
    settings: {
      readOnly,
      toolset,
      verification: { enabled: false, includeMagicLinks: false },
    },
    accounts: [],
  } as unknown as AppConfig;
}

async function toolNames(readOnly: boolean, toolset: Toolset): Promise<string[]> {
  const server = createServer();
  const stub = new Proxy({}, { get: () => () => [] }) as never;
  registerAllTools(
    server,
    { getAccountNames: () => [] } as never,
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
  const client = new Client({ name: 'toolset-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport as never),
    server.connect(serverTransport as never),
  ]);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name).sort();
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
