/**
 * A Dovecot + Pigeonhole container for the ManageSieve integration test, in the
 * style of the GreenMail setup (globalSetup.ts), but started by the test file
 * itself so the other integration tests do not pay for it.
 *
 * Image: dovecot/dovecot:2.3.21, the official Dovecot image. Its 2.3 builds ship
 * managesieved and the Pigeonhole Sieve plugin. The image's own config is
 * replaced by DOVECOT_CONF below: any user logs in with the password "test",
 * IMAP on 143, ManageSieve on 4190, both plain text.
 *
 * Plain text is deliberate and only works because the client allows it to a
 * loopback host: testcontainers maps the ports to `localhost` on CI runners. On
 * a Docker host that is not loopback the client refuses to log in, by design.
 */

import type { StartedTestContainer } from 'testcontainers';
import { GenericContainer, Wait } from 'testcontainers';

export const DOVECOT_IMAGE = 'dovecot/dovecot:2.3.21';
const SIEVE_PORT = 4190;
const IMAP_PORT = 143;

export const DOVECOT_PASSWORD = 'test';

const DOVECOT_CONF = `
protocols = imap sieve
listen = *
log_path = /dev/stderr
info_log_path = /dev/stdout
ssl = no
disable_plaintext_auth = no
auth_mechanisms = plain login

mail_uid = 1000
mail_gid = 1000
first_valid_uid = 1000
last_valid_uid = 1000
mail_home = /tmp/mail/%Lu
mail_location = maildir:~/Maildir

passdb {
  driver = static
  args = password=${DOVECOT_PASSWORD}
}
userdb {
  driver = static
  args = uid=1000 gid=1000 home=/tmp/mail/%Lu
}

namespace inbox {
  inbox = yes
  separator = /
  mailbox Archive {
    auto = create
  }
}

service imap-login {
  inet_listener imap {
    port = ${IMAP_PORT}
  }
}
service managesieve-login {
  inet_listener sieve {
    port = ${SIEVE_PORT}
  }
}

plugin {
  sieve = file:~/sieve;active=~/.dovecot.sieve
}
`;

export interface DovecotSieve {
  host: string;
  sievePort: number;
  imapPort: number;
  stop: () => Promise<void>;
}

export async function startDovecotSieve(): Promise<DovecotSieve> {
  const container: StartedTestContainer = await new GenericContainer(DOVECOT_IMAGE)
    .withExposedPorts(SIEVE_PORT, IMAP_PORT)
    .withCopyContentToContainer([{ content: DOVECOT_CONF, target: '/etc/dovecot/dovecot.conf' }])
    .withWaitStrategy(Wait.forListeningPorts())
    .withStartupTimeout(120_000)
    .start();
  return {
    host: container.getHost(),
    sievePort: container.getMappedPort(SIEVE_PORT),
    imapPort: container.getMappedPort(IMAP_PORT),
    stop: async () => {
      await container.stop();
    },
  };
}
