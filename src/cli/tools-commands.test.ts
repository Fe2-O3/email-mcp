import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig, setToolGroupsInConfig } from '../config/loader.js';
import TemplateService from '../services/template.service.js';
import { TOOL_GROUP_NAMES } from '../tools/toolsets.js';
import {
  afterToolChoice,
  countTools,
  currentGroups,
  describeChoice,
  parseGroupList,
} from './tools-commands.js';

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
    expect(parseGroupList('send, Tidy')).toEqual(['read', 'send', 'tidy']);
  });

  it('names the bad group', () => {
    expect(() => parseGroupList('send,everything')).toThrow(/everything/);
  });

  it('counts tools, read included', () => {
    expect(countTools([])).toBe(11);
    expect(countTools([...TOOL_GROUP_NAMES])).toBe(62);
  });

  it('describes a preset and a group choice', () => {
    const base = { toolset: 'core', read_only: false } as never;
    expect(describeChoice(base)).toBe('the "core" preset (24 of 62 tools)');
    expect(describeChoice({ ...(base as object), tools: ['send'] } as never)).toBe(
      'read and search your mail, send email as you (18 of 62 tools)',
    );
  });

  it('starts the boxes from what is on now', () => {
    const full = { toolset: 'full', read_only: false } as never;
    expect(currentGroups(full)).not.toContain('codes');
    expect(
      currentGroups({ ...(full as object), verification: { enabled: true } } as never),
    ).toContain('codes');
    expect(currentGroups({ ...(full as object), tools: ['delete'] } as never)).toEqual([
      'read',
      'delete',
    ]);
  });

  it('adds an example template when templates are ticked and none exist', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'tpl-'));
    try {
      await afterToolChoice(['templates'], dir);
      const files = await fs.readdir(dir);
      expect(files).toEqual(['thank-you.toml']);
      const text = await fs.readFile(path.join(dir, files[0] as string), 'utf-8');
      expect(text).toContain('{{name}}');
      // The example must load cleanly, or the AI sees a broken template.
      const loaded = await new TemplateService(dir).loadTemplates();
      expect(loaded.problems).toEqual([]);
      expect(loaded.templates.map((t) => t.name)).toEqual(['thank-you']);
      // A second run leaves the folder alone.
      await afterToolChoice(['templates'], dir);
      expect(await fs.readdir(dir)).toEqual(['thank-you.toml']);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });

  it('adds nothing when templates are not ticked', async () => {
    const dir = path.join(os.tmpdir(), `tpl-none-${process.pid}`);
    await afterToolChoice(['send'], dir);
    await expect(fs.readdir(dir)).rejects.toThrow();
  });
});
