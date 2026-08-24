/**
 * WhatsApp wrapper for the shared channel connector-instance lifecycle.
 * Its default rule set is empty, so group enablement remains default-drop.
 *
 * [COMP:api/whatsapp-connector-instance]
 */

import { ensureChannelConnectorInstance } from './channel-connector-instance.js'

export type EnsureWhatsappCiInput = {
  channelIntegrationId: string
  actingUserId: string
}

export function ensureWhatsappConnectorInstance(input: EnsureWhatsappCiInput): Promise<string> {
  return ensureChannelConnectorInstance({
    ...input,
    provider: 'whatsapp',
    fallbackLabel: 'WhatsApp',
  })
}
