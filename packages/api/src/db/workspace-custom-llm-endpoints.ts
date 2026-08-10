/** Workspace-scoped custom OpenAI-compatible endpoint profiles. */

import { applyRLSGucs, getAppPool, query, queryWithRLS, rollbackAndRelease } from './client.js'
import { decryptApiKey, encryptApiKey } from './workspace-llm-provider-settings.js'

export type WorkspaceCustomLlmEndpoint = {
  id: string
  workspaceId: string
  name: string
  baseUrl: string
  modelId: string
  contextWindow: number
  maxOutputTokens: number
  supportsTools: boolean
  verifiedAt: Date
  isDefault: boolean
  hasApiKey: boolean
  createdAt: Date
  updatedAt: Date
}

export type WorkspaceCustomLlmEndpointRuntime = WorkspaceCustomLlmEndpoint & {
  apiKey: string | null
}

export type VerifiedCustomLlmEndpointInput = {
  name: string
  baseUrl: string
  apiKey?: string | null
  modelId: string
  contextWindow: number
  maxOutputTokens: number
  supportsTools: true
  verifiedAt: Date
  isDefault?: boolean
}

export type WorkspaceCustomLlmEndpointStore = {
  list(params: { actingUserId: string; workspaceId: string }): Promise<WorkspaceCustomLlmEndpoint[]>
  get(params: { actingUserId: string; workspaceId: string; endpointId: string }): Promise<WorkspaceCustomLlmEndpoint | null>
  create(params: { actingUserId: string; workspaceId: string; input: VerifiedCustomLlmEndpointInput }): Promise<WorkspaceCustomLlmEndpoint>
  update(params: { actingUserId: string; workspaceId: string; endpointId: string; input: VerifiedCustomLlmEndpointInput }): Promise<WorkspaceCustomLlmEndpoint | null>
  delete(params: { actingUserId: string; workspaceId: string; endpointId: string }): Promise<boolean>
  setDefault(params: { actingUserId: string; workspaceId: string; endpointId: string }): Promise<WorkspaceCustomLlmEndpoint | null>
  clearDefault(params: { actingUserId: string; workspaceId: string }): Promise<void>
  getRuntimeSystem(params: { workspaceId: string; endpointId: string }): Promise<WorkspaceCustomLlmEndpointRuntime | null>
  getDefaultRuntimeSystem(params: { workspaceId: string }): Promise<WorkspaceCustomLlmEndpointRuntime | null>
}

const PUBLIC_COLS = `
  id,
  workspace_id AS "workspaceId",
  name,
  base_url AS "baseUrl",
  model_id AS "modelId",
  context_window AS "contextWindow",
  max_output_tokens AS "maxOutputTokens",
  supports_tools AS "supportsTools",
  verified_at AS "verifiedAt",
  is_default AS "isDefault",
  (api_key_encrypted IS NOT NULL) AS "hasApiKey",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`

type RuntimeRow = WorkspaceCustomLlmEndpoint & { apiKeyEncrypted: Buffer | null }
const RUNTIME_COLS = `${PUBLIC_COLS}, api_key_encrypted AS "apiKeyEncrypted"`

export class CustomLlmEncryptionKeyRequiredError extends Error {
  constructor() {
    super('LLM_PROVIDER_KEY_ENCRYPTION_KEY is required to store a custom endpoint bearer key')
    this.name = 'CustomLlmEncryptionKeyRequiredError'
  }
}

