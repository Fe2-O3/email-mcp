import type { RawAppConfig } from './schema.js';
import { AppConfigFileSchema } from './schema.js';
import { findConsistencyIssues, findUnknownKeys } from './validate.js';

function fullRaw(overrides?: (raw: RawAppConfig) => void): RawAppConfig {
  const raw = AppConfigFileSchema.parse({
    accounts: [
      {
        name: 'personal',
        email: 'user@example.com',
        password: 'secret',
        imap: { host: 'imap.example.com' },
        smtp: { host: 'smtp.example.com' },
      },
    ],
  });
  overrides?.(raw);
  return raw;
}

describe('findUnknownKeys', () => {
  it('accepts a fully populated valid config with every optional set', () => {
    const raw = {
      settings: {
        rate_limit: 10,
        idle_exit: 1800,
        read_only: false,
        watcher: { enabled: true, folders: ['INBOX'], idle_timeout: 900 },
        cache: {
          enabled: true,
          mailboxes: ['INBOX'],
          window_days: 90,
          body_messages: 500,
          max_size_mb: 500,
          sync_interval: 300,
        },
        hooks: {
          on_new_email: 'notify',
          preset: 'custom',
          auto_label: false,
          auto_flag: false,
          batch_delay: 5,
          custom_instructions: 'x',
          system_prompt: 'y',
          auto_calendar: false,
          calendar_name: '',
          calendar_alarm_minutes: 15,
          calendar_confirm: true,
          rules: [
            {
              name: 'r',
              match: { from: 'a', to: 'b', subject: 'c' },
              actions: {
                labels: ['l'],
                flag: true,
                mark_read: true,
                alert: true,
                add_to_calendar: false,
              },
            },
          ],
          alerts: {
            desktop: true,
            sound: true,
            urgency_threshold: 'high',
            webhook_url: '',
            webhook_events: ['urgent'],
          },
        },
      },
      accounts: [
        {
          name: 'a',
          email: 'a@b.c',
          full_name: 'A',
          username: 'a',
          password: 'p',
          oauth2: {
            provider: 'google',
            client_id: 'i',
            client_secret: 's',
            refresh_token: 'r',
            token_url: 'https://t',
            auth_url: 'https://a',
            scopes: ['s'],
          },
          imap: { host: 'h', port: 1, tls: true, starttls: false, verify_ssl: true },
          smtp: {
            host: 'h',
            port: 1,
            tls: true,
            starttls: false,
            verify_ssl: true,
            pool: { enabled: true, max_connections: 1, max_messages: 100 },
          },
        },
      ],
    };

    expect(findUnknownKeys(raw)).toEqual([]);
  });

  it('flags a typo with a did-you-mean suggestion', () => {
    const raw = {
      settings: { hooks: { auto_labek: true } },
      accounts: [],
    };

    const unknown = findUnknownKeys(raw);
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.path).toBe('settings.hooks.auto_labek');
    expect(unknown[0]?.suggestion).toBe('auto_label');
  });

  it('flags unknown keys inside array tables (accounts, rules)', () => {
    const raw = {
      settings: {
        hooks: { rules: [{ name: 'r', match: { form: 'x' }, actions: {} }] },
      },
      accounts: [{ name: 'a', emial: 'x@y.z' }],
    };

    const paths = findUnknownKeys(raw).map(
      (u) => `${u.path}${u.suggestion ? `→${u.suggestion}` : ''}`,
    );
    expect(paths).toContain('settings.hooks.rules[0].match.form→from');
    expect(paths).toContain('accounts[0].emial→email');
  });

  it('flags unknown top-level and settings-level keys', () => {
    const unknown = findUnknownKeys({ setings: {}, settings: { watcherr: {} }, accounts: [] });
    const paths = unknown.map((u) => u.path);
    expect(paths).toContain('setings');
    expect(paths).toContain('settings.watcherr');
  });
});

describe('findConsistencyIssues', () => {
  it('returns nothing for a coherent config', () => {
    const raw = fullRaw((r) => {
      r.settings.watcher.enabled = true;
    });
    expect(findConsistencyIssues(raw)).toEqual([]);
  });

  it('warns when hooks are active but the watcher is off', () => {
    const raw = fullRaw((r) => {
      r.settings.hooks.on_new_email = 'triage';
    });
    const issues = findConsistencyIssues(raw);
    expect(issues.some((i) => i.message.includes('hooks'))).toBe(true);
  });

  it('stays quiet when hooks are off and the watcher is off', () => {
    const raw = fullRaw((r) => {
      r.settings.hooks.on_new_email = 'none';
    });
    expect(findConsistencyIssues(raw)).toEqual([]);
  });

  it('errors on duplicate account names', () => {
    const raw = fullRaw((r) => {
      r.settings.watcher.enabled = true;
      r.accounts.push({ ...r.accounts[0] } as (typeof r.accounts)[0]);
    });
    const issues = findConsistencyIssues(raw);
    expect(issues.some((i) => i.severity === 'error' && i.message.includes('personal'))).toBe(true);
  });

  it('warns when the watcher is enabled with no folders', () => {
    const raw = fullRaw((r) => {
      r.settings.watcher.enabled = true;
      r.settings.watcher.folders = [];
    });
    const issues = findConsistencyIssues(raw);
    expect(issues.some((i) => i.message.includes('folders'))).toBe(true);
  });
});
