import BodyCache from '../cache/body-cache.js';
import CacheStore from '../cache/store.js';
import SyncEngine from '../cache/sync-engine.js';
import type { TestServices } from './helpers/index.js';
import {
  buildTestAccount,
  createTestServices,
  seedEmail,
  seedEmailWithAttachment,
  TEST_ACCOUNT_NAME,
  waitForDelivery,
} from './helpers/index.js';

/**
 * Read-through against a real server: the second read is served from the local
 * body cache plus a live FLAGS fetch, and must be indistinguishable from the
 * first except where the server's own state changed.
 */
describe('get_email read-through', () => {
  let services: TestServices;
  let store: CacheStore;
  let bodyCache: BodyCache;

  async function findId(subject: string): Promise<string> {
    const list = await services.imapService.listEmails(TEST_ACCOUNT_NAME, { subject });
    expect(list.items.length).toBeGreaterThanOrEqual(1);
    return list.items[0].id;
  }

  beforeAll(async () => {
    services = createTestServices(buildTestAccount());
    store = new CacheStore(':memory:');
    bodyCache = new BodyCache(store, 200);
    services.imapService.attachBodyCache(bodyCache, { offlineReads: true });

    await seedEmail({
      subject: 'RT multipart',
      text: 'plain version of the message',
      html: '<p>html version of the message</p>',
    });
    await seedEmail({ subject: 'RT plain', text: 'only plain text here' });
    await seedEmailWithAttachment('note.txt', 'attached words', { subject: 'RT attachment' });
    await waitForDelivery();
  });

  afterAll(async () => {
    await services.connections.closeAll();
    store.close();
  });

  it.each(['RT multipart', 'RT plain', 'RT attachment'])(
    'second read of "%s" equals the first exactly',
    async (subject) => {
      const id = await findId(subject);

      const first = await services.imapService.getEmail(TEST_ACCOUNT_NAME, id, 'INBOX');
      expect(first.offline).toBeUndefined();
      const second = await services.imapService.getEmail(TEST_ACCOUNT_NAME, id, 'INBOX');

      expect(second).toEqual(first);
    },
  );

  it('shows a flag set between reads', async () => {
    const id = await findId('RT plain');
    const before = await services.imapService.getEmail(TEST_ACCOUNT_NAME, id, 'INBOX');
    expect(before.flagged).toBe(false);

    await services.imapService.setFlags(TEST_ACCOUNT_NAME, id, 'INBOX', 'flag');
    const after = await services.imapService.getEmail(TEST_ACCOUNT_NAME, id, 'INBOX');

    expect(after.flagged).toBe(true);
    expect(after.bodyText).toBe(before.bodyText);
  });

  it('reports not-found for a message deleted after it was cached', async () => {
    await seedEmail({ subject: 'RT doomed', text: 'soon gone' });
    await waitForDelivery();
    const id = await findId('RT doomed');
    await services.imapService.getEmail(TEST_ACCOUNT_NAME, id, 'INBOX');

    await services.imapService.deleteEmail(TEST_ACCOUNT_NAME, id, 'INBOX', true);

    await expect(services.imapService.getEmail(TEST_ACCOUNT_NAME, id, 'INBOX')).rejects.toThrow(
      /not found/i,
    );
  });

  it('leaves the unseen count unchanged after reads and backfill', async () => {
    await seedEmail({ subject: 'RT unseen probe', text: 'must stay unread' });
    await waitForDelivery();
    const unseen = async () => {
      const boxes = await services.imapService.listMailboxes(TEST_ACCOUNT_NAME);
      return boxes.find((m) => m.path === 'INBOX')?.unseenMessages;
    };
    const before = await unseen();

    const id = await findId('RT unseen probe');
    await services.imapService.getEmail(TEST_ACCOUNT_NAME, id, 'INBOX');
    await services.imapService.getEmail(TEST_ACCOUNT_NAME, id, 'INBOX');

    const engine = new SyncEngine(
      services.connections,
      store,
      {},
      { cache: bodyCache, bodyMessages: 500, bodyMaxMb: 200, batch: 50 },
    );
    const result = await engine.syncMailbox(TEST_ACCOUNT_NAME, 'INBOX');
    engine.stop();

    expect(result.ok).toBe(true);
    expect(await unseen()).toBe(before);
  });
});
