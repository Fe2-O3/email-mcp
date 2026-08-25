import { describe, expect, it } from 'vitest';

import registerCalendarTools from './calendar.tool.js';

describe('calendar tools respect readOnly', () => {
  it('hides write tools when readOnly', () => {
    const registered: string[] = [];
    const server = {
      registerTool: (name: string) => registered.push(name),
    } as never;
    const stub = {} as never;
    registerCalendarTools(server, stub, stub, stub, stub, true);
    expect(registered).not.toContain('add_to_calendar');
    expect(registered).not.toContain('create_reminder');
    expect(registered).toContain('list_events');
  });

  it('exposes write tools otherwise', () => {
    const registered: string[] = [];
    const server = {
      registerTool: (name: string) => registered.push(name),
    } as never;
    const stub = {} as never;
    registerCalendarTools(server, stub, stub, stub, stub, false);
    expect(registered).toContain('add_to_calendar');
    expect(registered).toContain('create_reminder');
  });

  it('write tools no longer accept confirm', async () => {
    const { z } = await import('zod');
    // The schemas should not contain confirm - check by inspecting the tool registration
    const captured: Array<{ name: string; schema: unknown }> = [];
    const server = {
      registerTool: (name: string, cfg: { inputSchema?: unknown }) => {
        captured.push({ name, schema: cfg.inputSchema });
      },
    } as never;
    const stub = {} as never;
    registerCalendarTools(server, stub, stub, stub, stub, false);
    const add = captured.find((c) => c.name === 'add_to_calendar');
    const rem = captured.find((c) => c.name === 'create_reminder');
    // Both schemas should not have confirm
    const hasConfirm = (schema: unknown) =>
      schema instanceof z.ZodObject && 'confirm' in schema.shape;
    expect(hasConfirm(add?.schema)).toBe(false);
    expect(hasConfirm(rem?.schema)).toBe(false);
  });
});
