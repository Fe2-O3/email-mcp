/**
 * Tool registration — single wiring point.
 *
 * Registers all MCP tools with the server instance.
 * In read-only mode, write tools are not registered at all.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { readAllowedRedirects } from '../config/loader.js';
import type ConnectionManager from '../connections/manager.js';
import type CalendarService from '../services/calendar.service.js';
import type HooksService from '../services/hooks.service.js';
import type ImapService from '../services/imap.service.js';
import type LocalCalendarService from '../services/local-calendar.service.js';
import { LocalRulesStore } from '../services/local-rules.service.js';
import type RemindersService from '../services/reminders.service.js';
import type SchedulerService from '../services/scheduler.service.js';
import SieveService from '../services/sieve.service.js';
import SieveManager from '../services/sieve-manager.service.js';
import type SmtpService from '../services/smtp.service.js';
import type TemplateService from '../services/template.service.js';
import type WatcherService from '../services/watcher.service.js';
import type { AppConfig } from '../types/index.js';

/** Services that only some tool groups need; defaults are built when absent. */
export interface ToolExtras {
  /** ManageSieve client. Pass one with an OAuth token source in production. */
  sieveService?: SieveService;
  /** Where local rules are stored (the data directory by default, never config.toml). */
  localRulesStore?: LocalRulesStore;
}

import registerAccountsTools from './accounts.tool.js';
import registerAnalyticsTools from './analytics.tool.js';
import registerAttachmentTools from './attachments.tool.js';
import registerBulkTools from './bulk.tool.js';
import registerCalendarTools from './calendar.tool.js';
import registerContactsTools from './contacts.tool.js';
import registerDraftTools from './drafts.tool.js';
import registerEmailsTools from './emails.tool.js';
import registerExportTools from './export.tool.js';
import registerFolderTools from './folders.tool.js';
import registerHealthTools from './health.tool.js';
import registerLabelTools from './label.tool.js';
import { registerLocalRulesReadTools, registerLocalRulesWriteTools } from './local-rules.tool.js';
import registerLocateTools from './locate.tool.js';
import registerMailboxesTools from './mailboxes.tool.js';
import registerManageTools from './manage.tool.js';
import registerSchedulerTools from './scheduler.tool.js';
import registerSecurityTools from './security.tool.js';
import registerSendTools from './send.tool.js';
import { registerSieveReadTools, registerSieveWriteTools } from './sieve.tool.js';
import { registerTemplateReadTools, registerTemplateWriteTools } from './templates.tool.js';
import registerThreadTools from './thread.tool.js';
import { restrictToToolset } from './toolsets.js';
import registerVerificationTool from './verification.tool.js';
import { registerWatcherReadTools, registerWatcherWriteTools } from './watcher.tool.js';

export default function registerAllTools(
  fullServer: McpServer,
  connections: ConnectionManager,
  imapService: ImapService,
  smtpService: SmtpService,
  config: AppConfig,
  templateService: TemplateService,
  calendarService: CalendarService,
  localCalendarService: LocalCalendarService,
  remindersService: RemindersService,
  schedulerService: SchedulerService,
  watcherService: WatcherService,
  hooksService: HooksService,
  extras: ToolExtras = {},
): void {
  const { readOnly, toolset } = config.settings;
  // Tools outside the configured toolset are skipped at registration.
  const server = restrictToToolset(fullServer, toolset);
  // The forwarding allowlist is read from config.toml each time it is needed. No
  // tool receives a way to change it, and nothing below writes config.toml.
  const sieveManager = new SieveManager({
    sieve: extras.sieveService ?? new SieveService(),
    allowlist: config.sieve?.allowedRedirects ?? [],
    readAllowlist: readAllowedRedirects,
    listFolders: async (account) =>
      (await imapService.listMailboxes(account)).map((mailbox) => mailbox.path),
  });

  // Read tools — always registered
  registerAccountsTools(server, connections);
  registerMailboxesTools(server, imapService);
  registerEmailsTools(server, imapService, readOnly);
  registerAttachmentTools(server, imapService);
  registerExportTools(server, imapService);
  registerContactsTools(server, imapService);
  registerThreadTools(server, imapService);
  registerTemplateReadTools(server, templateService);
  registerCalendarTools(
    server,
    imapService,
    calendarService,
    localCalendarService,
    remindersService,
    readOnly,
  );
  registerAnalyticsTools(server, imapService);
  registerHealthTools(server, connections, imapService);
  registerLocateTools(server, imapService);
  registerSecurityTools(server, imapService);
  registerWatcherReadTools(server, watcherService, hooksService);
  // Only in the full toolset: no core/minimal list names them.
  registerSieveReadTools(server, connections, sieveManager);
  const localRulesStore = extras.localRulesStore ?? new LocalRulesStore();
  registerLocalRulesReadTools(server, localRulesStore, config);
  if (config.settings.verification.enabled) {
    // Explicit opt-in, so it is registered in every toolset.
    registerVerificationTool(fullServer, imapService, config);
  }

  // Write tools — skipped in read-only mode
  if (!readOnly) {
    registerSendTools(server, smtpService);
    registerManageTools(server, imapService);
    registerLabelTools(server, imapService);
    registerBulkTools(server, imapService);
    registerDraftTools(server, imapService, smtpService);
    registerFolderTools(server, imapService);
    registerTemplateWriteTools(server, templateService, imapService, smtpService);
    registerSchedulerTools(server, schedulerService);
    registerWatcherWriteTools(server, hooksService);
    registerSieveWriteTools(server, connections, sieveManager);
    registerLocalRulesWriteTools(
      server,
      localRulesStore,
      connections,
      imapService,
      config,
      readAllowedRedirects,
    );
  }
}
