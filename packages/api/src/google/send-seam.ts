/**
 * Gmail send seam — the server-side, model-free way to send an email through
 * a user's connected Gmail. Factored out of the `injectMcpTools` closure so
 * the deterministic `send_page` workflow step (page-actions verbatim send
 * lane) and the `gmailSendMessage` tool share ONE send implementation:
 * refresh-token resolution (primary connector or a multi-account instance) →
 * access-token refresh → `sendGmailMessage` (`google/client.ts`).
 *
 * Deliberately narrow: no per-assistant capability gate and no classifier
 * preflight here — those are chat-surface governance. The send_page caller
 * carries its own governance (button-trigger gate, confidential egress gate,
 * `page_send_log` at-most-once claim); see
 * docs/architecture/features/page-actions.md.
 *
 * [COMP:api/gmail-send-seam]
 */

import { getConnectorConfig } from '../connector-config.js'
import { refreshGoogleAccessToken, sendGmailMessage } from './client.js'
import type { ConnectorStore } from '../db/connector-store.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'

export type GmailSendParams = { to: string; subject: string; body: string }

export type AcquireGmailSenderResult =
  | { ok: true; send: (params: GmailSendParams) => Promise<{ id: string; threadId: string }> }
  | { ok: false; message: string }

export type AcquireGmailSender = (params: {
  /** The acting user — the button clicker; the send goes out via THEIR Gmail. */
  userId: string
  /** Optional multi-account connector_instance id; absent = the primary gmail connector. */
  instanceId?: string
}) => Promise<AcquireGmailSenderResult>

export function createGmailSendSeam(deps: {
  connectorStore: Pick<ConnectorStore, 'getCredentials'>
  connectorInstanceStore: Pick<ConnectorInstanceStore, 'getCredentials'>
}): AcquireGmailSender {
  return async ({ userId, instanceId }) => {
    const googleCfg = getConnectorConfig('google')
    if (!googleCfg) {
      return { ok: false, message: 'Google OAuth is not configured on this deployment.' }
    }
    // Google connector rows store the REFRESH token in `client_secret`
    // (legacy blob shape — same read `injectMcpTools.readRefreshToken` does).
    const creds = instanceId
      ? await deps.connectorInstanceStore.getCredentials(userId, instanceId)
      : await deps.connectorStore.getCredentials(userId, 'gmail')
    const refreshToken = creds?.client_secret ?? null
    if (!refreshToken) {
      return {
        ok: false,
        message: instanceId
          ? `The Gmail account instance is not connected or not visible to this user.`
          : 'Gmail is not connected for this user. Connect Gmail in Settings before sending.',
      }
    }
    const accessToken = await refreshGoogleAccessToken(
      refreshToken,
      googleCfg.clientId,
      googleCfg.clientSecret,
    )
    return {
      ok: true,
      send: (params) => sendGmailMessage(accessToken, params),
    }
  }
}
