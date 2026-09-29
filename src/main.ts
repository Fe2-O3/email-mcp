#!/usr/bin/env node
/**
 * IMAP Wizard (email-mcp) — Main entry point.
 *
 * Subcommands:
 *   stdio     Run as MCP server over stdio (default)
 *   http      Run as MCP server over Streamable HTTP (networked)
 *   account   Account management (list, add, edit, delete)
 *   test      Test IMAP/SMTP connections
 *   config    Config management (show, edit, validate, path, init)
 *   scheduler Email scheduling management
 */

import { StdioServerTransport, serveStdio } from '@modelcontextprotocol/server/stdio';

import type { BackgroundHandle } from './app.js';
import { buildServer, buildServices, startBackgroundServices } from './app.js';
import { PKG_VERSION } from './server.js';

/**
 * How long a graceful shutdown may take before the process is forced down.
 * Bounds the two goodbye round trips (SMTP QUIT, IMAP LOGOUT) over a slow WAN;
 * past that, dropping the sockets beats leaking the process we are shutting down.
 */
const SHUTDOWN_GRACE_MS = 5_000;

const HELP = `
email-mcp — IMAP Wizard (email MCP server: IMAP + SMTP)

Usage:
  email-mcp [command]

Commands:
  stdio       Run as MCP server over stdio (default)
  http        Run as MCP server over Streamable HTTP (networked)
  account     Account management (list, add, edit, delete)
  setup       Alias for 'account add'
  test        Test connections for all or a specific account
  install     Register/unregister with MCP clients (Claude, Cursor, …)
  config      Config management (show, edit, validate, path, init)
  keychain    Password management (migrate, status, remove)
  scheduler   Email scheduling management (check, list, install, uninstall, status)
  notify      Test and diagnose desktop notifications
  help        Show this help message

Examples:
  email-mcp                         # Start MCP server (stdio)
  email-mcp http --port 8080         # Start Streamable HTTP server on :8080/mcp
  email-mcp http --host 0.0.0.0 --port 8080   # Bind all interfaces (requires a token)
  email-mcp account list             # List configured accounts
  email-mcp account add              # Add a new email account
  email-mcp account edit personal    # Edit an account
  email-mcp account delete work      # Delete an account
  email-mcp setup                    # Alias for account add
  email-mcp test                     # Test all accounts
  email-mcp test personal            # Test specific account
  email-mcp install                  # Register with detected MCP clients
  email-mcp install status           # Show client registration status
  email-mcp install remove           # Unregister from MCP clients
  email-mcp config show              # Show config (passwords masked)
  email-mcp config edit              # Edit global settings
  email-mcp config validate          # Syntax, schema, typo'd keys, consistency
  email-mcp config path              # Print config file path
  email-mcp config init              # Create template config
  email-mcp keychain status          # Show Keychain vs plain text passwords
  email-mcp keychain migrate         # Move passwords to macOS Keychain
  email-mcp keychain remove [name]   # Remove a password from Keychain
  email-mcp scheduler check          # Send overdue scheduled emails
  email-mcp scheduler install        # Install OS periodic check
  email-mcp notify test              # Send a test notification
  email-mcp notify status            # Check notification platform support
`.trim();

