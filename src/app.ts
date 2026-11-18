/**
 * Application composition root.
 *
 * Builds the service graph (`buildServices`) and a fully-registered McpServer
 * (`buildServer`) from it. Shared by every transport entry point (stdio and
 * Streamable HTTP) so tools/resources/prompts are wired in exactly one place.
 */

import type { McpServer, Server } from '@modelcontextprotocol/server';

import BodyCache from './cache/body-cache.js';
import CacheStore from './cache/store.js';
import SyncEngine from './cache/sync-engine.js';
import { loadConfig } from './config/loader.js';
import { CACHE_DB } from './config/xdg.js';
import ConnectionManager from './connections/manager.js';
import { mcpLog } from './logging.js';
import registerAllPrompts from './prompts/register.js';
import registerAllResources from './resources/register.js';
import RateLimiter from './safety/rate-limiter.js';
import { createWriterLease, WRITER_LEASE_FILE } from './safety/writer-lease.js';
import createServer from './server.js';
import CalendarService from './services/calendar.service.js';
import HooksService from './services/hooks.service.js';
import ImapService from './services/imap.service.js';
import LocalCalendarService from './services/local-calendar.service.js';
import LocalRulesService, { LocalRulesStore } from './services/local-rules.service.js';
import OAuthService from './services/oauth.service.js';
import RemindersService from './services/reminders.service.js';
import SchedulerService from './services/scheduler.service.js';
import SieveService from './services/sieve.service.js';
import SmtpService from './services/smtp.service.js';
import TemplateService from './services/template.service.js';
import WatcherService from './services/watcher.service.js';
import registerAllTools from './tools/register.js';
import type { AppConfig } from './types/index.js';

/** The full, shared service graph for one server process. */
export interface AppServices {
  config: AppConfig;
  connections: ConnectionManager;
  imapService: ImapService;
  smtpService: SmtpService;
  templateService: TemplateService;
  calendarService: CalendarService;
  localCalendarService: LocalCalendarService;
  remindersService: RemindersService;
  schedulerService: SchedulerService;
  watcherService: WatcherService;
  hooksService: HooksService;
  sieveService: SieveService;
  localRulesStore: LocalRulesStore;
  /** Absent when the local mirror is disabled in config. */
  cacheStore?: CacheStore;
  syncEngine?: SyncEngine;
}

