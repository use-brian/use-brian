/**
 * MX-record preset resolution for the mailbox connector (D1: generic `imap`
 * provider; reviewed client presets are detected from the address domain's MX
 * at connect time — never branded connectors and never the inbound exchange
 * copied blindly into an IMAP/SMTP field).
 *
 * [COMP:api/mailbox-imap-client]
 */

import { promises as dns } from 'node:dns'
import type { MailboxPreset } from './types.js'

const ALIMAIL_PRESET: MailboxPreset = {
  presetId: 'alimail',
  label: 'Alibaba enterprise mail',
  imapHost: 'imap.qiye.aliyun.com',
  imapPort: 993,
  smtpHost: 'smtp.qiye.aliyun.com',
  smtpPort: 465,
}

const GMAIL_PRESET: MailboxPreset = {
  presetId: 'gmail',
  label: 'Gmail / Google Workspace',
  imapHost: 'imap.gmail.com',
  imapPort: 993,
  smtpHost: 'smtp.gmail.com',
  smtpPort: 465,
}

export function isAliMailImapHost(host: string): boolean {
  const normalized = host.trim().toLowerCase().replace(/\.$/, '')
  return normalized === ALIMAIL_PRESET.imapHost || normalized.endsWith('.qiye.aliyun.com')
}

/**
 * Match an MX exchange hostname to a preset. `qiye.aliyun.com` is the current
 * Alibaba enterprise-mail MX; `mxhichina.com` is its long-lived legacy alias
 * (same endpoints). Gmail's own domain currently uses
 * `[altN.]gmail-smtp-in.l.google.com`, while Google Workspace domains use
 * `[altN.]aspmx.l.google.com`; both share the documented Gmail client
 * endpoints. Exported for tests.
 */
export function presetForMxHost(exchange: string): MailboxPreset | null {
  const host = exchange.trim().toLowerCase().replace(/\.$/, '')
  if (/(^|\.)qiye\.aliyun\.com$/.test(host) || /(^|\.)mxhichina\.com$/.test(host)) {
    return ALIMAIL_PRESET
  }
  if (
    /(^|\.)gmail-smtp-in\.l\.google\.com$/.test(host) ||
    /(^|\.)aspmx\.l\.google\.com$/.test(host)
  ) {
    return GMAIL_PRESET
  }
  return null
}

/**
 * Resolve the preset for an email address by looking up its domain's MX
 * records (lowest-priority first). Returns null when the domain is
 * unrecognized or unresolvable — the connect dialog then expands the
 * Advanced host/port fields.
 */
export async function resolveMailboxPreset(
  email: string,
  resolveMx: (domain: string) => Promise<Array<{ exchange: string; priority: number }>> = (d) =>
    dns.resolveMx(d),
): Promise<MailboxPreset | null> {
  const at = email.lastIndexOf('@')
  if (at < 0) return null
  const domain = email.slice(at + 1).trim().toLowerCase()
  if (!domain) return null
  let records: Array<{ exchange: string; priority: number }>
  try {
    records = await resolveMx(domain)
  } catch {
    return null
  }
  for (const record of [...records].sort((a, b) => a.priority - b.priority)) {
    const preset = presetForMxHost(record.exchange)
    if (preset) return preset
  }
  return null
}
