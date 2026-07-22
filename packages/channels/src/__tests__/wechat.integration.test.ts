/**
 * [COMP:channels/wechat-adapter] — live iLink integration (env-gated).
 *
 * Runs only when a scratch iLink bot's credentials are present:
 *
 *   WECHAT_ITEST_BOT_TOKEN  — bot token from a QR-login confirm
 *   WECHAT_ITEST_BASE_URL   — the per-bot `baseurl` from the same confirm
 *   WECHAT_ITEST_PEER_ID    — optional: an ilink_user_id to send a text to
 *                             (the user who scanned; they get a real DM)
 *
 * Obtain them once with the wechat-connector's /pair/start + /pair/:id/status
 * flow (or the Studio connect flow) against a scratch WeChat account. The
 * full text + media DM round-trip through `processChannelMessage` is the
 * deploy-time QA step in docs/architecture/channels/wechat.md → "Local
 * testing" — this suite validates the wire protocol half: a live getupdates
 * long-poll and (when a peer is supplied) a real outbound text send.
 */

import { describe, it, expect } from 'vitest'
import { createIlinkClient, createWechatAdapter } from '../wechat/index.js'

// No dotenv here (channels is dependency-free): export the vars in the shell
// that runs `pnpm test:integration`.
const botToken = process.env.WECHAT_ITEST_BOT_TOKEN
const baseUrl = process.env.WECHAT_ITEST_BASE_URL
const peerId = process.env.WECHAT_ITEST_PEER_ID
const describeIf = botToken && baseUrl ? describe : describe.skip

describeIf('[COMP:channels/wechat-adapter] iLink live (integration)', () => {
  const client = createIlinkClient({ baseUrl: baseUrl!, token: botToken! })

  it('long-polls getupdates with an empty cursor', async () => {
    const resp = await client.getUpdates({ getUpdatesBuf: '', timeoutMs: 8_000 })
    // A live token returns ret 0 (possibly with messages); a stale one
    // surfaces -14 — either way the wire shape must parse.
    expect(typeof (resp.ret ?? 0)).toBe('number')
    expect(Array.isArray(resp.msgs ?? [])).toBe(true)
  }, 20_000)

  const itIfPeer = peerId ? it : it.skip
  itIfPeer('sends a text DM to the scratch peer', async () => {
    const adapter = createWechatAdapter({ baseUrl: baseUrl!, botToken: botToken! })
    const messageId = await adapter.sendMessage(peerId!, {
      text: `Use Brian wechat integration test ${new Date().toISOString()}`,
    })
    expect(messageId).not.toBe('')
  }, 20_000)
})
