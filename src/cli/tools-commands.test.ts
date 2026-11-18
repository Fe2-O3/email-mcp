import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, setToolGroupsInConfig } from '../config/loader.js';
import { countTools, describeChoice, parseGroupList } from './tools-commands.js';

const ACCOUNT = `
[[accounts]]
name = "test"
email = "test@example.com"
password = "secret"

[accounts.imap]
host = "imap.example.com"

[accounts.smtp]
host = "smtp.example.com"
`;

describe('setToolGroupsInConfig', () => {
  let tmpDir: string;
  let file: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'email-mcp-tools-test-'));
    file = path.join(tmpDir, 'config.toml');
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('adds the line under [settings] and keeps every comment', async () => {
    const before = `# my notes\n[settings]\nread_only = false  # keep me\n\n[settings.send]\nmax_attachment_mb = 25\n${ACCOUNT}`;
    await fs.writeFile(file, before);
    await setToolGroupsInConfig(['read', 'send'], file);
    const after = await fs.readFile(file, 'utf-8');
    expect(after).toContain('# my notes');
    expect(after).toContain('read_only = false  # keep me');
    expect(after).toContain('[settings]\ntools = ["read", "send"]\n');
    expect((await loadConfig(file)).settings.tools).toEqual(['read', 'send']);
  });

  it('replaces an existing line instead of adding a second', async () => {
    await fs.writeFile(file, `[settings]\ntools = ["read"]\n${ACCOUNT}`);
    await setToolGroupsInConfig(['read', 'rules'], file);
    const after = await fs.readFile(file, 'utf-8');
    expect(after.match(/^tools =/gm)).toHaveLength(1);
    expect((await loadConfig(file)).settings.tools).toEqual(['read', 'rules']);
  });

  it('adds the line in [settings], not in a sub-table', async () => {
    await fs.writeFile(file, `[settings]\nread_only = false\n\n[settings.hooks]\n${ACCOUNT}`);
    await setToolGroupsInConfig(['read'], file);
    expect((await loadConfig(file)).settings.tools).toEqual(['read']);
  });

  it('creates [settings] when the file has none', async () => {
    await fs.writeFile(file, ACCOUNT);
    await setToolGroupsInConfig(['read', 'calendar'], file);
    expect((await loadConfig(file)).settings.tools).toEqual(['read', 'calendar']);
  });

  it('removes the line on reset, so toolset decides again', async () => {
    await fs.writeFile(file, `[settings]\ntoolset = "core"\ntools = ["read"]\n${ACCOUNT}`);
    await setToolGroupsInConfig(null, file);
    const config = await loadConfig(file);
    expect(config.settings.tools).toBeUndefined();
    expect(config.settings.toolset).toBe('core');
  });

  it('refuses a hand-written multi-line array and leaves the file alone', async () => {
    const before = `[settings]\ntools = [\n  "read",\n]\n${ACCOUNT}`;
    await fs.writeFile(file, before);
    await expect(setToolGroupsInConfig(['read', 'send'], file)).rejects.toThrow();
    expect(await fs.readFile(file, 'utf-8')).toBe(before);
  });
});

describe('tools command helpers', () => {
  it('parses a group list and adds read', () => {
    expect(parseGroupList('send, Organize')).toEqual(['read', 'send', 'organize']);
  });

  it('names the bad group', () => {
    expect(() => parseGroupList('send,everything')).toThrow(/everything/);
  });

  it('counts tools, read included', () => {
    expect(countTools([])).toBe(16);
    expect(countTools(['read', 'send', 'organize', 'rules', 'calendar', 'alerts'])).toBe(61);
  });

  it('describes a preset and a group choice', () => {
    const base = { toolset: 'core', read_only: false } as never;
    expect(describeChoice(base)).toBe('the "core" preset (24 of 61 tools)');
    expect(describeChoice({ ...(base as object), tools: ['send'] } as never)).toBe(
      'read mail, send and reply (25 of 61 tools)',
    );
  });
});
