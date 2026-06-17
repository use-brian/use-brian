/**
 * Validate Slack BYO credentials by calling auth.test.
 * Used by the integrations settings route to confirm a pasted bot token
 * is real before persisting it. See docs/architecture/channels/adapter-pattern.md
 * → "User Setup Flow" step 3.
 */

import { createSlackApi } from './api.js'

export type SlackCredentialInfo = {
  teamId: string
  teamName: string
  botUserId: string
}

/**
 * Call Slack's auth.test with the provided bot token.
 * Returns the identifying bits (team_id, team_name, bot_user_id) on success.
 * Throws with Slack's error string on failure (e.g., 'invalid_auth',
 * 'account_inactive') so the caller can surface it to the user.
 */
export async function validateSlackCredentials(botToken: string): Promise<SlackCredentialInfo> {
  const api = createSlackApi({ botToken })
  // auth.test returns { ok, url, team, user, team_id, user_id, bot_id, ... }
  // The createSlackApi typing only pins user_id/bot_id/team — we read the
  // fuller shape here since validation is the one place we need it.
  const result = await api.authTest() as {
    user_id: string
    bot_id: string
    team: string
    team_id?: string
  }
  return {
    teamId: result.team_id ?? '',
    teamName: result.team,
    botUserId: result.user_id,
  }
}
