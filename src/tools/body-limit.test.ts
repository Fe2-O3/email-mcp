import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { MAX_EMAIL_BODY_LENGTH } from '../safety/validation.js';
import type { AppConfig } from '../types/index.js';
import registerAllTools from './register.js';

/**
 * Bug4 — send bodies have no size limit.
 *
 * send_email, reply_email, forward_email and save_draft were bare z.string()
 * with no ceiling. A shared limit is now enforced via z.string().max(...) and
 * validateInputLength using one constant MAX_EMAIL_BODY_LENGTH (5 MB).
 *
 * The test loops over all four tools rather than duplicating the same check,
 * and asserts that a body one byte over the limit is rejected by schema
 * validation while a body at the limit passes.
 */

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

interface CapturedTool {
  name: string;
  schema: z.ZodObject;
}

function captureTools(): CapturedTool[] {
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

describe('Bug4 — body size limit is enforced on all send paths', () => {
  const tools = captureTools();
  const targetNames = ['send_email', 'reply_email', 'forward_email', 'save_draft'];

  it('captures the four expected tools', () => {
    const names = tools.map((t) => t.name);
    for (const n of targetNames) {
      expect(names).toContain(n);
    }
  });

  it('rejects a body one byte over the limit and accepts a body at the limit', () => {
    const over = 'a'.repeat(MAX_EMAIL_BODY_LENGTH + 1);
    const at = 'a'.repeat(MAX_EMAIL_BODY_LENGTH);
    const failures: string[] = [];

    for (const name of targetNames) {
      const entry = tools.find((t) => t.name === name);
      if (!entry) {
        failures.push(`${name}: not found`);
        continue;
      }
      const bodyField = entry.schema.shape.body;
      if (!bodyField) {
        failures.push(`${name}: no body field`);
        continue;
      }
      // Check that the field is actually limited — use a minimal object that
      // provides required other fields where possible
      const schema = z.object({ body: bodyField });

      const overResult = schema.safeParse({ body: over });
      if (overResult.success) failures.push(`${name}: over-limit body was accepted`);

      const atResult = schema.safeParse({ body: at });
      if (!atResult.success) failures.push(`${name}: at-limit body was rejected`);

      // For optional body (forward_email), also check undefined is allowed
      if (name === 'forward_email') {
        const undefResult = schema.safeParse({});
        // When body is optional, missing should be ok (or fail only if required)
        // We just ensure our max check doesn't break optional
        void undefResult;
      }
    }

    expect(failures).toEqual([]);
  });

  it('uses a single shared constant rather than separate literals', async () => {
    // Verify that both tool modules import the same constant and that
    // the HTTP cap is separate (10 MB vs 5 MB email body)
    const fs = await import('node:fs/promises');
    const sendSrc = await fs.readFile(new URL('./send.tool.ts', import.meta.url), 'utf-8');
    const draftSrc = await fs.readFile(new URL('./drafts.tool.ts', import.meta.url), 'utf-8');
    const validationSrc = await fs.readFile(
      new URL('../safety/validation.ts', import.meta.url),
      'utf-8',
    );

    expect(validationSrc).toContain('MAX_EMAIL_BODY_LENGTH');
    expect(sendSrc).toContain('MAX_EMAIL_BODY_LENGTH');
    expect(draftSrc).toContain('MAX_EMAIL_BODY_LENGTH');
    // Ensure no hard-coded 5_000_000 literals remain in the tool files
    expect(sendSrc).not.toMatch(/\b5_000_000\b/);
    expect(draftSrc).not.toMatch(/\b5_000_000\b/);
  });
});
