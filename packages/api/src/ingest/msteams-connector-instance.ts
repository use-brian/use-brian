/** Teams pairs a metadata-only instance until Pipeline C supports Teams rules. [COMP:api/msteams-connector-instance] */

import { ensureChannelConnectorInstance } from './channel-connector-instance.js'

export type EnsureMsTeamsCiInput = {
  channelIntegrationId: string
  actingUserId: string
}

export async function ensureMsTeamsConnectorInstance(input: EnsureMsTeamsCiInput): Promise<string> {
  return ensureChannelConnectorInstance({
    channelIntegrationId: input.channelIntegrationId,
    actingUserId: input.actingUserId,
    provider: 'msteams',
    fallbackLabel: 'Microsoft Teams',
    buildConfig: ({ teamId }) => ({ msteams_tenant_id: teamId }),
  })
}
