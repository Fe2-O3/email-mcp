import type { EmailMeta } from '../types/index.js';
import { stripHtml } from '../utils/html.js';
import { stripReplyChain } from '../utils/reply-chain.js';
import { extractVerificationCode } from '../utils/verification-code.js';
import { extractMagicLink } from '../utils/verification-link.js';
import type ImapService from './imap.service.js';

const PRE_FILTER_RE =
  /\b(code|verif\w*|confirm\w*|sign.?in|log.?in|passcode|otp|2fa|one.?time|magic|auth\w*)\b/i;
const SUBJECT_CODE_RE = /(?<![A-Za-z0-9_-])\d{4,8}(?![A-Za-z0-9_-])/;

export interface VerificationHit {
  kind: 'code' | 'link';
  value: string;
  display: string;
  account: string;
  mailbox: string;
  date: string;
  from: string;
  subject: string;
  service: string;
  confidence?: 'high' | 'medium' | 'low';
}

export interface VerificationSearchOptions {
  accountNames: string[];
  mailbox: string;
  lookbackMinutes: number;
  maxMessages: number;
  includeMagicLinks: boolean;
}

function isVerificationCandidate(meta: EmailMeta): boolean {
  return (
    PRE_FILTER_RE.test(`${meta.subject} ${meta.from.address}`) || SUBJECT_CODE_RE.test(meta.subject)
  );
}

function fromLabel(meta: EmailMeta): string {
  return meta.from.name ? `${meta.from.name} <${meta.from.address}>` : meta.from.address;
}

function serviceLabel(meta: EmailMeta): string {
  return meta.from.name?.trim() || meta.from.address.split('@')[1] || meta.from.address;
}

function replyBody(bodyText?: string, bodyHtml?: string): string {
  const plain = bodyText ?? '';
  const htmlText = bodyHtml ? stripHtml(bodyHtml) : '';
  const useHtml = htmlText.length > plain.length * 1.5;
  return stripReplyChain(useHtml ? htmlText : plain || htmlText).slice(0, 20_000);
}

export default class VerificationService {
  constructor(private readonly imapService: ImapService) {}

  async findLatest(options: VerificationSearchOptions): Promise<VerificationHit | undefined> {
    const sinceMs = Date.now() - options.lookbackMinutes * 60_000;
    const since = new Date(sinceMs).toISOString();
    const candidates: Array<{ account: string; meta: EmailMeta }> = [];

    for (const account of options.accountNames) {
      // eslint-disable-next-line no-await-in-loop
      const page = await this.imapService.listEmails(account, {
        mailbox: options.mailbox,
        since,
        page: 1,
        pageSize: options.maxMessages,
        sort: 'date',
      });
      for (const meta of page.items) {
        const date = Date.parse(meta.date);
        if (
          Number.isFinite(date) &&
          date >= sinceMs &&
          date <= Date.now() &&
          isVerificationCandidate(meta)
        ) {
          candidates.push({ account, meta });
        }
      }
    }

    candidates.sort((a, b) => Date.parse(b.meta.date) - Date.parse(a.meta.date));
    for (const { account, meta } of candidates) {
      // eslint-disable-next-line no-await-in-loop
      const email = await this.imapService.getEmail(account, meta.id, options.mailbox);
      const body = replyBody(email.bodyText, email.bodyHtml);
      const code = extractVerificationCode(meta.subject, body);
      if (code) {
        return {
          kind: 'code',
          value: code.code,
          display: code.display,
          account,
          mailbox: options.mailbox,
          date: meta.date,
          from: fromLabel(meta),
          subject: meta.subject,
          service: serviceLabel(meta),
          confidence: code.confidence,
        };
      }

      if (options.includeMagicLinks) {
        const link = extractMagicLink({
          bodyHtml: email.bodyHtml,
          bodyText: body,
          senderAddress: meta.from.address,
        });
        if (link) {
          return {
            kind: 'link',
            value: link.link,
            display: link.link,
            account,
            mailbox: options.mailbox,
            date: meta.date,
            from: fromLabel(meta),
            subject: meta.subject,
            service: serviceLabel(meta),
          };
        }
      }
    }

    return undefined;
  }
}
