/**
 * Watcher & Hooks tools.
 *
 * Split into read and write halves (mirroring templates.tool.ts): inspecting
 * watcher status, presets and config is always available, while firing test
 * notifications and reconfiguring alerts are write operations and disappear
 * in read-only mode.
 */

import type { McpServer } from '@modelcontextprotocol/server';
import { z } from 'zod';
import audit from '../safety/audit.js';
import type HooksService from '../services/hooks.service.js';
import NotifierService from '../services/notifier.service.js';
import { listPresets as listAllPresets } from '../services/presets.js';
import type WatcherService from '../services/watcher.service.js';
import type { AlertsConfig } from '../types/index.js';

export function registerWatcherReadTools(
  server: McpServer,
  watcherService: WatcherService,
  hooksService: HooksService,
): void {
  const hooksConfig = hooksService.getHooksConfig();
  // -------------------------------------------------------------------------
  // get_watcher_status — read
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_watcher_status',
    {
      title: 'Get watcher status',
      description: 'Get the status of IMAP IDLE watcher connections and recent activity.',
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const status = watcherService.getStatus();

      if (status.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'Watcher is not active. Enable it in config: [settings.watcher] enabled = true',
            },
          ],
        };
      }

      const lines = status.map((s) => {
        const icon = s.connected ? '🟢 connected' : '🔴 disconnected';
        return `• ${s.account}/${s.folder}: ${icon} (last UID: ${s.lastSeenUid})`;
      });

      return {
        content: [
          {
            type: 'text' as const,
            text: `📡 Watcher Status (${status.length} connection(s)):\n${lines.join('\n')}`,
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // list_presets — read
  // -------------------------------------------------------------------------

  server.registerTool(
    'list_presets',
    {
      title: 'List presets',
      description:
        'List all available AI triage presets with their descriptions and suggested labels.',
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const presets = listAllPresets();
      const activePreset = hooksConfig.preset;

      const lines = presets.map((p) => {
        const active = p.id === activePreset ? ' ✅ (active)' : '';
        const labels =
          p.suggestedLabels.length > 0 ? `\n     Labels: ${p.suggestedLabels.join(', ')}` : '';
        return `• ${p.name} [${p.id}]${active}\n     ${p.description}${labels}`;
      });

      return {
        content: [
          {
            type: 'text' as const,
            text:
              `🎯 Available Hook Presets:\n\n${lines.join('\n\n')}` +
              `\n\nTo change preset, set \`preset = "${activePreset}"\` in [settings.hooks] of your config.toml.`,
          },
        ],
      };
    },
  );

  // -------------------------------------------------------------------------
  // get_hooks_config — read
  // -------------------------------------------------------------------------

  server.registerTool(
    'get_hooks_config',
    {
      title: 'Get hooks config',
      description:
        'Get the current AI hooks configuration including preset, rules, and custom instructions.',
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const sections: string[] = [
        `⚙️  Hooks Configuration:`,
        `   Mode:     ${hooksConfig.onNewEmail}`,
        `   Preset:   ${hooksConfig.preset}`,
        `   Labels:   ${hooksConfig.autoLabel ? 'auto-apply' : 'disabled'}`,
        `   Flags:    ${hooksConfig.autoFlag ? 'auto-flag' : 'disabled'}`,
        `   Batch:    ${hooksConfig.batchDelay}s delay`,
      ];

      if (hooksConfig.customInstructions) {
        sections.push(
          `\n📝 Custom Instructions:\n   ${hooksConfig.customInstructions.replace(/\n/g, '\n   ')}`,
        );
      }

      if (hooksConfig.rules.length > 0) {
        sections.push(`\n📋 Static Rules (${hooksConfig.rules.length}):`);
        hooksConfig.rules.forEach((rule) => {
          const matchParts: string[] = [];
          if (rule.match.from) matchParts.push(`from=${rule.match.from}`);
          if (rule.match.to) matchParts.push(`to=${rule.match.to}`);
          if (rule.match.subject) matchParts.push(`subject=${rule.match.subject}`);

          const actionParts: string[] = [];
          if (rule.actions.labels?.length) {
            actionParts.push(`labels=[${rule.actions.labels.join(', ')}]`);
          }
          if (rule.actions.flag) actionParts.push('flag');
          if (rule.actions.markRead) actionParts.push('mark_read');
          if (rule.actions.alert) actionParts.push('🔔 alert');

          sections.push(
            `   • "${rule.name}": ${matchParts.join(' & ')} → ${actionParts.join(', ')}`,
          );
        });
      } else {
        sections.push('\n📋 Static Rules: none configured');
      }

      // Alerts config
      const { alerts } = hooksConfig;
      sections.push(`\n🔔 Alerts:`);
      sections.push(`   Desktop:   ${alerts.desktop ? '✅ enabled' : '❌ disabled'}`);
      sections.push(`   Sound:     ${alerts.sound ? '✅ enabled' : '❌ disabled'}`);
      sections.push(`   Threshold: ${alerts.urgencyThreshold}`);
      if (alerts.webhookUrl) {
        sections.push(`   Webhook:   ${alerts.webhookUrl}`);
        sections.push(`   Events:    ${alerts.webhookEvents.join(', ')}`);
      } else {
        sections.push(`   Webhook:   not configured`);
      }

      return {
        content: [{ type: 'text' as const, text: sections.join('\n') }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // check_notification_setup — diagnose platform support
  // -------------------------------------------------------------------------

  server.registerTool(
    'check_notification_setup',
    {
      title: 'Check notification setup',
      description:
        'Diagnose desktop notification support on this platform. ' +
        'Checks if required OS tools are available and provides setup instructions ' +
        'to enable notification permissions (macOS, Linux, Windows).',
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      const diag = await NotifierService.checkPlatformSupport();
      const notifier = hooksService.getNotifier();
      const alertsCfg = notifier.getConfig();

      const lines: string[] = [
        `🔍 Notification Setup Diagnostics`,
        ``,
        `Platform:    ${diag.platform}`,
        `Desktop:     ${diag.desktopTool.name} — ${diag.desktopTool.available ? '✅ available' : '❌ not found'}`,
        `Sound:       ${diag.soundTool.name} — ${diag.soundTool.available ? '✅ available' : '❌ not found'}`,
        `Supported:   ${diag.supported ? '✅ yes' : '❌ no'}`,
      ];

      if (diag.issues.length > 0) {
        lines.push('', '⚠️  Issues:');
        diag.issues.forEach((issue: string) => {
          lines.push(`   • ${issue}`);
        });
      }

      lines.push('', '📋 Setup Instructions:');
      diag.setupInstructions.forEach((instr: string) => {
        lines.push(`   ${instr}`);
      });

      lines.push(
        '',
        '⚙️  Current Config:',
        `   Desktop:   ${alertsCfg.desktop ? '✅ enabled' : '❌ disabled'}`,
        `   Sound:     ${alertsCfg.sound ? '✅ enabled' : '❌ disabled'}`,
        `   Threshold: ${alertsCfg.urgencyThreshold}`,
        alertsCfg.webhookUrl
          ? `   Webhook:   ${alertsCfg.webhookUrl}`
          : '   Webhook:   not configured',
      );

      if (!alertsCfg.desktop && diag.supported) {
        lines.push(
          '',
          '💡 Tip: Desktop notifications are supported but disabled.',
          '   Use configure_alerts to enable them, or set desktop = true in config.toml.',
        );
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );
}

/**
 * Write tools — skipped in read-only mode. Both mutate process or OS state
 * (a desktop notification, the alert routing), so they sit behind the same
 * gate as every other write tool.
 */
export function registerWatcherWriteTools(server: McpServer, hooksService: HooksService): void {
  const hooksConfig = hooksService.getHooksConfig();

  // -------------------------------------------------------------------------
  // test_notification — send a test notification
  // -------------------------------------------------------------------------

  server.registerTool(
    'test_notification',
    {
      title: 'Test notification',
      description:
        'Send a test desktop notification to verify that OS permissions are correctly configured. ' +
        'Use check_notification_setup first to diagnose any issues.',
      inputSchema: z.object({
        sound: z
          .boolean()
          .default(false)
          .describe('Include a sound alert in the test notification'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({ sound }) => {
      const notifier = hooksService.getNotifier();
      const result = await notifier.sendTestNotification(sound);

      await audit.log('test_notification', 'system', { sound }, result.success ? 'ok' : 'error');

      const icon = result.success ? '✅' : '❌';
      const lines = [`${icon} ${result.message}`];

      if (!result.success) {
        const diag = await NotifierService.checkPlatformSupport();
        lines.push('', '🔧 Troubleshooting:');
        diag.setupInstructions.forEach((instr: string) => {
          lines.push(`   ${instr}`);
        });
      }

      return {
        content: [{ type: 'text' as const, text: lines.join('\n') }],
      };
    },
  );

  // -------------------------------------------------------------------------
  // configure_alerts — runtime alert configuration
  // -------------------------------------------------------------------------

  server.registerTool(
    'configure_alerts',
    {
      title: 'Configure alerts',
      description:
        'Update alert/notification settings for this session. Changes take effect immediately ' +
        'but are never written to the config file; edit config.toml directly to persist them. ' +
        'Omit any field to leave it unchanged.',
      inputSchema: z.object({
        desktop: z.boolean().optional().describe('Enable/disable desktop notifications'),
        sound: z.boolean().optional().describe('Enable/disable sound alerts for urgent emails'),
        urgency_threshold: z
          .enum(['urgent', 'high', 'normal', 'low'])
          .optional()
          .describe('Minimum urgency level to trigger desktop notifications'),
        webhook_url: z
          .string()
          .optional()
          .describe('Webhook URL for external notifications (empty string to disable)'),
        webhook_events: z
          .array(z.enum(['urgent', 'high', 'normal', 'low']))
          .optional()
          .describe('Which urgency levels trigger webhook dispatch'),
      }),
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async ({
      desktop,
      sound,
      urgency_threshold: urgencyThreshold,
      webhook_url: webhookUrl,
      webhook_events: webhookEvents,
    }) => {
      try {
        const notifier = hooksService.getNotifier();

        // Build partial update from provided fields
        const partial: Record<string, unknown> = {};
        if (desktop !== undefined) partial.desktop = desktop;
        if (sound !== undefined) partial.sound = sound;
        if (urgencyThreshold !== undefined) partial.urgencyThreshold = urgencyThreshold;
        if (webhookUrl !== undefined) partial.webhookUrl = webhookUrl;
        if (webhookEvents !== undefined) partial.webhookEvents = webhookEvents;

        if (Object.keys(partial).length === 0) {
          const current = notifier.getConfig();
          return {
            content: [
              {
                type: 'text' as const,
                text:
                  `No changes specified. Current config:\n` +
                  `  Desktop:   ${current.desktop ? '✅' : '❌'}\n` +
                  `  Sound:     ${current.sound ? '✅' : '❌'}\n` +
                  `  Threshold: ${current.urgencyThreshold}\n` +
                  `  Webhook:   ${current.webhookUrl || '(none)'}\n` +
                  `  Events:    ${current.webhookEvents.join(', ')}`,
              },
            ],
          };
        }

        // Apply runtime update. updateConfig rejects a webhook URL that fails
        // the safety validation, so a rejected URL never takes effect here.
        const updated = notifier.updateConfig(partial as Partial<AlertsConfig>);

        // Also update the in-memory hooks config alerts reference
        hooksConfig.alerts = { ...updated };

        await audit.log(
          'configure_alerts',
          'system',
          {
            desktop: updated.desktop,
            sound: updated.sound,
            urgencyThreshold: updated.urgencyThreshold,
            webhookUrl: updated.webhookUrl,
            webhookEvents: updated.webhookEvents,
          },
          'ok',
        );

        const lines = [
          '✅ Alerts configuration updated (this session only):',
          `   Desktop:   ${updated.desktop ? '✅ enabled' : '❌ disabled'}`,
          `   Sound:     ${updated.sound ? '✅ enabled' : '❌ disabled'}`,
          `   Threshold: ${updated.urgencyThreshold}`,
          `   Webhook:   ${updated.webhookUrl || '(none)'}`,
          `   Events:    ${updated.webhookEvents.join(', ')}`,
          '\nEdit config.toml to persist changes across restarts.',
        ];

        return {
          content: [{ type: 'text' as const, text: lines.join('\n') }],
        };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await audit.log('configure_alerts', 'system', {}, 'error', message).catch(() => {
          /* logging must not mask the original failure */
        });
        return {
          isError: true,
          content: [
            {
              type: 'text' as const,
              text: `Failed to update alerts config: ${message}`,
            },
          ],
        };
      }
    },
  );
}