async function runServer(): Promise<void> {
  const services = await buildServices();

  let background: BackgroundHandle | undefined;
  let started = false;

  // Idle exit — settings.idle_exit seconds without an inbound MCP message and
  // the process takes itself down, so a host that keeps a session open forever
  // (resumed chats, forgotten terminals) does not pin a child for days. EOF
  // above stays the primary lifecycle signal; this is the backstop for hosts
  // that never close the pipe. 0 disables.
  const idleExitSec = services.config.settings.idleExit;
  let lastActivity = Date.now();

  // Tap the transport's message handler through an accessor rather than a
  // one-time wrap: serveStdio assigns `transport.onmessage` itself, and an
  // accessor keeps the tap installed even if the handler is reassigned later
  // (era pinning routes through the queue, but a future SDK could rewire it).
  // The getter rebuilds the wrapper per call so `lastActivity` is stamped at
  // delivery time, not at assignment time.
  const transport = new StdioServerTransport();
  type TransportOnMessage = NonNullable<StdioServerTransport['onmessage']>;
  let deliver: TransportOnMessage | undefined;
  Object.defineProperty(transport, 'onmessage', {
    configurable: true,
    get(): TransportOnMessage | undefined {
      if (!deliver) return undefined;
      return (message) => {
        lastActivity = Date.now();
        deliver?.(message);
      };
    },
    set(next: TransportOnMessage | undefined) {
      deliver = next;
    },
  });

  // serveStdio owns the transport: it selects the protocol era from the
  // opening exchange, pins one instance from the factory for the connection,
  // and serves both 2025- and 2026-era clients (legacy shim, default). For
  // stdio there is exactly one connection, so we start the process-level
  // background services the first time the factory builds a server — parity
  // with the old post-`initialized` hook, minus the stateful handshake dance
  // the 2026-07-28 spec removed.
  const handle = serveStdio(
    () => {
      const server = buildServer(services);
      if (!started) {
        started = true;
        background = startBackgroundServices(services, server.server);
      }
      return server;
    },
    { transport },
  );

  // Graceful shutdown.
  //
  // The spec puts shutdown on the client: over stdio it SHOULD initiate it by
  // "first, closing the input stream to the child process (the server)", then
  // "waiting for the server to exit" before escalating to SIGTERM and SIGKILL
  // (MCP basic/lifecycle, Shutdown). So EOF is the primary signal, not a
  // fallback — and the only one that survives a SIGKILLed client, since the
  // kernel closes the pipe either way, and the only one Windows has, lacking
  // POSIX signals. serveStdio closes its transport at EOF, but closing the
  // transport does not drain the event loop: the services above hold ref'd
  // handles (scheduler tick, hooks rate-limit timer, IMAP IDLE sockets), so
  // nothing observes EOF unless we listen for it here. Skipping that leaks an
  // immortal process on every client death that misses SIGTERM: closed
  // terminal, SIGKILL, crash, MCP reconnect.
  let shuttingDown = false;

  const shutdown = async (reason: string): Promise<void> => {
    // EOF, 'close' and a signal routinely arrive together.
    if (shuttingDown) return;
    shuttingDown = true;

    // A hung QUIT/LOGOUT must not resurrect the orphan this exists to prevent.
    // The valve is unref'd or it becomes the handle it was meant to release.
    setTimeout(() => {
      process.stderr.write(`[email-mcp] shutdown (${reason}) timed out — forcing exit\n`);
      // `process.exitCode` is the house style, but it only takes effect once the
      // loop drains, and a hung shutdown is exactly the case where it will not.
      // Throwing would surface as an uncaught exception from a timer rather than
      // a stop. Forcing the exit is what this valve is for.
      // eslint-disable-next-line n/no-process-exit
      process.exit(1);
    }, SHUTDOWN_GRACE_MS).unref();

    if (background) await background.stop();
    await services.connections.closeAll();
    await handle.close();
  };

  const requestShutdown = (reason: string): void => {
    void shutdown(reason);
  };

  // Listening for 'data' here would switch stdin to flowing mode and eat protocol
  // bytes from under the SDK; 'end'/'close' leave the stream's mode untouched.
  process.stdin.once('end', () => requestShutdown('stdin EOF'));
  process.stdin.once('close', () => requestShutdown('stdin closed'));

  process.on('SIGINT', () => requestShutdown('SIGINT'));
  process.on('SIGTERM', () => requestShutdown('SIGTERM'));
  process.on('SIGHUP', () => requestShutdown('SIGHUP'));

  if (idleExitSec > 0) {
    const idleMs = idleExitSec * 1_000;
    // Check often enough that short values fire close to their deadline (the
    // lifecycle test runs at 2s) and rarely enough that a 30-minute default
    // costs a handful of ticks: at most one tick of overshoot.
    const timer = setInterval(
      () => {
        if (Date.now() - lastActivity < idleMs) return;
        clearInterval(timer);
        process.stderr.write(
          `[email-mcp] no MCP requests for ${idleExitSec}s — exiting (settings.idle_exit = 0 keeps the server running)\n`,
        );
        requestShutdown(`idle ${idleExitSec}s`);
      },
      Math.max(1_000, Math.min(idleMs, 30_000)),
    );
    // Unref'd: the idle valve must never be the handle that keeps the process
    // alive — the same rule the shutdown grace valve follows above.
    timer.unref();
  }
}

async function main(): Promise<void> {
  const command = process.argv[2] ?? 'stdio';

  switch (command) {
    case 'stdio':
      await runServer();
      break;

    case 'http': {
      const { default: runHttp } = await import('./cli/http.js');
      await runHttp(process.argv.slice(3));
      break;
    }

    case 'setup': {
      const { default: runSetup } = await import('./cli/setup.js');
      await runSetup();
      break;
    }

    case 'account': {
      const { default: runAccountCommand } = await import('./cli/account-commands.js');
      await runAccountCommand(process.argv[3], process.argv[4]);
      break;
    }

    case 'test': {
      const { default: runTest } = await import('./cli/test.js');
      await runTest(process.argv[3]);
      break;
    }

    case 'config': {
      const { default: runConfigCommand } = await import('./cli/config-commands.js');
      await runConfigCommand(process.argv[3]);
      break;
    }

    case 'install': {
      const { default: runInstallCommand } = await import('./cli/install-commands.js');
      await runInstallCommand(process.argv[3]);
      break;
    }

    case 'keychain': {
      const { default: runKeychainCommand } = await import('./cli/keychain-commands.js');
      await runKeychainCommand(process.argv[3], process.argv[4]);
      break;
    }

    case 'scheduler': {
      const { default: runSchedulerCommand } = await import('./cli/scheduler.js');
      await runSchedulerCommand(process.argv[3]);
      break;
    }

    case 'notify': {
      const { default: runNotifyCommand } = await import('./cli/notify.js');
      await runNotifyCommand(process.argv[3]);
      break;
    }

    case '--version':
    case '-v':
      console.log(PKG_VERSION);
      break;

    case 'help':
    case '--help':
    case '-h':
      console.log(HELP);
      break;

    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      throw new Error(`Unknown command: ${command}`);
  }
}

main().catch((err) => {
  console.error('Fatal error:', err instanceof Error ? err.message : String(err));
  process.exitCode = 1;
});
