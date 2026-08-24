/**
 * Feishu/Lark wrapper for the shared channel connector-instance lifecycle.
 * It is created disabled and rule-less; enabling an observed group is the
 * only path that activates passive ingestion.
 *
 * [COMP:api/feishu-connector-instance]
 */

import { ensureChannelConnectorInstance } from './channel-connector-instance.js'

export type EnsureFeishuCiInput = {
  channelIntegrationId: string
  actingUserId: string
}

export function ensureFeishuConnectorInstance(input: EnsureFeishuCiInput): Promise<string> {
  return ensureChannelConnectorInstance({
    ...input,
    provider: 'feishu',
    fallbackLabel: 'Feishu / Lark',
    initialIngestionEnabled: false,
    buildConfig: ({ teamId }) => ({ feishu_app_id: teamId }),
  })
}
