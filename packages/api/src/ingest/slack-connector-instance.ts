/**
 * Slack wrapper for the shared channel connector-instance lifecycle.
 *
 * [COMP:api/slack-connector-instance]
 */

import { ensureChannelConnectorInstance } from './channel-connector-instance.js'

export type EnsureSlackCiInput = {
  channelIntegrationId: string
  actingUserId: string
}

export function ensureSlackConnectorInstance(input: EnsureSlackCiInput): Promise<string> {
  return ensureChannelConnectorInstance({
    ...input,
    provider: 'slack',
    fallbackLabel: 'Slack',
    buildConfig: ({ teamId }) => ({ slack_team_id: teamId }),
  })
}
