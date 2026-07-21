/**
 * Validate Microsoft Teams BYO credentials by minting a Bot Connector token.
 *
 * Teams has no `auth.test` (Slack) or `GET /users/@me` (Discord) — the closest
 * proof that a pasted App id + client secret + tenant id are real is that the
 * client-credentials flow returns an access token. This is a NECESSARY but not
 * SUFFICIENT check: it proves the Azure app registration + secret are valid; it
 * cannot prove the Teams app package is installed or that the bot is reachable.
 * The connect route therefore marks the integration `active` on a successful
 * mint and flips the UI to "Connected" only on the first inbound Activity
 * (`last_event_at`). See docs/architecture/channels/msteams.md § "Connect".
 */

import { createMsTeamsApi } from './api.js'

export type MsTeamsCredentialInfo = {
  appId: string
  tenantId: string
  /** The bot's connector id (`28:<appId>`), useful for self-mention detection. */
  botId: string
}

export async function validateMsTeamsCredentials(params: {
  appId: string
  appPassword: string
  tenantId: string
  fetchImpl?: typeof fetch
  loginBaseUrl?: string
}): Promise<MsTeamsCredentialInfo> {
  const api = createMsTeamsApi({
    appId: params.appId,
    appPassword: params.appPassword,
    tenantId: params.tenantId,
    fetchImpl: params.fetchImpl,
    loginBaseUrl: params.loginBaseUrl,
  })
  // Throws with the AAD error string on a bad secret / tenant.
  await api.getToken()
  return {
    appId: params.appId,
    tenantId: params.tenantId,
    botId: `28:${params.appId}`,
  }
}
