/**
 * QR pairing sessions — the WeChat BYON bind flow.
 *
 * `start()` fetches a login QR from iLink and long-polls its status in the
 * background; the API proxies Studio's polling to `getStatus()` and, on
 * `confirmed`, consumes `result` (bot token + per-bot base URL) to persist the
 * channel and start the long-poll loop. States mirror iLink's own machine,
 * including `need_verifycode` (the user must type the digits their phone
 * shows — submitted via `submitVerifyCode()`) and in-place QR refresh when a
 * code expires (up to 3 times, like the reference plugin).
 *
 * The confirmed result (which includes the bot token) is held in memory until
 * the API collects it or the session TTL purges it; it is only ever served to
 * the shared-secret-authenticated API, never a browser.
 *
 * Component tag: [COMP:app/wechat-connector].
 */

import { randomUUID } from 'node:crypto'
import {
  fetchBotQrcode,
  pollQrcodeStatus,
  ILINK_DEFAULT_BASE_URL,
} from '@use-brian/channels'

const SESSION_TTL_MS = 10 * 60_000
const MAX_QR_REFRESHES = 3
const POLL_GAP_MS = 1_000

type PairingStatus =
  | 'qr'
  | 'scanned'
  | 'need_verifycode'
  | 'verify_code_rejected'
  | 'confirmed'
  | 'already_bound'
  | 'expired'
  | 'error'

type PairingSnapshot = {
  pairingId: string
  status: PairingStatus
  qrcodeUrl?: string
  error?: string
  result?: {
    botToken: string
    baseUrl: string
    ilinkBotId: string
    boundUserId?: string
  }
}

type PairingSession = {
  snapshot: PairingSnapshot
  qrcode: string
  /** Effective polling base; iLink may redirect mid-flow (scaned_but_redirect). */
  pollBaseUrl: string
  pendingVerifyCode?: string
  /** Resolved when submitVerifyCode delivers the digits the loop waits for. */
  wakeVerify?: () => void
  qrRefreshes: number
  startedAt: number
  abort: AbortController
}

