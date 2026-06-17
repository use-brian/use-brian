/**
 * Assistant connector settings store — Layer 2 of the 2-layer permission model.
 *
 * Controls which connectors are enabled for each assistant.
 * Default: if no row exists, the connector is enabled (opt-out model).
 *
 * See docs/architecture/integrations/mcp.md → "2-Layer Permission Model".
 */

import { query } from './client.js'

export type AssistantConnectorStore = {
  /** Returns true if the connector is enabled for this assistant. No row = enabled (default). */
  isEnabled(assistantId: string, connectorId: string): Promise<boolean>
  /** Upsert the enabled state for a connector on an assistant. */
  setEnabled(assistantId: string, connectorId: string, enabled: boolean): Promise<void>
  /** List all connector settings for an assistant. Only returns rows that exist (explicitly set). */
  listForAssistant(assistantId: string): Promise<Array<{ connectorId: string; enabled: boolean }>>
}

export function createDbAssistantConnectorStore(): AssistantConnectorStore {
  return {
    async isEnabled(assistantId, connectorId) {
      const result = await query<{ enabled: boolean }>(
        `SELECT enabled FROM assistant_connector_settings
         WHERE assistant_id = $1 AND connector_id = $2`,
        [assistantId, connectorId],
      )
      // No row = default enabled
      return result.rows[0]?.enabled ?? true
    },

    async setEnabled(assistantId, connectorId, enabled) {
      await query(
        `INSERT INTO assistant_connector_settings (assistant_id, connector_id, enabled)
         VALUES ($1, $2, $3)
         ON CONFLICT (assistant_id, connector_id) DO UPDATE
           SET enabled = $3`,
        [assistantId, connectorId, enabled],
      )
    },

    async listForAssistant(assistantId) {
      const result = await query<{ connectorId: string; enabled: boolean }>(
        `SELECT connector_id AS "connectorId", enabled
         FROM assistant_connector_settings
         WHERE assistant_id = $1`,
        [assistantId],
      )
      return result.rows
    },
  }
}
