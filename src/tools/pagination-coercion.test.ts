/**
 * Some MCP clients serialise every tool argument as a string, so `page: 2`
 * arrives as `page: "2"`. A bare `z.number()` rejects that and the tool call
 * fails with a validation error the user cannot act on.
 *
 * `z.coerce.number()` accepts both. The emitted JSON Schema is byte-identical
 * either way (`type: "integer"`), so the contract the model sees does not
 * change — only what the server tolerates on the way in.
 *
 * Asserted against the schemas the tools actually register, so a new paginated
 * tool that forgets `coerce` fails here.
 *
 * Upstream: codefuturist/email-mcp#28
 */

import { z } from 'zod';
import type { AppConfig } from '../types/index.js';
import registerAllTools from './register.js';

interface CapturedTool {
  name: string;
  /** The registered inputSchema: a ZodObject whose `.shape` holds the fields. */
  schema: z.ZodObject;
}

function serviceStub(): unknown {
  return new Proxy(
    {},
    {
      get: () => () => undefined,
    },
  );
}

function createConfig(): AppConfig {
  return {
    settings: {
      rateLimit: 10,
      readOnly: false,
      cache: {
        enabled: false,
        mailboxes: [],
        windowDays: 0,
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
  };
}

function captureRegisteredTools(): CapturedTool[] {
  const captured: CapturedTool[] = [];

  const fakeServer = {
    tool: (name: string, ...rest: unknown[]) => {
      const shape = rest.find(
        (arg) => typeof arg === 'object' && arg !== null && !Array.isArray(arg),
      ) as z.ZodRawShape | undefined;
      if (shape) captured.push({ name, schema: z.object(shape) });
    },
    registerTool: (name: string, cfg: { inputSchema?: z.ZodObject }) => {
      if (cfg?.inputSchema) captured.push({ name, schema: cfg.inputSchema });
    },
    prompt: () => undefined,
    resource: () => undefined,
    server: serviceStub(),
  };

  const stub = serviceStub() as never;
  registerAllTools(
    fakeServer as never,
    stub,
    stub,
    stub,
    createConfig(),
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
    stub,
  );

  return captured;
}

/** Params a stringifying client is known to mangle. */
const NUMERIC_PARAMS = ['page', 'pageSize', 'limit', 'offset', 'maxResults'];

describe('paginated tool params tolerate stringified numbers', () => {
  const tools = captureRegisteredTools();

  it('finds the paginated tools at all (guards against a silent no-op)', () => {
    const withPaging = tools.filter(({ schema }) =>
      NUMERIC_PARAMS.some((key) => key in schema.shape),
    );
    expect(withPaging.length).toBeGreaterThan(0);
  });

  it('accepts a string for every numeric pagination param', () => {
    const rejected: string[] = [];

    for (const { name, schema } of tools) {
      for (const key of NUMERIC_PARAMS) {
        const field = schema.shape[key];
        if (field) {
          const result = z.object({ [key]: field }).safeParse({ [key]: '2' });
          if (!result.success) rejected.push(`${name}.${key}`);
        }
      }
    }

    expect(rejected).toEqual([]);
  });

  it('still rejects values that are not numbers at all', () => {
    const [firstPaginated] = tools.filter(({ schema }) => 'page' in schema.shape);
    expect(firstPaginated).toBeDefined();

    const target = z.object({ page: firstPaginated.schema.shape.page });
    expect(target.safeParse({ page: 'not-a-number' }).success).toBe(false);
    expect(target.safeParse({ page: '0' }).success).toBe(false);
  });
});
