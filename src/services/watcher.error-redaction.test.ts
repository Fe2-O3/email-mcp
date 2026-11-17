import type { AccountConfig, WatcherConfig } from '../types/index.js';
import WatcherService from './watcher.service.js';

const PASSWORD = 'Hunter2-Sup3r-Secret';

const { logs } = vi.hoisted(() => ({ logs: [] as string[] }));

vi.mock('imapflow', () => {
  class MockImapFlow {
    connect = vi.fn().mockRejectedValue(new Error('NO LOGIN failed for Hunter2-Sup3r-Secret'));

    logout = vi.fn().mockResolvedValue(undefined);

    close = vi.fn();

    on = vi.fn();
  }
  return { ImapFlow: MockImapFlow };
});

vi.mock('../logging.js', () => ({
  mcpLog: vi.fn(async (_level: string, _logger: string, message: string) => {
    logs.push(message);
  }),
}));

vi.mock('./event-bus.js', () => ({ default: { emit: vi.fn() } }));

const account: AccountConfig = {
  name: 'work',
  email: 'me@example.invalid',
  username: 'me@example.invalid',
  password: PASSWORD,
  imap: { host: 'imap.example.invalid', port: 993, tls: true, starttls: false, verifySsl: true },
  smtp: { host: 'smtp.example.invalid', port: 465, tls: true, starttls: false, verifySsl: true },
};

describe('WatcherService error redaction', () => {
  it('redacts the password from the logged IDLE connect failure', async () => {
    const config: WatcherConfig = { enabled: true, folders: ['INBOX'], idleTimeout: 1740 };
    const watcher = new WatcherService(config, [account]);
    await watcher.start();

    const line = logs.find((l) => l.includes('IDLE connect failed'));
    expect(line).toBeDefined();
    expect(line).not.toContain(PASSWORD);
    expect(line).toContain('[redacted]');

    await watcher.stop();
  });
});
