/**
 * Live-server integration for the mailbox connector (plan §10): connect →
 * OR-search across INBOX+Sent → fetch a message → send a markdown message
 * round-trip, plus the §4 empirical checks (UTF-8 SEARCH behavior, TEXT-scan
 * latency — results recorded back into docs/plans/mailbox-imap-connector.md).
 *
 * Env-gated: skips cleanly unless TEST_IMAP_HOST / TEST_IMAP_USER /
 * TEST_IMAP_PASSWORD are set. Optional: TEST_SMTP_HOST (defaults to
 * TEST_IMAP_HOST), TEST_IMAP_PORT (993), TEST_SMTP_PORT (465),
 * TEST_IMAP_SEND_TO (enables the live send leg — sends real mail).
 *
 * [COMP:api/mailbox-imap-client]
 */

import { describe, it, expect, afterAll } from 'vitest'
import { createMailboxApi } from '../mailbox-api.js'
import { createMailboxSessionCache } from '../imap-session.js'
import { verifyMailboxConnection } from '../verify.js'
import type { MailboxAccountSettings } from '../types.js'

const HOST = process.env.TEST_IMAP_HOST
const USER = process.env.TEST_IMAP_USER
const PASSWORD = process.env.TEST_IMAP_PASSWORD

const describeIf = HOST && USER && PASSWORD ? describe : describe.skip

const settings: MailboxAccountSettings = {
  email: USER ?? '',
  appPassword: PASSWORD ?? '',
  imapHost: HOST ?? '',
  imapPort: Number(process.env.TEST_IMAP_PORT ?? 993),
  smtpHost: process.env.TEST_SMTP_HOST ?? HOST ?? '',
  smtpPort: Number(process.env.TEST_SMTP_PORT ?? 465),
}

const sessions = createMailboxSessionCache()
const api = createMailboxApi({ cacheKey: 'integration', getSettings: async () => settings, sessions })

afterAll(async () => {
  await sessions.closeAll()
})

describeIf('[COMP:api/mailbox-imap-client] live IMAP/SMTP round-trip', () => {
  it('verifies the account (IMAP login + SMTP verify)', async () => {
    const result = await verifyMailboxConnection(settings)
    expect(result).toEqual({ ok: true })
  }, 60_000)

  it('OR-searches across INBOX + Sent with a bounded window', async () => {
    const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const started = Date.now()
    const { hits, note } = await api.searchMessages({
      keywords: ['the', 'a'],
      since,
      limit: 10,
    })
    const elapsed = Date.now() - started
    console.info(`[mailbox-integration] OR search: ${hits.length} hits, ${elapsed}ms, note=${note ?? 'none'}`)
    expect(Array.isArray(hits)).toBe(true)
    expect(hits.length).toBeLessThanOrEqual(10)
  }, 120_000)

  it('§4 empirical: UTF-8 (Chinese) SEARCH either works server-side or degrades with an honest note', async () => {
    const since = new Date(Date.now() - 90 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const started = Date.now()
    const { hits, note } = await api.searchMessages({ keywords: ['会议', '合同'], since, limit: 5 })
    console.info(
      `[mailbox-integration] UTF-8 search: ${hits.length} hits, ${Date.now() - started}ms, ` +
      `degraded=${note ? 'YES — record BADCHARSET in the plan' : 'no (server accepted UTF-8)'}`,
    )
    expect(Array.isArray(hits)).toBe(true)
  }, 120_000)

  it('fetches a full message when the mailbox has any', async () => {
    const since = new Date(Date.now() - 365 * 24 * 3600 * 1000).toISOString().slice(0, 10)
    const { hits } = await api.searchMessages({ since, limit: 1 })
    if (hits.length === 0) return  // empty scratch mailbox — nothing to assert
    const message = await api.getMessage(hits[0].id)
    expect(message.id).toBe(hits[0].id)
    expect(typeof message.body).toBe('string')
  }, 120_000)

  it('sends a markdown message round-trip (only when TEST_IMAP_SEND_TO is set)', async () => {
    const to = process.env.TEST_IMAP_SEND_TO
    if (!to) return
    const result = await api.sendMessage({
      to,
      subject: `Use Brian mailbox integration ${new Date().toISOString()}`,
      body: 'Integration check.\n\n**Bold works.**\n\n- list item',
    })
    expect(result.messageId).toBeTruthy()
  }, 120_000)
})
