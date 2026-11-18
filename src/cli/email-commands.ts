/**
 * One-shot terminal commands for reading, managing, and sending email.
 * Business logic stays in the existing IMAP and SMTP services.
 */

import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { confirm, isCancel } from '@clack/prompts';
import { z } from 'zod';
import { loadConfig } from '../config/loader.js';
import { resolveSendLimitMb } from '../config/send-limit.js';
import ConnectionManager from '../connections/manager.js';
import RateLimiter from '../safety/rate-limiter.js';
import { MAX_EMAIL_BODY_LENGTH, validateInputLength } from '../safety/validation.js';
import ImapService from '../services/imap.service.js';
import OAuthService from '../services/oauth.service.js';
import SmtpService from '../services/smtp.service.js';
import type { AccountConfig, AppConfig, Email, EmailMeta } from '../types/index.js';
import { stripHtml } from '../utils/html.js';
import offlineNotice from '../utils/offline-notice.js';
import { sanitizeInline, stripControlChars } from '../utils/sanitize-text.js';
import { parseUid } from '../utils/uid.js';

export interface CliServices {
  config: AppConfig;
  imap: ImapService;
  smtp: SmtpService;
  close: () => Promise<void>;
}

const USAGE: Record<string, string> = {
  list: 'imap-wizard list [--account NAME] [--mailbox INBOX] [--limit 20] [--page 1] [--unread] [--search TEXT] [--json]',
  read: 'imap-wizard read <id> [--account NAME] [--mailbox INBOX] [--mark-read] [--json]',
  search: 'imap-wizard search <query> [--account NAME] [--mailbox INBOX] [--limit 20] [--json]',
  mailboxes: 'imap-wizard mailboxes [--account NAME] [--json]',
  flag: 'imap-wizard flag <id> [--off] [--account NAME] [--mailbox INBOX] [--occurrence N]',
  delete: 'imap-wizard delete <id> [--yes] [--account NAME] [--mailbox INBOX] [--occurrence N]',
  attach:
    'imap-wizard attach <id> <filename> [dest-dir] [--account NAME] [--mailbox INBOX] [--occurrence N]',
  reply: 'imap-wizard reply <id> --body TEXT [--all] [--html] [--attach FILE]... [--account NAME]',
  send: 'imap-wizard send --to a@b[,c@d] --subject S --body B [--cc ..] [--bcc ..] [--html] [--attach FILE]...',
};

function emailUsage(command: string): string {
  return `Usage: ${USAGE[command] ?? 'imap-wizard <list|read|search|mailboxes|flag|delete|attach|reply|send>'}`;
}

async function buildCliServices(): Promise<CliServices> {
  const config = await loadConfig();
  const connections = new ConnectionManager(config.accounts, new OAuthService());
  const imap = new ImapService(connections);
  const smtp = new SmtpService(
    connections,
    new RateLimiter(config.settings.rateLimit),
    imap,
    config.settings.send.maxAttachmentMb,
  );
  return {
    config,
    imap,
    smtp,
    close: async () => {
      await smtp.waitForSentFilings();
      await connections.closeAll();
    },
  };
}

export function resolveAccount(config: AppConfig, requested?: string): AccountConfig {
  if (requested) {
    const found = config.accounts.find((account) => account.name === requested);
    if (!found) {
      const names = config.accounts.map((account) => account.name).join(', ');
      throw new Error(`Unknown account "${requested}". Configured accounts: ${names || '(none)'}.`);
    }
    return found;
  }
  if (config.accounts.length === 0) {
    throw new Error('No accounts configured. Run `imap-wizard account add` first.');
  }
  return config.accounts[0] as AccountConfig;
}

function asJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2));
}

function formatDate(date: string): string {
  return date
    .replace('T', ' ')
    .replace(/\.\d{3}Z$/, ' UTC')
    .replace(/Z$/, ' UTC');
}

/** Names and addresses from the message, as one clean line: no terminal control codes. */
function cleanAddress(address: { name?: string; address: string }): string {
  const text = address.name ? `${address.name} <${address.address}>` : address.address;
  return sanitizeInline(text, 1000);
}

function formatMeta(email: EmailMeta): string {
  const markers = [
    email.seen ? '' : 'UNREAD',
    email.flagged ? 'FLAGGED' : '',
    email.hasAttachments ? 'ATTACHMENT' : '',
  ].filter(Boolean);
  const subject = sanitizeInline(email.subject) || '(no subject)';
  return `${email.id.padStart(8)}  ${markers.join(' ')}  ${cleanAddress(email.from)}\n          ${subject}\n          ${formatDate(email.date)}`;
}

