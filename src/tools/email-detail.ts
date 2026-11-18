/**
 * The structuredContent form of one message, shared by get_email, get_emails and get_thread.
 * Fields are raw JSON values; the untrusted-content markers belong to the text output only.
 */

import type { Email } from '../types/index.js';

export default function toEmailDetail(email: Email, id: string, body?: string) {
  return {
    id,
    messageId: email.messageId,
    subject: email.subject,
    from: email.from,
    to: email.to,
    ...(email.cc?.length ? { cc: email.cc } : {}),
    date: email.date,
    seen: email.seen,
    flagged: email.flagged,
    answered: email.answered,
    labels: email.labels,
    ...(email.bulk ? { bulk: email.bulk } : {}),
    ...(email.inReplyTo ? { inReplyTo: email.inReplyTo } : {}),
    attachments: email.attachments.map((a) => ({
      filename: a.filename,
      mimeType: a.mimeType,
      size: a.size,
    })),
    ...(body === undefined ? {} : { body }),
    ...(email.bodyIncomplete ? { bodyIncomplete: true } : {}),
    ...(email.offline ? { offline: email.offline } : {}),
  };
}
