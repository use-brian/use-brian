/**
 * MX-record preset resolution for the mailbox connector (D1: generic `imap`
 * provider; AliMail is a preset detected from the address domain's MX at
 * connect time — never a branded connector).
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

/**
 * Match an MX exchange hostname to a preset. `qiye.aliyun.com` is the current
 * Alibaba enterprise-mail MX; `mxhichina.com` is its long-lived legacy alias
 * (same endpoints). Exported for tests.
 */
export function presetForMxHost(exchange: string): MailboxPreset | null {
  const host = exchange.trim().toLowerCase().replace(/\.$/, '')
  if (/(^|\.)qiye\.aliyun\.com$/.test(host) || /(^|\.)mxhichina\.com$/.test(host)) {
    return ALIMAIL_PRESET
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