/**
 * Everything printed here came from the message, and a terminal obeys control codes: window
 * titles, cursor moves that overwrite earlier lines, clipboard writes. So every header and the
 * body lose C0, C1 and bidi controls first (newline and tab stay in the body).
 */
export function formatEmail(email: Email): string {
  const body = stripControlChars(
    email.bodyText ?? (email.bodyHtml ? stripHtml(email.bodyHtml) : ''),
    true,
  );
  const lines = [
    `From: ${cleanAddress(email.from)}`,
    `To: ${email.to.map((address) => sanitizeInline(address.address, 320)).join(', ')}`,
  ];
  if (email.cc?.length) {
    lines.push(`Cc: ${email.cc.map((address) => sanitizeInline(address.address, 320)).join(', ')}`);
  }
  lines.push(
    `Date: ${formatDate(email.date)}`,
    `Subject: ${sanitizeInline(email.subject)}`,
    '',
    body,
  );
  if (email.attachments.length) {
    lines.push('', 'Attachments:');
    for (const attachment of email.attachments) {
      lines.push(
        `  ${sanitizeInline(attachment.filename, 300)} (${sanitizeInline(attachment.mimeType, 100)}, ${formatSize(attachment.size)})`,
      );
    }
  }
  return lines.join('\n');
}

function assertWritable(config: AppConfig): void {
  if (config.settings.readOnly) throw new Error('This command is disabled by read-only mode.');
}

function positiveInteger(value: string, name: string, max: number): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > max) {
    throw new Error(`${name} must be an integer between 1 and ${max}.`);
  }
  return number;
}

