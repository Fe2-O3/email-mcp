/**
 * Config management subcommands.
 *
 * - config show  — display current config with masked passwords
 * - config path  — print config file path
 * - config init  — create a template config file
 */

import fs from 'node:fs/promises';

import { cancel, confirm, intro, isCancel, log, outro, text } from '@clack/prompts';
import { parse as parseTOML } from 'smol-toml';

import {
  CONFIG_FILE,
  configExists,
  generateTemplate,
  loadConfig,
  loadRawConfig,
  saveConfig,
} from '../config/loader.js';
import { AppConfigFileSchema } from '../config/schema.js';
import { findConsistencyIssues, findUnknownKeys } from '../config/validate.js';
import ensureInteractive from './guard.js';

function printConfigUsage(): void {
  console.log(`Usage: email-mcp config <subcommand>

Subcommands:
  show      Show current configuration (passwords masked)
  edit      Edit global settings interactively
  validate  Check the config file: syntax, schema, typo'd keys,
            cross-setting consistency (exit 1 on errors; CI-friendly)
  path      Print config file path
  init      Create a template config file
`);
}

function showPath(): void {
  console.log(CONFIG_FILE);
}

async function showConfig(): Promise<void> {
  const exists = await configExists();
  if (!exists) {
    console.error(`No config file found at: ${CONFIG_FILE}`);
    console.error(`Run 'email-mcp setup' or 'email-mcp config init' to create one.`);
    throw new Error('Config file not found');
  }

  let config: Awaited<ReturnType<typeof loadConfig>>;
  try {
    config = await loadConfig();
  } catch (err) {
    throw new Error(`Failed to load config: ${err instanceof Error ? err.message : String(err)}`);
  }

  console.log(`Config file: ${CONFIG_FILE}\n`);
  console.log(`[settings]`);
  console.log(`  rate_limit = ${config.settings.rateLimit}`);
  console.log(`  read_only  = ${config.settings.readOnly}\n`);

  config.accounts.forEach((account) => {
    console.log(`[accounts.${account.name}]`);
    console.log(`  email    = ${account.email}`);
    if (account.fullName) {
      console.log(`  name     = ${account.fullName}`);
    }
    const smtpSecurity = account.smtp.tls ? 'TLS' : 'plain';
    const smtpLabel = account.smtp.starttls ? 'STARTTLS' : smtpSecurity;
    const smtpPool = account.smtp.pool ?? {
      enabled: true,
      maxConnections: 1,
      maxMessages: 100,
    };
    const imapSecurity = account.imap.tls ? 'TLS' : 'plain';
    const imapLabel = account.imap.starttls ? 'STARTTLS' : imapSecurity;
    console.log(`  imap     = ${account.imap.host}:${account.imap.port} (${imapLabel})`);
    console.log(`  smtp     = ${account.smtp.host}:${account.smtp.port} (${smtpLabel})`);
    console.log(
      `  smtp_pool = ${
        smtpPool.enabled
          ? `enabled (${smtpPool.maxConnections} conns, ${smtpPool.maxMessages} msgs/conn)`
          : 'disabled'
      }`,
    );
    console.log(`  password = ${'•'.repeat(8)}\n`);
  });
}

async function initConfig(): Promise<void> {
  ensureInteractive();
  intro('email-mcp config init');

  const exists = await configExists();
  if (exists) {
    const overwrite = await confirm({
      message: `Config file already exists at ${CONFIG_FILE}. Overwrite?`,
      initialValue: false,
    });

    if (isCancel(overwrite) || !overwrite) {
      cancel('Cancelled.');
      return;
    }
  }

  const dir = CONFIG_FILE.replace(/\/[^/]+$/, '');
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(CONFIG_FILE, generateTemplate(), 'utf-8');
  log.success(`Template config created at ${CONFIG_FILE}`);
  log.info("Edit the file to add your email accounts, then run 'email-mcp test'.");
  outro('Done!');
}