/** Construct the full service graph from persisted configuration. */
export async function buildServices(): Promise<AppServices> {
  const config = await loadConfig();

  const oauthService = new OAuthService();
  const connections = new ConnectionManager(config.accounts, oauthService);
  const rateLimiter = new RateLimiter(config.settings.rateLimit);
  const imapService = new ImapService(connections);
  const smtpService = new SmtpService(
    connections,
    rateLimiter,
    imapService,
    config.settings.send.maxAttachmentMb,
  );
  const templateService = new TemplateService();
  const calendarService = new CalendarService();
  const localCalendarService = new LocalCalendarService();
  const remindersService = new RemindersService();
  const schedulerService = new SchedulerService(smtpService, imapService, config.settings.readOnly);
  const watcherService = new WatcherService(config.settings.watcher, config.accounts, oauthService);
  const hooksService = new HooksService(config.settings.hooks, imapService);
  // Local rules run inside the hooks pipeline, so only the process holding the
  // writer lease (the one running the watcher) applies them.
  const localRulesStore = new LocalRulesStore();
  hooksService.attachLocalRules(
    new LocalRulesService({
      store: localRulesStore,
      imapService,
      smtpService,
      allowlist: config.sieve?.allowedRedirects ?? [],
      accounts: config.accounts,
    }),
  );
  const sieveService = new SieveService({
    getAccessToken: async (oauth2) => oauthService.getAccessToken(oauth2),
  });

  // The mirror is optional and must never block startup: if SQLite cannot be
  // opened (read-only volume, corrupt file, unwritable XDG dir) the server
  // still serves every tool live.
  let cacheStore: CacheStore | undefined;
  let syncEngine: SyncEngine | undefined;
  if (config.settings.cache.enabled) {
    try {
      cacheStore = new CacheStore(CACHE_DB);
      // Read-through is opt-in. Without it the service has no port attached,
      // the engine does no backfill, and every read takes the live path it
      // always did.
      const { readThrough, bodyMaxMb, bodyMessages, offlineReads } = config.settings.cache;
      const bodyCache = readThrough ? new BodyCache(cacheStore, bodyMaxMb) : undefined;
      syncEngine = new SyncEngine(
        connections,
        cacheStore,
        {
          windowDays: config.settings.cache.windowDays,
          maxSizeMb: config.settings.cache.maxSizeMb,
        },
        bodyCache ? { cache: bodyCache, bodyMessages, bodyMaxMb } : undefined,
      );
      if (bodyCache) imapService.attachBodyCache(bodyCache, { offlineReads });
    } catch (err) {
      cacheStore = undefined;
      syncEngine = undefined;
      await mcpLog(
        'warning',
        'cache',
        `Local mirror disabled — could not open ${CACHE_DB}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  return {
    config,
    connections,
    imapService,
    smtpService,
    templateService,
    calendarService,
    localCalendarService,
    remindersService,
    schedulerService,
    watcherService,
    hooksService,
    sieveService,
    localRulesStore,
    cacheStore,
    syncEngine,
  };
}

/**
 * Build a fresh, fully-registered McpServer from an existing service graph.
 *
 * Safe to call per connection (stdio) or per request (stateless HTTP): the
 * services are shared singletons, only the thin protocol wrapper is new.
 */
export function buildServer(services: AppServices): McpServer {
  const server = createServer();

  registerAllTools(
    server,
    services.connections,
    services.imapService,
    services.smtpService,
    services.config,
    services.templateService,
    services.calendarService,
    services.localCalendarService,
    services.remindersService,
    services.schedulerService,
    services.watcherService,
    services.hooksService,
    { sieveService: services.sieveService, localRulesStore: services.localRulesStore },
  );
  registerAllResources(
    server,
    services.connections,
    services.imapService,
    services.templateService,
    services.schedulerService,
  );
  registerAllPrompts(server);

  return server;
}

/** Handle for tearing down the process-level background services. */
export interface BackgroundHandle {
  stop: () => Promise<void>;
}

/**
 * Start the process-level background services: the new-mail watcher (feeding
 * AI hooks + resource-update notifications) and the periodic scheduled-email
 * check. These are process-scoped, not per-connection or per-request.
 *
 * @param lowLevelServer the connected low-level `Server` for notifications /
 *   opportunistic sampling, or `null` when no persistent connection applies.
 */
export function startBackgroundServices(
  services: AppServices,
  lowLevelServer: Server | null,
  options: { leasePath?: string } = {},
): BackgroundHandle {
  const { hooksService, watcherService, schedulerService, imapService, syncEngine, config } =
    services;
  let stopped = false;
  let schedulerInterval: ReturnType<typeof setInterval> | undefined;
  let cacheInterval: ReturnType<typeof setInterval> | undefined;

  if (config.settings.readOnly) {
    return {
      stop: async () => {
        stopped = true;
        if (schedulerInterval) clearInterval(schedulerInterval);
        if (cacheInterval) clearInterval(cacheInterval);
        syncEngine?.stop();
        // Clears the alert notifier's timer too, which otherwise kept a
        // read-only stdio server alive until the 5-second forced exit.
        hooksService.stop();
        // Same teardown as write mode: read-only still opens IMAP connections and the mirror.
        imapService.dispose();
        services.cacheStore?.close();
      },
    };
  }

  // Several AI windows start several servers on the same accounts. Only the
  // process holding the writer lease runs the watcher and the hooks (alerts and
  // AI triage); the others serve tools and take over if the holder goes away.
  // The scheduler keeps its own lock and runs in every process.
  const logLease = (level: 'info' | 'warning', message: string): void => {
    mcpLog(level, 'server', message).catch(() => undefined);
  };
  const lease = createWriterLease({
    lockPath: options.leasePath ?? WRITER_LEASE_FILE,
    onLead: async () => {
      hooksService.start(lowLevelServer);
      await watcherService.start();
      logLease('info', 'This process runs the watcher and hooks');
    },
    onLose: async () => {
      hooksService.stop();
      await watcherService.stop();
      logLease('warning', 'Another IMAP Wizard process took over the watcher and hooks');
    },
    report: (message) => logLease('warning', message),
  });

  syncEngine?.start();

  void (async () => {
    try {
      await lease.start();
      // A fast shutdown can run stop() while this startup block is still
      // awaiting. Every handle armed below must be re-checked against the
      // stopped flag at each resume point, or it outlives its own teardown
      // and keeps the event loop alive forever.
      if (stopped) return;
      await mcpLog(
        'info',
        'server',
        lease.leading
          ? 'IMAP Wizard background services started'
          : 'IMAP Wizard background services started; another process runs the watcher and hooks',
      );

      // Check for overdue scheduled emails on startup, then every 60 seconds.
      // A failed job or a broken state folder is logged, never swallowed.
      let tickFailing = false;
      const schedulerTick = async (startup: boolean): Promise<void> => {
        try {
          const result = await schedulerService.checkAndSend();
          tickFailing = false;
          if (result.sent > 0) {
            await mcpLog(
              'info',
              'scheduler',
              `Sent ${result.sent} scheduled email(s)${startup ? ' on startup' : ''}`,
            );
          }
          if (result.unknown > 0) {
            await mcpLog(
              'warning',
              'scheduler',
              `${result.unknown} scheduled email(s) have an unknown result: check the Sent folder, then cancel them with cancel_scheduled`,
            );
          }
          if (result.failed > 0) {
            await mcpLog(
              'warning',
              'scheduler',
              `${result.failed} scheduled email(s) failed for good: ${result.errors.join('; ')}`,
            );
          }
        } catch (err) {
          // Log once per streak, not every minute.
          if (!tickFailing) {
            tickFailing = true;
            await mcpLog(
              'warning',
              'scheduler',
              `The scheduled-email check failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      };
      await schedulerTick(true);

      // Periodic scheduler check every 60 seconds.
      if (stopped) return;
      schedulerInterval = setInterval(() => {
        void schedulerTick(false);
      }, 60_000);

      // Reconcile the local mirror: once at startup, then on an interval.
      // syncMailbox never throws and never blocks a tool call, so this can
      // stay fire-and-forget.
      if (syncEngine) {
        const { mailboxes, syncInterval } = config.settings.cache;
        const reconcile = async (): Promise<void> => {
          const work = services.connections
            .getAccountNames()
            .flatMap((account) =>
              mailboxes.map((mailbox) => syncEngine.syncMailbox(account, mailbox)),
            );
          await Promise.allSettled(work);
        };

        if (stopped) return;
        await reconcile();
        if (stopped) return;
        cacheInterval = setInterval(() => {
          void reconcile();
        }, syncInterval * 1000);
      }
    } catch (err) {
      process.stderr.write(
        `[imap-wizard] background start error: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      if (schedulerInterval) clearInterval(schedulerInterval);
      if (cacheInterval) clearInterval(cacheInterval);
      // Halt first so this process cannot win the lease mid-shutdown, and
      // release only after the writers stopped so the next leader never
      // overlaps them.
      await lease.halt();
      hooksService.stop();
      await watcherService.stop();
      await lease.release();
      syncEngine?.stop();
      imapService.dispose();
      // The mirror commits incrementally under WAL, so closing here is tidy
      // rather than load-bearing — neither shutdown handler is guaranteed to
      // run to completion (main.ts:85, cli/http.ts:175).
      services.cacheStore?.close();
    },
  };
}
