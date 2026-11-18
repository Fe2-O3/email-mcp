/**
 * CLI scheduler subcommands.
 *
 * Provides check, list, install, uninstall, and status subcommands
 * for managing the email scheduler.
 */

/* eslint-disable n/no-sync -- CLI commands use execSync for launchctl/crontab */

import { execFileSync, execSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { loadConfig } from '../config/loader.js';
import { xdg } from '../config/xdg.js';
import { currentFingerprint } from '../connections/account-identity.js';
import ConnectionManager from '../connections/manager.js';
import RateLimiter from '../safety/rate-limiter.js';
import ImapService from '../services/imap.service.js';
import OAuthService from '../services/oauth.service.js';
import SchedulerService from '../services/scheduler.service.js';
import SmtpService from '../services/smtp.service.js';

const LAUNCHD_LABEL = 'com.email-mcp.scheduler';
const LAUNCHD_PLIST_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const LAUNCHD_PLIST = path.join(LAUNCHD_PLIST_DIR, `${LAUNCHD_LABEL}.plist`);
const CRONTAB_MARKER = '# email-mcp scheduler';
const SCHEDULER_LOG = path.join(xdg.state, 'scheduler.log');

/** Escape text for an XML element body. */
export function xmlEscape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** Quote one word for a POSIX shell (cron runs the line through sh). */
export function shellQuote(word: string): string {
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function getExecutablePath(): string {
  return process.argv[1] ?? 'imap-wizard';
}

async function createSchedulerService(): Promise<SchedulerService> {
  const config = await loadConfig();
  const connections = new ConnectionManager(config.accounts, new OAuthService());
  const rateLimiter = new RateLimiter(config.settings.rateLimit);
  const imapService = new ImapService(connections);
  const smtpService = new SmtpService(connections, rateLimiter, imapService);
  return new SchedulerService(smtpService, imapService, config.settings.readOnly, (name) =>
    currentFingerprint(connections, name),
  );
}

// ---------------------------------------------------------------------------
// Subcommands
// ---------------------------------------------------------------------------

async function runCheck(): Promise<void> {
  const scheduler = await createSchedulerService();
  const result = await scheduler.checkAndSend();

  if (result.skipped) {
    console.log(`⏸️  ${result.skipped}`);
    return;
  }
  if (result.sent > 0) {
    console.log(`✅ Sent ${result.sent} scheduled email(s)`);
  }
  if (result.unknown > 0) {
    console.log(`❓ Unknown result: ${result.unknown}. Check the Sent folder first; not retried.`);
  }
  if (result.deferred > 0) {
    console.log(`⏳ Waiting to retry: ${result.deferred}`);
  }
  if (result.failed > 0) {
    console.log(`❌ Failed: ${result.failed}`);
  }
  for (const err of result.errors) console.log(`   ${err}`); // eslint-disable-line no-restricted-syntax
  if (
    result.sent === 0 &&
    result.failed === 0 &&
    result.unknown === 0 &&
    result.deferred === 0 &&
    result.errors.length === 0
  ) {
    console.log('No overdue scheduled emails.');
  }
}

async function runList(): Promise<void> {
  const scheduler = await createSchedulerService();
  const emails = await scheduler.list({ status: 'all' });

  if (emails.length === 0) {
    console.log('No scheduled emails.');
    return;
  }

  const pending = emails.filter((e) => e.status === 'pending');
  const sent = emails.filter((e) => e.status === 'sent');
  const failed = emails.filter((e) => e.status === 'failed');
  const unknown = emails.filter((e) => e.status === 'unknown');

  if (pending.length > 0) {
    console.log(`\n📬 Pending (${pending.length}):`);
    pending.forEach((e) => {
      const overdue = new Date(e.sendAt).getTime() < Date.now() ? ' ⚠️ OVERDUE' : '';
      console.log(
        `  ${e.id.slice(0, 8)} | ${e.account} → ${e.to.join(', ')} | "${e.subject}" | ${e.sendAt}${overdue}`,
      );
    });
  }

  if (sent.length > 0) {
    console.log(`\n✅ Sent (${sent.length}):`);
    sent.forEach((e) => {
      console.log(
        `  ${e.id.slice(0, 8)} | ${e.account} → ${e.to.join(', ')} | "${e.subject}" | sent ${e.sentAt}`,
      );
    });
  }

  if (unknown.length > 0) {
    console.log(`\n❓ Unknown result, check Sent first (${unknown.length}):`);
    unknown.forEach((e) => {
      console.log(
        `  ${e.id.slice(0, 8)} | ${e.account} → ${e.to.join(', ')} | "${e.subject}" | ${e.lastError}`,
      );
    });
  }

  if (failed.length > 0) {
    console.log(`\n❌ Failed (${failed.length}):`);
    failed.forEach((e) => {
      console.log(
        `  ${e.id.slice(0, 8)} | ${e.account} → ${e.to.join(', ')} | "${e.subject}" | ${e.lastError}`,
      );
    });
  }
}

async function runInstall(): Promise<void> {
  const platform = os.platform();
  const execPath = getExecutablePath();

  if (platform === 'darwin') {
    // macOS: launchd plist
    const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(process.execPath)}</string>
    <string>${xmlEscape(execPath)}</string>
    <string>scheduler</string>
    <string>check</string>
  </array>
  <key>StartInterval</key>
  <integer>60</integer>
  <key>StandardOutPath</key>
  <string>${xmlEscape(SCHEDULER_LOG)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(SCHEDULER_LOG)}</string>
  <key>RunAtLoad</key>
  <true/>
</dict>
</plist>`;

    await fs.mkdir(LAUNCHD_PLIST_DIR, { recursive: true });
    await fs.mkdir(xdg.state, { recursive: true, mode: 0o700 });
    await fs.writeFile(LAUNCHD_PLIST, plist);

    try {
      execSync(`launchctl load "${LAUNCHD_PLIST}"`, { stdio: 'pipe' });
    } catch {
      // May already be loaded
    }

    console.log('✅ Installed macOS launchd scheduler');
    console.log(`   Plist: ${LAUNCHD_PLIST}`);
    console.log('   Runs every 60 seconds');
  } else if (platform === 'linux') {
    // Linux: crontab
    const cronLine = `* * * * * ${shellQuote(process.execPath)} ${shellQuote(execPath)} scheduler check ${CRONTAB_MARKER}`;

    try {
      const existing = execSync('crontab -l 2>/dev/null', {
        encoding: 'utf-8',
      });
      if (existing.includes(CRONTAB_MARKER)) {
        console.log('⚠️  Scheduler crontab entry already exists');
        return;
      }
      const newCrontab = `${existing.trimEnd()}\n${cronLine}\n`;
      execFileSync('crontab', ['-'], { input: newCrontab, stdio: 'pipe' });
    } catch {
      execFileSync('crontab', ['-'], { input: `${cronLine}\n`, stdio: 'pipe' });
    }

    console.log('✅ Installed Linux crontab scheduler');
    console.log('   Runs every minute');
  } else {
    console.error(`❌ Unsupported platform: ${platform}`);
    console.error("   Manually run 'imap-wizard scheduler check' on a schedule.");
  }
}

/** The crontab without the scheduler line; every other line is untouched. */
export function removeSchedulerCron(existing: string): string {
  return existing
    .split('\n')
    .filter((line) => !line.includes(CRONTAB_MARKER))
    .join('\n');
}

async function runUninstall(): Promise<void> {
  const platform = os.platform();

  if (platform === 'darwin') {
    try {
      execSync(`launchctl unload "${LAUNCHD_PLIST}"`, { stdio: 'pipe' });
    } catch {
      // May not be loaded
    }

    try {
      await fs.unlink(LAUNCHD_PLIST);
      console.log('✅ Removed macOS launchd scheduler');
    } catch {
      console.log('ℹ️  No launchd scheduler found');
    }
  } else if (platform === 'linux') {
    try {
      const existing = execSync('crontab -l 2>/dev/null', {
        encoding: 'utf-8',
      });
      // Hand the text to crontab on stdin: no shell, so quotes and backslashes
      // in other jobs come back byte for byte.
      execFileSync('crontab', ['-'], { input: removeSchedulerCron(existing), stdio: 'pipe' });
      console.log('✅ Removed Linux crontab scheduler');
    } catch {
      console.log('ℹ️  No crontab scheduler found');
    }
  } else {
    console.error(`❌ Unsupported platform: ${platform}`);
  }
}

async function runStatus(): Promise<void> {
  const platform = os.platform();

  if (platform === 'darwin') {
    try {
      await fs.access(LAUNCHD_PLIST);
      try {
        const output = execSync(`launchctl list ${LAUNCHD_LABEL} 2>/dev/null`, {
          encoding: 'utf-8',
        });
        const pidMatch = /"PID"\s*=\s*(\d+)/.exec(output);
        console.log('✅ macOS launchd scheduler: INSTALLED');
        console.log(`   Plist: ${LAUNCHD_PLIST}`);
        if (pidMatch) {
          console.log(`   PID: ${pidMatch[1]}`);
        }
      } catch {
        console.log('⚠️  macOS launchd scheduler: INSTALLED but not loaded');
        console.log(`   Plist: ${LAUNCHD_PLIST}`);
      }
    } catch {
      console.log('❌ macOS launchd scheduler: NOT INSTALLED');
    }
  } else if (platform === 'linux') {
    try {
      const existing = execSync('crontab -l 2>/dev/null', {
        encoding: 'utf-8',
      });
      if (existing.includes(CRONTAB_MARKER)) {
        console.log('✅ Linux crontab scheduler: INSTALLED');
      } else {
        console.log('❌ Linux crontab scheduler: NOT INSTALLED');
      }
    } catch {
      console.log('❌ Linux crontab scheduler: NOT INSTALLED');
    }
  }

  // Show queue status
  const scheduler = await createSchedulerService();
  const pending = await scheduler.list({ status: 'pending' });
  const overdue = pending.filter((e) => new Date(e.sendAt).getTime() < Date.now());

  console.log(`\n📬 Queue: ${pending.length} pending, ${overdue.length} overdue`);
}

// ---------------------------------------------------------------------------
// Main router
// ---------------------------------------------------------------------------

const SCHEDULER_HELP = `
imap-wizard scheduler — Email scheduling management

Commands:
  check      Send overdue scheduled emails
  list       Display all scheduled emails
  install    Install OS periodic check (macOS launchd / Linux crontab)
  uninstall  Remove OS periodic check
  status     Show scheduler installation status
`.trim();

export default async function runSchedulerCommand(subcommand?: string): Promise<void> {
  switch (subcommand) {
    case 'check':
      await runCheck();
      break;
    case 'list':
      await runList();
      break;
    case 'install':
      await runInstall();
      break;
    case 'uninstall':
      await runUninstall();
      break;
    case 'status':
      await runStatus();
      break;
    case 'help':
    case '--help':
    case undefined:
      console.log(SCHEDULER_HELP);
      break;
    default:
      console.error(`Unknown scheduler command: ${subcommand}\n`);
      console.log(SCHEDULER_HELP);
  }
}
