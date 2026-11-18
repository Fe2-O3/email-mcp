import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/server';

import createServer from '../server.js';
import type { AppConfig } from '../types/index.js';
import registerAllTools from './register.js';

interface ListedTool {
  name: string;
  annotations?: Record<string, unknown>;
}

async function listTools(readOnly: boolean): Promise<Map<string, ListedTool>> {
  const server = createServer();
  const stub = new Proxy({}, { get: () => () => [] }) as never;
  const config = {
    settings: {
      readOnly,
      toolset: 'full',
      verification: { enabled: true, includeMagicLinks: false },
    },
    accounts: [],
  } as unknown as AppConfig;
  registerAllTools(
    server,
    { getAccountNames: () => [] } as never,
    stub,
    stub,
    config,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
  );
  const client = new Client({ name: 'annotations-test', version: '0.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([
    client.connect(clientTransport as never),
    server.connect(serverTransport as never),
  ]);
  try {
    const { tools } = await client.listTools();
    return new Map(tools.map((tool) => [tool.name, tool as ListedTool]));
  } finally {
    await Promise.allSettled([client.close(), server.close()]);
  }
}

describe('tool annotations are honest', () => {
  // Tools that can write a local file. They never change mail, so read_only keeps them.
  it.each(['download_attachment', 'export_email'])(
    '%s is not marked read-only but stays available in read_only mode',
    async (name) => {
      const writable = await listTools(false);
      const readOnly = await listTools(true);

      expect(writable.get(name)?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(readOnly.has(name)).toBe(true);
      expect(readOnly.get(name)?.annotations?.readOnlyHint).toBe(false);
    },
  );

  it('does not mark get_email read-only while markRead can change \\Seen', async () => {
    expect((await listTools(false)).get('get_email')?.annotations?.readOnlyHint).toBe(false);
    // read_only refuses markRead, so there the hint is true.
    expect((await listTools(true)).get('get_email')?.annotations?.readOnlyHint).toBe(true);
  });

  it('keeps every write tool out of read_only mode', async () => {
    const writable = await listTools(false);
    const readOnly = await listTools(true);
    // get_verification_code writes the local clipboard only when asked, never mail.
    const localFileWriters = new Set([
      'download_attachment',
      'export_email',
      'get_verification_code',
    ]);
    readOnly.forEach((tool, name) => {
      const hinted = tool.annotations?.readOnlyHint === true;
      // A tool that survives read_only is either hinted read-only, a local-only writer,
      // or a tool whose hint is read-only-conditional (get_email, checked above).
      expect(
        hinted || localFileWriters.has(name),
        `${name} is writable but kept in read_only`,
      ).toBe(true);
      expect(writable.has(name)).toBe(true);
    });
  });
});