export type PairingManager = {
  start(): Promise<{ pairingId: string; qrcodeUrl: string }>
  getStatus(pairingId: string): PairingSnapshot | null
  submitVerifyCode(pairingId: string, code: string): boolean
  stopAll(): void
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms)
    function done(): void {
      clearTimeout(t)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export function createPairingManager(): PairingManager {
  const sessions = new Map<string, PairingSession>()

  function purgeExpired(): void {
    const now = Date.now()
    for (const [id, s] of sessions) {
      if (now - s.startedAt > SESSION_TTL_MS) {
        s.abort.abort()
        sessions.delete(id)
      }
    }
  }

  async function runStatusLoop(session: PairingSession): Promise<void> {
    const signal = session.abort.signal
    const deadline = session.startedAt + SESSION_TTL_MS

    while (!signal.aborted && Date.now() < deadline) {
      // When iLink asked for the pairing digits, hold polling until the user
      // submits them (or the session dies).
      if (
        (session.snapshot.status === 'need_verifycode' || session.snapshot.status === 'verify_code_rejected') &&
        !session.pendingVerifyCode
      ) {
        await new Promise<void>((resolve) => {
          session.wakeVerify = resolve
          signal.addEventListener('abort', () => resolve(), { once: true })
        })
        session.wakeVerify = undefined
        continue
      }

      let status
      try {
        status = await pollQrcodeStatus({
          baseUrl: session.pollBaseUrl,
          qrcode: session.qrcode,
          verifyCode: session.pendingVerifyCode,
          abortSignal: signal,
        })
      } catch (err) {
        // Network/gateway hiccups are treated as "still waiting".
        console.warn(`[wechat-pairing] ${session.snapshot.pairingId}: poll error, retrying:`, err)
        await sleep(POLL_GAP_MS, signal)
        continue
      }
      if (signal.aborted) return

      switch (status.status) {
        case 'wait':
          break
        case 'scaned':
          // A pending code that produced `scaned` was accepted.
          session.pendingVerifyCode = undefined
          session.snapshot.status = 'scanned'
          break
        case 'need_verifycode':
          if (session.pendingVerifyCode) {
            // The digits we sent were wrong — clear and ask again.
            session.pendingVerifyCode = undefined
            session.snapshot.status = 'verify_code_rejected'
          } else {
            session.snapshot.status = 'need_verifycode'
          }
          continue
        case 'verify_code_blocked':
          session.pendingVerifyCode = undefined
          session.snapshot.status = 'error'
          session.snapshot.error = 'verify_code_blocked'
          return
        case 'scaned_but_redirect':
          if (status.redirect_host) {
            session.pollBaseUrl = `https://${status.redirect_host}`
          }
          break
        case 'binded_redirect':
          // Already bound to this deployment — nothing new is issued.
          session.snapshot.status = 'already_bound'
          return
        case 'expired': {
          session.qrRefreshes += 1
          if (session.qrRefreshes > MAX_QR_REFRESHES) {
            session.snapshot.status = 'expired'
            return
          }
          try {
            const qr = await fetchBotQrcode(ILINK_DEFAULT_BASE_URL)
            session.qrcode = qr.qrcode
            session.snapshot.qrcodeUrl = qr.qrcode_img_content
            session.snapshot.status = 'qr'
            session.pollBaseUrl = ILINK_DEFAULT_BASE_URL
          } catch (err) {
            session.snapshot.status = 'error'
            session.snapshot.error = `QR refresh failed: ${String(err)}`
            return
          }
          break
        }
        case 'confirmed': {
          if (!status.bot_token || !status.ilink_bot_id) {
            session.snapshot.status = 'error'
            session.snapshot.error = 'iLink confirmed the login but returned no credentials'
            return
          }
          session.snapshot.status = 'confirmed'
          session.snapshot.qrcodeUrl = undefined
          session.snapshot.result = {
            botToken: status.bot_token,
            baseUrl: status.baseurl || ILINK_DEFAULT_BASE_URL,
            ilinkBotId: status.ilink_bot_id,
            boundUserId: status.ilink_user_id,
          }
          return
        }
      }

      await sleep(POLL_GAP_MS, signal)
    }

    if (session.snapshot.status !== 'confirmed' && session.snapshot.status !== 'already_bound') {
      session.snapshot.status = 'expired'
    }
  }

  return {
    async start() {
      purgeExpired()
      const qr = await fetchBotQrcode(ILINK_DEFAULT_BASE_URL)
      const pairingId = randomUUID()
      const session: PairingSession = {
        snapshot: { pairingId, status: 'qr', qrcodeUrl: qr.qrcode_img_content },
        qrcode: qr.qrcode,
        pollBaseUrl: ILINK_DEFAULT_BASE_URL,
        qrRefreshes: 0,
        startedAt: Date.now(),
        abort: new AbortController(),
      }
      sessions.set(pairingId, session)
      void runStatusLoop(session).catch((err) => {
        console.error(`[wechat-pairing] ${pairingId}: status loop crashed:`, err)
        session.snapshot.status = 'error'
        session.snapshot.error = String(err)
      })
      return { pairingId, qrcodeUrl: qr.qrcode_img_content }
    },

    getStatus(pairingId) {
      purgeExpired()
      return sessions.get(pairingId)?.snapshot ?? null
    },

    submitVerifyCode(pairingId, code) {
      const session = sessions.get(pairingId)
      if (!session) return false
      session.pendingVerifyCode = code.trim()
      // Show progress while the next poll carries the code.
      if (session.snapshot.status === 'need_verifycode' || session.snapshot.status === 'verify_code_rejected') {
        session.snapshot.status = 'scanned'
      }
      session.wakeVerify?.()
      return true
    },

    stopAll() {
      for (const s of sessions.values()) s.abort.abort()
      sessions.clear()
    },
  }
}
