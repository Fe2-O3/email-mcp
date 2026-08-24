import type { ImapFlow } from 'imapflow';
import type { Transporter } from 'nodemailer';
import type { AccountConfig } from '../types/index.js';

export interface IConnectionManager {
  getAccount: (name: string) => AccountConfig;
  getAccountNames: () => string[];
  getImapClient: (accountName: string) => Promise<ImapFlow>;
  getSmtpTransport: (accountName: string, options?: { verify?: boolean }) => Promise<Transporter>;
  /** Drop the cached SMTP transport for an account so the next call dials fresh. */
  invalidateSmtpTransport: (accountName: string) => void;
  closeAll: () => Promise<void>;
}
