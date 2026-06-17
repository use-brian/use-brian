/**
 * Validate Discord BYO bot token by calling GET /users/@me.
 * Used by the integrations settings route to confirm a pasted bot token is
 * real (and to capture the bot's user id, which the adapter needs for
 * self-mention detection) before persisting it. Mirrors the Slack/Telegram
 * `validate*Credentials` helpers. See docs/architecture/channels/discord.md.
 */

import { createDiscordApi } from './api.js'

export type DiscordCredentialInfo = {
  botId: string
  botUsername: string
}

/**
 * Call Discord's `GET /users/@me` with the provided bot token.
 * Returns the bot identity on success. Throws `DiscordApiError` on failure
 * (e.g. `401 Unauthorized` for a bad token) so the caller can surface it.
 */
export async function validateDiscordCredentials(botToken: string): Promise<DiscordCredentialInfo> {
  const api = createDiscordApi({ token: botToken })
  const me = await api.getCurrentUser()
  return {
    botId: me.id,
    botUsername: me.username,
  }
}
