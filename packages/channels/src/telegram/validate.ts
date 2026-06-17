/**
 * Validate Telegram BYO bot token by calling getMe.
 * Used by the integrations settings route to confirm a pasted bot token
 * is real before persisting it. See docs/architecture/channels/adapter-pattern.md.
 */

import { createTelegramApi } from './api.js'

export type TelegramCredentialInfo = {
  botId: number
  botUsername: string
  firstName: string
}

/**
 * Call Telegram's getMe with the provided bot token.
 * Returns the bot identity on success.
 * Throws with Telegram's error description on failure so the caller
 * can surface it to the user.
 */
export async function validateTelegramCredentials(botToken: string): Promise<TelegramCredentialInfo> {
  const api = createTelegramApi({ token: botToken })
  const result = await api.getMe()
  return {
    botId: result.id,
    botUsername: result.username,
    firstName: result.first_name,
  }
}