async function runCommand(command: string, svc: CliServices, argv: string[]): Promise<void> {
  switch (command) {
    case 'list': {
      const { values } = parseArgs({
        args: argv,
        options: {
          account: { type: 'string' },
          mailbox: { type: 'string', default: 'INBOX' },
          limit: { type: 'string', default: '20' },
          page: { type: 'string', default: '1' },
          unread: { type: 'boolean', default: false },
          search: { type: 'string' },
          json: { type: 'boolean', default: false },
        },
        allowPositionals: false,
      });
      const account = resolveAccount(svc.config, values.account);
      const result = await svc.imap.listEmails(account.name, {
        mailbox: values.mailbox,
        pageSize: positiveInteger(values.limit, 'limit', 100),
        page: positiveInteger(values.page, 'page', 100_000),
        ...(values.unread ? { seen: false } : {}),
        ...(values.search ? { subject: values.search } : {}),
      });
      if (values.json) asJson(result);
      else if (result.items.length === 0) console.log(`No emails in ${values.mailbox}.`);
      else {
        console.log(`${values.mailbox}: ${result.total} messages (page ${result.page})`);
        for (const email of result.items) console.log(`\n${formatMeta(email)}`);
      }
      return;
    }
    case 'read': {
      const { values, positionals } = parseArgs({
        args: argv,
        options: {
          account: { type: 'string' },
          mailbox: { type: 'string', default: 'INBOX' },
          'mark-read': { type: 'boolean', default: false },
          json: { type: 'boolean', default: false },
        },
        allowPositionals: true,
      });
      const id = positionals[0];
      if (!id) throw new Error(emailUsage(command));
      // One message only: "1:*" or "1,2" would reach every message they name.
      parseUid(id);
      const account = resolveAccount(svc.config, values.account);
      const email = await svc.imap.getEmail(account.name, id, values.mailbox);
      if (values.json) asJson(email);
      else {
        const notice = offlineNotice(email);
        if (notice) console.log(notice);
        console.log(formatEmail(email));
      }
      if (values['mark-read']) {
        assertWritable(svc.config);
        await svc.imap.setFlags(account.name, id, values.mailbox, 'read');
      }
      return;
    }
    case 'search': {
      const { values, positionals } = parseArgs({
        args: argv,
        options: {
          account: { type: 'string' },
          mailbox: { type: 'string', default: 'INBOX' },
          limit: { type: 'string', default: '20' },
          json: { type: 'boolean', default: false },
        },
        allowPositionals: true,
      });
      const query = positionals.join(' ').trim();
      if (!query) throw new Error(emailUsage(command));
      const account = resolveAccount(svc.config, values.account);
      const result = await svc.imap.searchEmails(account.name, query, {
        mailbox: values.mailbox,
        pageSize: positiveInteger(values.limit, 'limit', 100),
      });
      if (values.json) asJson(result);
      else if (result.items.length === 0) console.log(`No emails match "${query}".`);
      else {
        console.log(`${values.mailbox}: ${result.total} matches for "${query}"`);
        for (const email of result.items) console.log(`\n${formatMeta(email)}`);
      }
      return;
    }
    case 'mailboxes': {
      const { values } = parseArgs({
        args: argv,
        options: { account: { type: 'string' }, json: { type: 'boolean', default: false } },
      });
      const account = resolveAccount(svc.config, values.account);
      const mailboxes = await svc.imap.listMailboxes(account.name);
      if (values.json) asJson(mailboxes);
      else {
        for (const mailbox of mailboxes) {
          console.log(
            `${mailbox.path}${mailbox.specialUse ? ` (${mailbox.specialUse})` : ''}` +
              `${mailbox.totalMessages === undefined ? '' : `  ${mailbox.totalMessages} messages`}` +
              `${mailbox.unseenMessages === undefined ? '' : `, ${mailbox.unseenMessages} unread`}`,
          );
        }
      }
      return;
    }
    case 'flag': {
      const { values, positionals } = parseArgs({
        args: argv,
        options: {
          account: { type: 'string' },
          mailbox: { type: 'string', default: 'INBOX' },
          off: { type: 'boolean', default: false },
        },
        allowPositionals: true,
      });
      const id = positionals[0];
      if (!id) throw new Error(emailUsage(command));
      // One message only: "1:*" or "1,2" would reach every message they name.
      parseUid(id);
      assertWritable(svc.config);
      const account = resolveAccount(svc.config, values.account);
      await svc.imap.setFlags(account.name, id, values.mailbox, values.off ? 'unflag' : 'flag');
      console.log(values.off ? `Unflagged ${id}.` : `Flagged ${id}.`);
      return;
    }
    case 'delete': {
      const { values, positionals } = parseArgs({
        args: argv,
        options: {
          account: { type: 'string' },
          mailbox: { type: 'string', default: 'INBOX' },
          yes: { type: 'boolean', default: false },
        },
        allowPositionals: true,
      });
      const id = positionals[0];
      if (!id) throw new Error(emailUsage(command));
      // One message only: "1:*" or "1,2" would reach every message they name.
      parseUid(id);
      assertWritable(svc.config);
      const account = resolveAccount(svc.config, values.account);
      if (!values.yes) {
        const ok = await confirm({ message: `Delete message ${id} from ${values.mailbox}?` });
        if (isCancel(ok) || !ok) {
          console.log('Cancelled.');
          return;
        }
      }
      const warnings = await svc.imap.deleteEmail(account.name, id, values.mailbox);
      console.log(`Deleted ${id}.`);
      for (const warning of warnings ?? []) console.log(`Warning: ${warning}`);
      return;
    }
    case 'attach': {
      const { values, positionals } = parseArgs({
        args: argv,
        options: {
          account: { type: 'string' },
          mailbox: { type: 'string', default: 'INBOX' },
          // Which one, from 1, when several attachments share the file name.
          occurrence: { type: 'string' },
        },
        allowPositionals: true,
      });
      const [id, filename, destination = '.'] = positionals;
      if (!id || !filename) throw new Error(emailUsage(command));
      parseUid(id);
      const account = resolveAccount(svc.config, values.account);
      const attachment = await svc.imap.downloadAttachment(
        account.name,
        id,
        values.mailbox,
        filename,
        50 * 1024 * 1024,
        values.occurrence === undefined
          ? undefined
          : positiveInteger(values.occurrence, 'occurrence', 1000),
      );
      const base = path.resolve(destination);
      await mkdir(base, { recursive: true });
      const output = path.resolve(base, safeAttachmentFilename(attachment.filename));
      const relative = path.relative(base, output);
      if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        throw new Error(`Refusing to write "${attachment.filename}" outside ${base}.`);
      }
      await writeFile(output, Buffer.from(attachment.contentBase64, 'base64'), { flag: 'wx' });
      console.log(
        `Saved ${sanitizeInline(attachment.filename, 300)} (${formatSize(attachment.size)}) to ${output}`,
      );
      return;
    }
    case 'reply': {
      const { values, positionals } = parseArgs({
        args: argv,
        options: {
          account: { type: 'string' },
          mailbox: { type: 'string', default: 'INBOX' },
          body: { type: 'string' },
          all: { type: 'boolean', default: false },
          html: { type: 'boolean', default: false },
          attach: { type: 'string', multiple: true, default: [] },
        },
        allowPositionals: true,
      });
      const id = positionals[0];
      if (!id || values.body === undefined) throw new Error(emailUsage(command));
      parseUid(id);
      assertWritable(svc.config);
      const account = resolveAccount(svc.config, values.account);
      validateInputLength(values.body, MAX_EMAIL_BODY_LENGTH, 'Body');
      const attachments = await loadLocalAttachments(
        values.attach as string[],
        account,
        svc.config,
      );
      const result = await svc.smtp.replyToEmail(account.name, {
        emailId: id,
        mailbox: values.mailbox,
        body: values.body,
        replyAll: values.all,
        html: values.html,
        attachments,
      });
      console.log(`Reply sent. Message-ID: ${result.messageId}`);
      return;
    }
    case 'send': {
      const { values } = parseArgs({
        args: argv,
        options: {
          account: { type: 'string' },
          to: { type: 'string' },
          cc: { type: 'string' },
          bcc: { type: 'string' },
          subject: { type: 'string' },
          body: { type: 'string' },
          html: { type: 'boolean', default: false },
          attach: { type: 'string', multiple: true, default: [] },
        },
        allowPositionals: false,
      });
      const to = splitAddresses(values.to);
      if (to.length === 0 || values.subject === undefined || values.body === undefined) {
        throw new Error(emailUsage(command));
      }
      assertWritable(svc.config);
      const account = resolveAccount(svc.config, values.account);
      validateInputLength(values.subject, 998, 'Subject');
      validateInputLength(values.body, MAX_EMAIL_BODY_LENGTH, 'Body');
      const attachments = await loadLocalAttachments(
        values.attach as string[],
        account,
        svc.config,
      );
      const result = await svc.smtp.sendEmail(account.name, {
        to,
        cc: splitAddresses(values.cc),
        bcc: splitAddresses(values.bcc),
        subject: values.subject,
        body: values.body,
        html: values.html,
        attachments,
      });
      console.log(`Sent to ${to.join(', ')}. Message-ID: ${result.messageId}`);
      return;
    }
    default:
      throw new Error(emailUsage(command));
  }
}