async function editSettings(): Promise<void> {
  ensureInteractive();
  intro('email-mcp › Edit Settings');

  const exists = await configExists();
  if (!exists) {
    log.error(`No config file found at: ${CONFIG_FILE}`);
    cancel("Run 'email-mcp account add' or 'email-mcp config init' first.");
    return;
  }

  const config = await loadRawConfig();
  const { settings } = config;

  log.info(`Current settings:`);
  log.info(`  rate_limit = ${settings.rate_limit}`);
  log.info(`  read_only  = ${settings.read_only}`);

  const rateLimitStr = await text({
    message: 'Rate limit (max emails per minute per account)',
    defaultValue: String(settings.rate_limit),
    initialValue: String(settings.rate_limit),
    validate: (v) => {
      if (!v) return 'Must be a positive integer';
      const n = parseInt(v, 10);
      if (Number.isNaN(n) || n < 1) return 'Must be a positive integer';
      return undefined;
    },
  });
  if (isCancel(rateLimitStr)) {
    cancel('Cancelled.');
    return;
  }

  const readOnly = await confirm({
    message: 'Read-only mode? (disables all write operations)',
    initialValue: settings.read_only,
  });
  if (isCancel(readOnly)) {
    cancel('Cancelled.');
    return;
  }

  const updatedConfig = {
    ...config,
    settings: {
      ...settings,
      rate_limit: parseInt(rateLimitStr, 10),
      read_only: readOnly,
    },
  };

  await saveConfig(updatedConfig);
  log.success(`Settings updated. Config saved to ${CONFIG_FILE}`);
  outro('Done!');
}

/**
 * Static validation of the config file. Non-interactive and CI-friendly:
 * exit code 1 on errors, 0 when valid (warnings allowed). Live connection
 * checks stay in `email-mcp test`.
 *
 * Ported from codefuturist/email-mcp v0.5.1 (commit bf09dcc), adapted to
 * this fork's settings sections.
 */
async function validateConfig(): Promise<void> {
  console.log(`Validating ${CONFIG_FILE}\n`);

  if (!(await configExists())) {
    console.error(`❌ No config file found at: ${CONFIG_FILE}`);
    console.error(`   Run 'email-mcp account add' or 'email-mcp config init' to create one.`);
    process.exitCode = 1;
    return;
  }

  const content = await fs.readFile(CONFIG_FILE, 'utf-8');

  let parsed: unknown;
  try {
    parsed = parseTOML(content);
  } catch (err) {
    console.error(`❌ TOML syntax error:\n   ${err instanceof Error ? err.message : String(err)}`);
    process.exitCode = 1;
    return;
  }
  console.log('✅ TOML syntax');

  let errorCount = 0;
  let warningCount = 0;

  const result = AppConfigFileSchema.safeParse(parsed);
  if (result.success) {
    console.log('✅ Schema (accounts and all settings sections)');
  } else {
    console.log('❌ Schema:');
    for (const issue of result.error.issues) {
      const where = issue.path.length > 0 ? issue.path.join('.') : '(root)';
      console.log(`   ❌ ${where}: ${issue.message}`);
      errorCount += 1;
    }
  }

  const unknown = findUnknownKeys(parsed);
  if (unknown.length === 0) {
    console.log('✅ No unknown keys');
  } else {
    console.log('⚠️ Unknown keys (silently ignored by the server):');
    for (const u of unknown) {
      const hint = u.suggestion ? ` — did you mean "${u.suggestion}"?` : '';
      console.log(`   ⚠️ ${u.path}${hint}`);
      warningCount += 1;
    }
  }

  if (result.success) {
    const issues = findConsistencyIssues(result.data);
    if (issues.length === 0) {
      console.log('✅ Settings are consistent');
    } else {
      console.log('Consistency:');
      for (const issue of issues) {
        console.log(`   ${issue.severity === 'error' ? '❌' : '⚠️'} ${issue.message}`);
        if (issue.severity === 'error') errorCount += 1;
        else warningCount += 1;
      }
    }
  }

  console.log('');
  if (errorCount > 0) {
    console.error(`❌ Config invalid — ${errorCount} error(s), ${warningCount} warning(s).`);
    process.exitCode = 1;
    return;
  }
  console.log(`✅ Config valid — ${warningCount} warning(s).`);
  console.log(`   Live connection check: email-mcp test`);
}

export default async function runConfigCommand(subcommand?: string): Promise<void> {
  switch (subcommand) {
    case 'show':
      await showConfig();
      return;
    case 'edit':
      await editSettings();
      return;
    case 'validate':
      await validateConfig();
      return;
    case 'path':
      showPath();
      return;
    case 'init':
      await initConfig();
      return;
    default:
      printConfigUsage();
  }
}
