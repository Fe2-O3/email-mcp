/**
 * NotifierService — multi-channel notification dispatcher.
 *
 * Routes email alerts to the appropriate channels based on urgency:
 * - Desktop notifications (native OS commands — zero npm deps)
 * - Sound alerts (via OS notification sound)
 * - MCP log level escalation (urgent→alert, high→warning, …)
 * - Webhook dispatch (HTTP POST to Slack/Discord/ntfy.sh/etc.)
 *
 * All channels are opt-in and disabled by default.
 */

import { execFile } from 'node:child_process';
import http from 'node:http';
import https from 'node:https';
import { mcpLog } from '../logging.js';
import { validateWebhookUrl } from '../safety/validation.js';
import { assertWebhookTargetAllowed, type ValidatedTarget } from '../safety/webhook-guard.js';

import type { AlertsConfig } from '../types/index.js';

export async function fetchWithPinnedTarget(
  url: string,
  pinned: ValidatedTarget,
  init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal },
): Promise<{ status: number; ok: boolean }> {
  const parsed = new URL(url);
  const isHttps = parsed.protocol === 'https:';
  const lib = isHttps ? https : http;

  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method: init.method,
        headers: init.headers,
        signal: init.signal,
        // Pin the connection to the validated address — do not resolve again.
        // Node's http may call lookup with all:true expecting an array; handle both.
        lookup: (
          _hostname: string,
          opts: { all?: boolean },
          cb: (
            err: Error | null,
            address: string | { address: string; family: number }[],
            family?: number,
          ) => void,
        ) => {
          if (opts.all) {
            cb(null, [{ address: pinned.address, family: pinned.family }]);
          } else {
            cb(null, pinned.address, pinned.family);
          }
        },
        ...(isHttps ? { servername: pinned.hostname } : {}),
      } as http.RequestOptions & { servername?: string; lookup?: typeof import('node:dns').lookup },
      (res) => {
        // Drain body — we only need status, and redirects are never followed
        // (manual), so no re-validation is needed.
        res.on('data', () => {});
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          resolve({ status, ok: status >= 200 && status < 300 });
        });
      },
    );

    req.on('error', reject);
    if (init.signal) {
      init.signal.addEventListener('abort', () => {
        req.destroy(new Error('aborted'));
      });
    }
    req.write(init.body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type UrgencyLevel = 'urgent' | 'high' | 'normal' | 'low';

export interface AlertPayload {
  account: string;
  sender: { name?: string; address: string };
  subject: string;
  priority: UrgencyLevel;
  labels?: string[];
  ruleName?: string;
  /**
   * Identity of the message, so a webhook consumer can call `get_email`
   * directly. Without uid + folder the only option is a search by subject and
   * timestamp, which is ambiguous whenever two messages share a subject.
   */
  uid?: string;
  messageId?: string;
  folder?: string;
  hasAttachments?: boolean;
}

export interface PlatformDiagnostics {
  platform: string;
  supported: boolean;
  desktopTool: { name: string; available: boolean };
  soundTool: { name: string; available: boolean };
  issues: string[];
  setupInstructions: string[];
}

// ---------------------------------------------------------------------------
// Priority ordering for threshold comparison
// ---------------------------------------------------------------------------

const URGENCY_ORDER: Record<UrgencyLevel, number> = {
  urgent: 4,
  high: 3,
  normal: 2,
  low: 1,
};

const MCP_LOG_LEVEL_MAP: Record<UrgencyLevel, 'alert' | 'warning' | 'info' | 'debug'> = {
  urgent: 'alert',
  high: 'warning',
  normal: 'info',
  low: 'debug',
};

// ---------------------------------------------------------------------------
// Text sanitization — prevent command injection in OS notifications
// ---------------------------------------------------------------------------

function sanitizeForShell(text: string): string {
  return text
    .replace(/[\\"'`$]/g, '')
    .replace(/[\n\r\t]/g, ' ')
    .replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, '')
    .slice(0, 200);
}

// ---------------------------------------------------------------------------
// NotifierService
// ---------------------------------------------------------------------------

export default class NotifierService {
  private config: AlertsConfig;

  private desktopCount = 0;

  private desktopResetTimer: ReturnType<typeof setInterval> | null = null;

  private static readonly MAX_DESKTOP_PER_MIN = 5;

  constructor(config: AlertsConfig) {
    this.config = config;

    // Reset desktop rate counter every 60s
    this.desktopResetTimer = setInterval(() => {
      this.desktopCount = 0;
    }, 60_000);
  }

  stop(): void {
    if (this.desktopResetTimer) {
      clearInterval(this.desktopResetTimer);
      this.desktopResetTimer = null;
    }
  }

  /** Returns the current alerts configuration. */
  getConfig(): AlertsConfig {
    return { ...this.config };
  }

  /**
   * Updates alert configuration at runtime (partial merge).
   *
   * Validates the webhook URL here rather than only at dispatch time, so a
   * rejected URL never becomes the live configuration — and, since callers
   * may persist config, never reaches the file either.
   */
  updateConfig(partial: Partial<AlertsConfig>): AlertsConfig {
    if (partial.webhookUrl !== undefined && partial.webhookUrl !== '') {
      validateWebhookUrl(partial.webhookUrl);
    }
    this.config = { ...this.config, ...partial };
    return this.getConfig();
  }

  // -------------------------------------------------------------------------
  // Platform diagnostics — check if notification tools are available
  // -------------------------------------------------------------------------

  static async checkPlatformSupport(): Promise<PlatformDiagnostics> {
    const { platform } = process;
    const issues: string[] = [];
    const instructions: string[] = [];

    if (platform === 'darwin') {
      const osascriptOk = await NotifierService.commandExists('osascript');
      const afplayOk = await NotifierService.commandExists('afplay');

      if (!osascriptOk) issues.push('osascript not found (should be built-in on macOS)');

      instructions.push(
        '1. Open System Settings → Notifications & Focus',
        '2. Find your terminal app (Terminal, iTerm2, VS Code, Cursor, etc.)',
        '3. Enable "Allow Notifications" and choose "Banners" or "Alerts"',
        '4. Ensure "Do Not Disturb" / Focus mode is not active',
        '5. If using an MCP client, the notification appears from the terminal running the server',
      );

      return {
        platform: 'macOS',
        supported: osascriptOk,
        desktopTool: { name: 'osascript', available: osascriptOk },
        soundTool: { name: 'afplay', available: afplayOk },
        issues,
        setupInstructions: instructions,
      };
    }

    if (platform === 'linux') {
      const notifySendOk = await NotifierService.commandExists('notify-send');
      const paplayOk = await NotifierService.commandExists('paplay');

      if (!notifySendOk) {
        issues.push('notify-send not found');
        instructions.push(
          'Install libnotify:',
          '  Ubuntu/Debian: sudo apt install libnotify-bin',
          '  Fedora:        sudo dnf install libnotify',
          '  Arch:          sudo pacman -S libnotify',
        );
      }
      if (!paplayOk) {
        issues.push('paplay not found (needed for sound alerts)');
        instructions.push(
          'Install PulseAudio utils for sound:',
          '  Ubuntu/Debian: sudo apt install pulseaudio-utils',
          '  Fedora:        sudo dnf install pulseaudio-utils',
        );
      }

      instructions.push(
        'Note: Desktop notifications require a running display server (X11/Wayland).',
        'They will not work in headless/SSH sessions.',
      );

      return {
        platform: 'Linux',
        supported: notifySendOk,
        desktopTool: { name: 'notify-send', available: notifySendOk },
        soundTool: { name: 'paplay', available: paplayOk },
        issues,
        setupInstructions: instructions,
      };
    }

    if (platform === 'win32') {
      const psOk = await NotifierService.commandExists('powershell');

      if (!psOk) issues.push('PowerShell not found');

      instructions.push(
        '1. Open Settings → System → Notifications',
        '2. Ensure "Notifications" is turned on',
        '3. Ensure "Focus Assist" is set to allow notifications',
        '4. If using Windows Terminal, ensure its notifications are enabled',
      );

      return {
        platform: 'Windows',
        supported: psOk,
        desktopTool: { name: 'powershell', available: psOk },
        soundTool: { name: 'powershell', available: psOk },
        issues,
        setupInstructions: instructions,
      };
    }

    return {
      platform,
      supported: false,
      desktopTool: { name: 'unknown', available: false },
      soundTool: { name: 'unknown', available: false },
      issues: [`Unsupported platform: ${platform}. Desktop notifications are not available.`],
      setupInstructions: ['Desktop notifications are only supported on macOS, Linux, and Windows.'],
    };
  }

  /** Test if a command-line tool exists on the system. */
  private static async commandExists(cmd: string): Promise<boolean> {
    const bin = process.platform === 'win32' ? 'where' : 'which';
    return new Promise((resolve) => {
      execFile(bin, [cmd], { timeout: 3000 }, (err) => {
        resolve(!err);
      });
    });
  }

  /** Send a test notification to verify platform setup. */
  async sendTestNotification(withSound = false): Promise<{ success: boolean; message: string }> {
    const diag = await NotifierService.checkPlatformSupport();
    if (!diag.supported) {
      return {
        success: false,
        message: `Desktop notifications not supported: ${diag.issues.join('; ')}`,
      };
    }

    // Temporarily force desktop + sound for the test
    const origDesktop = this.config.desktop;
    const origSound = this.config.sound;
    this.config.desktop = true;
    this.config.sound = withSound;

    try {
      const testPayload: AlertPayload = {
        account: 'test',
        sender: { name: 'IMAP Wizard', address: 'test@email-mcp' },
        subject: 'If you see this, notifications work!',
        priority: 'urgent',
      };
      await this.sendDesktopNotification(testPayload);
      return {
        success: true,
        message: withSound
          ? 'Test notification sent with sound. Check your notification center.'
          : 'Test notification sent. Check your notification center.',
      };
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        message: `Notification failed: ${errMsg}. Check platform setup instructions.`,
      };
    } finally {
      this.config.desktop = origDesktop;
      this.config.sound = origSound;
    }
  }

  // -------------------------------------------------------------------------
  // Main dispatch — routes alert to channels based on urgency + config
  // -------------------------------------------------------------------------

  async alert(payload: AlertPayload, forceDesktop = false): Promise<void> {
    const meetsThreshold =
      URGENCY_ORDER[payload.priority] >= URGENCY_ORDER[this.config.urgencyThreshold];

    // 1. MCP log — always, with appropriate level
    const logLevel = MCP_LOG_LEVEL_MAP[payload.priority];
    const icon = payload.priority === 'urgent' ? '🚨' : '📧';
    const logMsg = `${icon} [${payload.priority.toUpperCase()}] ${payload.sender.name ?? payload.sender.address}: "${payload.subject}"${
      payload.labels?.length ? ` [${payload.labels.join(', ')}]` : ''
    }${payload.ruleName ? ` (rule: ${payload.ruleName})` : ''}`;
    await mcpLog(logLevel, 'notifier', logMsg);

    // 2. Desktop notification — if enabled + meets threshold (or forced by rule)
    if (this.config.desktop && (meetsThreshold || forceDesktop)) {
      await this.sendDesktopNotification(payload);
    }

    // 3. Webhook — if configured + meets webhook event filter
    if (this.config.webhookUrl && this.config.webhookEvents.includes(payload.priority)) {
      this.sendWebhook(payload).catch(() => {});
    }
  }

  // -------------------------------------------------------------------------
  // Desktop notification — native OS commands, zero npm deps
  // -------------------------------------------------------------------------

  private async sendDesktopNotification(payload: AlertPayload): Promise<void> {
    if (this.desktopCount >= NotifierService.MAX_DESKTOP_PER_MIN) return;
    this.desktopCount += 1;

    const title = sanitizeForShell(
      `📧 IMAP Wizard — ${payload.priority === 'urgent' ? 'Urgent' : 'Important'}`,
    );
    const senderDisplay = sanitizeForShell(payload.sender.name ?? payload.sender.address);
    const subject = sanitizeForShell(payload.subject);
    const body = `From: ${senderDisplay}\n${subject}`;
    const playSound = this.config.sound && payload.priority === 'urgent';

    const { platform } = process;

    try {
      if (platform === 'darwin') {
        await NotifierService.execDarwin(title, body, playSound);
      } else if (platform === 'linux') {
        await NotifierService.execLinux(title, body, playSound);
      } else if (platform === 'win32') {
        await NotifierService.execWindows(title, body);
      }
    } catch {
      // Desktop notification failure is non-fatal — silently degrade to MCP log only
    }
  }

  private static async execDarwin(title: string, body: string, sound: boolean): Promise<void> {
    const soundClause = sound ? ' sound name "Glass"' : '';
    const script = `display notification "${body}" with title "${title}"${soundClause}`;
    await NotifierService.execCommand('osascript', ['-e', script]);
  }

  private static async execLinux(title: string, body: string, sound: boolean): Promise<void> {
    const urgency = sound ? 'critical' : 'normal';
    await NotifierService.execCommand('notify-send', ['-u', urgency, title, body]);
    if (sound) {
      try {
        await NotifierService.execCommand('paplay', [
          '/usr/share/sounds/freedesktop/stereo/message-new-instant.oga',
        ]);
      } catch {
        // Sound playback failure is non-fatal
      }
    }
  }

  private static async execWindows(title: string, body: string): Promise<void> {
    const ps =
      `[System.Reflection.Assembly]::LoadWithPartialName('System.Windows.Forms'); ` +
      `$n = New-Object System.Windows.Forms.NotifyIcon; ` +
      `$n.Icon = [System.Drawing.SystemIcons]::Information; ` +
      `$n.Visible = $true; ` +
      `$n.ShowBalloonTip(5000, '${title}', '${body}', 'Info')`;
    await NotifierService.execCommand('powershell', ['-Command', ps]);
  }

  private static async execCommand(bin: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      execFile(bin, args, { timeout: 5000 }, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  // -------------------------------------------------------------------------
  // Webhook dispatch — HTTP POST with JSON payload
  // -------------------------------------------------------------------------

  private async sendWebhook(payload: AlertPayload): Promise<void> {
    if (!this.config.webhookUrl) return;

    let pinned: ValidatedTarget;
    try {
      validateWebhookUrl(this.config.webhookUrl);
      // The synchronous checks above see the hostname as text. This resolves
      // it and range-checks every address, so a name answering in private
      // space is refused before anything goes out. The returned target is
      // pinned — dispatch uses it, not a fresh lookup, closing the rebinding
      // window between check and connect.
      pinned = await assertWebhookTargetAllowed(this.config.webhookUrl);
    } catch (err) {
      await mcpLog(
        'warning',
        'notifier',
        `Invalid webhook URL: ${err instanceof Error ? err.message : String(err)}`,
      );
      return;
    }

    const body = JSON.stringify({
      event: `email.${payload.priority}`,
      account: payload.account,
      sender: payload.sender,
      subject: payload.subject,
      priority: payload.priority,
      labels: payload.labels ?? [],
      rule: payload.ruleName ?? null,
      uid: payload.uid ?? null,
      messageId: payload.messageId ?? null,
      folder: payload.folder ?? null,
      hasAttachments: payload.hasAttachments ?? null,
      timestamp: new Date().toISOString(),
    });

    const controller = new AbortController();
    const timeout = setTimeout(() => {
      controller.abort();
    }, 5000);

    try {
      const resp = await fetchWithPinnedTarget(this.config.webhookUrl, pinned, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: controller.signal,
      });
      if (resp.status >= 300 && resp.status < 400) {
        await mcpLog('warning', 'notifier', `Webhook redirect refused (${resp.status})`);
      } else if (!resp.ok) {
        await mcpLog('warning', 'notifier', `Webhook returned ${resp.status}`);
      }
    } catch {
      await mcpLog('debug', 'notifier', 'Webhook dispatch failed (non-fatal)');
    } finally {
      clearTimeout(timeout);
    }
  }
}
