import { describe, expect, it } from 'vitest';
import type { Transport } from './install-commands.js';
import { buildServerEntry } from './install-commands.js';

const TRANSPORTS: Transport[] = ['npx', 'pnpm', 'global', 'node'];

describe('buildServerEntry', () => {
  it('npx launches this fork package, not upstream', () => {
    expect(buildServerEntry('npx')).toEqual({
      command: 'npx',
      args: ['-y', 'imap-wizard', 'stdio'],
    });
  });

  it('pnpm dlx launches this fork package', () => {
    expect(buildServerEntry('pnpm')).toEqual({
      command: 'pnpm',
      args: ['dlx', 'imap-wizard', 'stdio'],
    });
  });

  it('global uses the imap-wizard command', () => {
    expect(buildServerEntry('global')).toEqual({ command: 'imap-wizard', args: ['stdio'] });
  });

  it('no transport ever references the upstream package', () => {
    for (const transport of TRANSPORTS) {
      expect(JSON.stringify(buildServerEntry(transport))).not.toContain('codefuturist');
    }
  });

  it('node transport runs the current script with stdio', () => {
    const entry = buildServerEntry('node');
    expect(entry.command).toBe(process.execPath);
    expect(entry.args.at(-1)).toBe('stdio');
  });
});