function splitAddresses(value?: string): string[] {
  const addresses = (value ?? '')
    .split(',')
    .map((address) => address.trim())
    .filter(Boolean);
  for (const address of addresses) {
    if (!z.email({ pattern: z.regexes.html5Email }).safeParse(address).success) {
      throw new Error(`Invalid email address: ${address}`);
    }
  }
  return addresses;
}

async function loadLocalAttachments(
  files: string[],
  account: AccountConfig,
  config: AppConfig,
): Promise<Array<{ filename: string; content: string }>> {
  if (files.length === 0) return [];
  const limitMb = resolveSendLimitMb(account, config.settings.send.maxAttachmentMb);
  const maxBytes = limitMb * 1024 * 1024;
  let encodedSize = 0;
  for (const file of files) {
    let info: Awaited<ReturnType<typeof stat>>;
    try {
      info = await stat(file);
    } catch {
      throw new Error(`Attachment not found: ${file}`);
    }
    if (!info.isFile()) throw new Error(`Attachment is not a file: ${file}`);
    encodedSize += Math.ceil(info.size / 3) * 4;
  }
  if (encodedSize > maxBytes) {
    throw new Error(`Attachments exceed the ${limitMb} MB send limit after base64 encoding.`);
  }

  const attachments: Array<{ filename: string; content: string }> = [];
  let actualEncodedSize = 0;
  for (let i = 0; i < files.length; i += 1) {
    const file = files[i] as string;
    const data = await readFile(file);
    actualEncodedSize += Math.ceil(data.length / 3) * 4;
    if (actualEncodedSize > maxBytes) {
      throw new Error(`Attachments changed while being read and exceed the ${limitMb} MB limit.`);
    }
    attachments.push({
      filename: safeAttachmentFilename(path.basename(file)),
      content: data.toString('base64'),
    });
  }
  return attachments;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function safeAttachmentFilename(filename: string): string {
  const base = [...path.basename(filename.replace(/\\/g, '/'))]
    .map((char) => (char.charCodeAt(0) < 32 ? '_' : char))
    .join('');
  if (!base || base === '.' || base === '..') throw new Error('Attachment has an unsafe filename.');
  return base.slice(0, 240);
}

export default async function runEmailCommand(command: string, argv: string[]): Promise<void> {
  if (!Object.hasOwn(USAGE, command)) throw new Error(emailUsage(command));
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(emailUsage(command));
    return;
  }
  const services = await buildCliServices();
  try {
    await runEmailCommandWithServices(command, argv, services);
  } finally {
    await services.close();
  }
}

/** Exposed for tests and embedders that already own a service graph. */
export async function runEmailCommandWithServices(
  command: string,
  argv: string[],
  services: CliServices,
): Promise<void> {
  if (!Object.hasOwn(USAGE, command)) throw new Error(emailUsage(command));
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(emailUsage(command));
    return;
  }
  await runCommand(command, services, argv);
}
