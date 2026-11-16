/**
 * Resolve the total base64-encoded attachment cap for an outbound message.
 *
 * Known providers get conservative defaults. The global setting can lower
 * those limits, while an account-level override is an explicit escape hatch
 * for self-hosted relays or plans with a higher limit.
 */

export const DEFAULT_SEND_LIMIT_MB = 25;

interface ProviderLimit {
  domains: string[];
  smtpHosts: string[];
  maxAttachmentMb: number;
}

const PROVIDER_LIMITS: ProviderLimit[] = [
  {
    domains: ['gmail.com', 'googlemail.com'],
    smtpHosts: ['smtp.gmail.com'],
    maxAttachmentMb: 25,
  },
  {
    domains: ['outlook.com', 'hotmail.com', 'live.com', 'outlook.de', 'outlook.co.uk'],
    smtpHosts: ['smtp.office365.com', 'smtp-mail.outlook.com'],
    maxAttachmentMb: 20,
  },
  {
    domains: ['yahoo.com', 'yahoo.co.uk', 'yahoo.de', 'ymail.com'],
    smtpHosts: ['smtp.mail.yahoo.com'],
    maxAttachmentMb: 25,
  },
  {
    domains: ['icloud.com', 'me.com', 'mac.com'],
    smtpHosts: ['smtp.mail.me.com'],
    maxAttachmentMb: 20,
  },
  {
    domains: ['fastmail.com', 'fastmail.fm'],
    smtpHosts: ['smtp.fastmail.com'],
    maxAttachmentMb: 50,
  },
  {
    domains: ['proton.me', 'protonmail.com', 'protonmail.ch', 'pm.me'],
    smtpHosts: ['127.0.0.1', 'localhost'],
    maxAttachmentMb: 25,
  },
  {
    domains: ['gmx.com', 'gmx.de', 'gmx.net', 'gmx.at', 'gmx.ch'],
    smtpHosts: ['mail.gmx.net'],
    maxAttachmentMb: 20,
  },
];

export interface SendLimitAccount {
  email: string;
  smtp: { host: string };
  maxAttachmentMb?: number;
}

function providerLimit(account: SendLimitAccount): number | undefined {
  const smtpHost = account.smtp.host.toLowerCase().replace(/\.$/, '');
  const emailDomain = account.email.split('@').at(-1)?.toLowerCase();

  // The configured SMTP host is the stronger signal: it also handles custom
  // email domains routed through a known provider.
  const byHost = PROVIDER_LIMITS.find((provider) => provider.smtpHosts.includes(smtpHost));
  if (byHost) return byHost.maxAttachmentMb;

  return PROVIDER_LIMITS.find((provider) => emailDomain && provider.domains.includes(emailDomain))
    ?.maxAttachmentMb;
}

/** Resolve the effective attachment limit in megabytes. */
export function resolveSendLimitMb(account: SendLimitAccount, globalMb: number): number {
  if (account.maxAttachmentMb !== undefined) return account.maxAttachmentMb;
  const providerMb = providerLimit(account);
  return providerMb === undefined ? globalMb : Math.min(globalMb, providerMb);
}