export function createDbWorkspaceCustomLlmEndpointStore(
  encryptionKey?: Buffer,
): WorkspaceCustomLlmEndpointStore {
  const encryptOptional = (apiKey: string | null | undefined): Buffer | null => {
    const normalized = apiKey?.trim()
    if (!normalized) return null
    if (!encryptionKey) throw new CustomLlmEncryptionKeyRequiredError()
    return encryptApiKey(normalized, encryptionKey)
  }

  const runtimeFromRow = (row: RuntimeRow | undefined): WorkspaceCustomLlmEndpointRuntime | null => {
    if (!row) return null
    const { apiKeyEncrypted, ...profile } = row
    if (apiKeyEncrypted && !encryptionKey) {
      throw new CustomLlmEncryptionKeyRequiredError()
    }
    return {
      ...profile,
      apiKey: apiKeyEncrypted ? decryptApiKey(apiKeyEncrypted, encryptionKey!) : null,
    }
  }

  const setDefaultTx = async (
    actingUserId: string,
    workspaceId: string,
    endpointId: string,
  ): Promise<WorkspaceCustomLlmEndpoint | null> => {
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN')
      await applyRLSGucs(client, actingUserId)
      // Serialize default changes per workspace. Without this, two admins
      // selecting different defaults concurrently can both clear the old row
      // and then race the partial unique index.
      await client.query(`SELECT id FROM workspaces WHERE id = $1 FOR UPDATE`, [workspaceId])
      const target = await client.query<{ id: string }>(
        `SELECT id FROM workspace_custom_llm_endpoints
          WHERE workspace_id = $1 AND id = $2
          FOR UPDATE`,
        [workspaceId, endpointId],
      )
      if (!target.rows[0]) {
        await client.query('COMMIT')
        return null
      }
      await client.query(
        `UPDATE workspace_custom_llm_endpoints
            SET is_default = false, updated_at = now()
          WHERE workspace_id = $1 AND is_default`,
        [workspaceId],
      )
      const result = await client.query<WorkspaceCustomLlmEndpoint>(
        `UPDATE workspace_custom_llm_endpoints
            SET is_default = true, updated_at = now()
          WHERE workspace_id = $1 AND id = $2
         RETURNING ${PUBLIC_COLS}`,
        [workspaceId, endpointId],
      )
      await client.query('COMMIT')
      return result.rows[0] ?? null
    } finally {
      await rollbackAndRelease(client)
    }
  }

  return {
    async list({ actingUserId, workspaceId }) {
      const result = await queryWithRLS<WorkspaceCustomLlmEndpoint>(
        actingUserId,
        `SELECT ${PUBLIC_COLS}
           FROM workspace_custom_llm_endpoints
          WHERE workspace_id = $1
          ORDER BY is_default DESC, lower(name), created_at`,
        [workspaceId],
      )
      return result.rows
    },

    async get({ actingUserId, workspaceId, endpointId }) {
      const result = await queryWithRLS<WorkspaceCustomLlmEndpoint>(
        actingUserId,
        `SELECT ${PUBLIC_COLS}
           FROM workspace_custom_llm_endpoints
          WHERE workspace_id = $1 AND id = $2
          LIMIT 1`,
        [workspaceId, endpointId],
      )
      return result.rows[0] ?? null
    },

    async create({ actingUserId, workspaceId, input }) {
      const encrypted = encryptOptional(input.apiKey)
      const result = await queryWithRLS<WorkspaceCustomLlmEndpoint>(
        actingUserId,
        `INSERT INTO workspace_custom_llm_endpoints
           (workspace_id, name, base_url, api_key_encrypted, model_id,
            context_window, max_output_tokens, supports_tools, verified_at, is_default)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, false)
         RETURNING ${PUBLIC_COLS}`,
        [
          workspaceId,
          input.name,
          input.baseUrl,
          encrypted,
          input.modelId,
          input.contextWindow,
          input.maxOutputTokens,
          input.supportsTools,
          input.verifiedAt,
        ],
      )
      const created = result.rows[0]!
      return input.isDefault
        ? (await setDefaultTx(actingUserId, workspaceId, created.id)) ?? created
        : created
    },

    async update({ actingUserId, workspaceId, endpointId, input }) {
      const encrypted = encryptOptional(input.apiKey)
      const result = await queryWithRLS<WorkspaceCustomLlmEndpoint>(
        actingUserId,
        `UPDATE workspace_custom_llm_endpoints
            SET name = $3,
                base_url = $4,
                api_key_encrypted = $5,
                model_id = $6,
                context_window = $7,
                max_output_tokens = $8,
                supports_tools = true,
                verified_at = $9,
                is_default = false,
                updated_at = now()
          WHERE workspace_id = $1 AND id = $2
         RETURNING ${PUBLIC_COLS}`,
        [
          workspaceId,
          endpointId,
          input.name,
          input.baseUrl,
          encrypted,
          input.modelId,
          input.contextWindow,
          input.maxOutputTokens,
          input.verifiedAt,
        ],
      )
      const updated = result.rows[0] ?? null
      return updated && input.isDefault
        ? (await setDefaultTx(actingUserId, workspaceId, updated.id)) ?? updated
        : updated
    },

    async delete({ actingUserId, workspaceId, endpointId }) {
      const result = await queryWithRLS(
        actingUserId,
        `DELETE FROM workspace_custom_llm_endpoints WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, endpointId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async setDefault({ actingUserId, workspaceId, endpointId }) {
      return setDefaultTx(actingUserId, workspaceId, endpointId)
    },

    async clearDefault({ actingUserId, workspaceId }) {
      await queryWithRLS(
        actingUserId,
        `UPDATE workspace_custom_llm_endpoints
            SET is_default = false, updated_at = now()
          WHERE workspace_id = $1 AND is_default`,
        [workspaceId],
      )
    },

    async getRuntimeSystem({ workspaceId, endpointId }) {
      const result = await query<RuntimeRow>(
        `SELECT ${RUNTIME_COLS}
           FROM workspace_custom_llm_endpoints
          WHERE workspace_id = $1 AND id = $2 AND supports_tools AND verified_at IS NOT NULL
          LIMIT 1`,
        [workspaceId, endpointId],
      )
      return runtimeFromRow(result.rows[0])
    },

    async getDefaultRuntimeSystem({ workspaceId }) {
      const result = await query<RuntimeRow>(
        `SELECT ${RUNTIME_COLS}
           FROM workspace_custom_llm_endpoints
          WHERE workspace_id = $1 AND is_default AND supports_tools AND verified_at IS NOT NULL
          LIMIT 1`,
        [workspaceId],
      )
      return runtimeFromRow(result.rows[0])
    },
  }
}
