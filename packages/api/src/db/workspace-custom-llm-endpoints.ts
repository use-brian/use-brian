/** Workspace-scoped OpenAI-compatible connections, profiles, and tier routing. */

import { randomUUID } from 'node:crypto'
import { applyRLSGucs, getAppPool, query, queryWithRLS, rollbackAndRelease } from './client.js'
import { decryptApiKey, encryptApiKey } from './workspace-llm-provider-settings.js'

export const CUSTOM_LLM_TIERS = ['standard', 'pro', 'max', 'research'] as const
export type CustomLlmTier = (typeof CUSTOM_LLM_TIERS)[number]

export function isCustomLlmTier(value: string): value is CustomLlmTier {
  return (CUSTOM_LLM_TIERS as readonly string[]).includes(value)
}

export type WorkspaceCustomLlmProfile = {
  id: string
  endpointId: string
  workspaceId: string
  name: string
  modelId: string
  contextWindow: number
  maxOutputTokens: number
  supportsTools: boolean
  verifiedAt: Date
  createdAt: Date
  updatedAt: Date
}

export type WorkspaceCustomLlmEndpoint = {
  id: string
  workspaceId: string
  name: string
  baseUrl: string
  hasApiKey: boolean
  createdAt: Date
  updatedAt: Date
  profiles: WorkspaceCustomLlmProfile[]
}

export type WorkspaceCustomLlmProfileRuntime = WorkspaceCustomLlmProfile & {
  endpointName: string
  baseUrl: string
  apiKey: string | null
}

export type WorkspaceCustomLlmEndpointRuntime = Omit<WorkspaceCustomLlmEndpoint, 'profiles'> & {
  apiKey: string | null
}

export type WorkspaceCustomLlmTierDefault = {
  workspaceId: string
  tier: CustomLlmTier
  profileId: string
  updatedAt: Date
}

export type VerifiedCustomLlmProfileInput = {
  name: string
  modelId: string
  contextWindow: number
  maxOutputTokens: number
  supportsTools: true
  verifiedAt: Date
}

export type VerifiedCustomLlmEndpointInput = VerifiedCustomLlmProfileInput & {
  baseUrl: string
  apiKey?: string | null
}

export type WorkspaceCustomLlmEndpointStore = {
  list(params: { actingUserId: string; workspaceId: string }): Promise<WorkspaceCustomLlmEndpoint[]>
  listProfiles(params: { actingUserId: string; workspaceId: string }): Promise<WorkspaceCustomLlmProfile[]>
  listTierDefaults(params: { actingUserId: string; workspaceId: string }): Promise<WorkspaceCustomLlmTierDefault[]>
  create(params: { actingUserId: string; workspaceId: string; input: VerifiedCustomLlmEndpointInput }): Promise<WorkspaceCustomLlmEndpoint>
  createProfile(params: { actingUserId: string; workspaceId: string; endpointId: string; input: VerifiedCustomLlmProfileInput }): Promise<WorkspaceCustomLlmProfile | null>
  updateProfile(params: { actingUserId: string; workspaceId: string; endpointId: string; profileId: string; input: VerifiedCustomLlmProfileInput }): Promise<WorkspaceCustomLlmProfile | null>
  delete(params: { actingUserId: string; workspaceId: string; endpointId: string }): Promise<boolean>
  deleteProfile(params: { actingUserId: string; workspaceId: string; endpointId: string; profileId: string }): Promise<boolean>
  setTierDefault(params: { actingUserId: string; workspaceId: string; tier: CustomLlmTier; profileId: string }): Promise<WorkspaceCustomLlmTierDefault | null>
  clearTierDefault(params: { actingUserId: string; workspaceId: string; tier: CustomLlmTier }): Promise<void>
  getEndpointRuntimeSystem(params: { workspaceId: string; endpointId: string }): Promise<WorkspaceCustomLlmEndpointRuntime | null>
  getRuntimeSystem(params: { workspaceId: string; profileId: string }): Promise<WorkspaceCustomLlmProfileRuntime | null>
  getTierRuntimeSystem(params: { workspaceId: string; tier: CustomLlmTier }): Promise<WorkspaceCustomLlmProfileRuntime | null>
}

const ENDPOINT_COLS = `
  id,
  workspace_id AS "workspaceId",
  name,
  base_url AS "baseUrl",
  (api_key_encrypted IS NOT NULL) AS "hasApiKey",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`

const PROFILE_COLS = `
  id,
  endpoint_id AS "endpointId",
  workspace_id AS "workspaceId",
  name,
  model_id AS "modelId",
  context_window AS "contextWindow",
  max_output_tokens AS "maxOutputTokens",
  supports_tools AS "supportsTools",
  verified_at AS "verifiedAt",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`

const RUNTIME_PROFILE_COLS = `
  p.id,
  p.endpoint_id AS "endpointId",
  p.workspace_id AS "workspaceId",
  p.name,
  p.model_id AS "modelId",
  p.context_window AS "contextWindow",
  p.max_output_tokens AS "maxOutputTokens",
  p.supports_tools AS "supportsTools",
  p.verified_at AS "verifiedAt",
  p.created_at AS "createdAt",
  p.updated_at AS "updatedAt",
  e.name AS "endpointName",
  e.base_url AS "baseUrl",
  e.api_key_encrypted AS "apiKeyEncrypted"
`

type EndpointRow = Omit<WorkspaceCustomLlmEndpoint, 'profiles'>
type RuntimeProfileRow = Omit<WorkspaceCustomLlmProfileRuntime, 'apiKey'> & { apiKeyEncrypted: Buffer | null }
type RuntimeEndpointRow = EndpointRow & { apiKeyEncrypted: Buffer | null }

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

  const decryptOptional = (encrypted: Buffer | null): string | null => {
    if (!encrypted) return null
    if (!encryptionKey) throw new CustomLlmEncryptionKeyRequiredError()
    return decryptApiKey(encrypted, encryptionKey)
  }

  const runtimeProfileFromRow = (row: RuntimeProfileRow | undefined): WorkspaceCustomLlmProfileRuntime | null => {
    if (!row) return null
    const { apiKeyEncrypted, ...profile } = row
    return { ...profile, apiKey: decryptOptional(apiKeyEncrypted) }
  }

  const tierDefaultFromRow = (row: {
    workspaceId: string
    tier: CustomLlmTier
    profileId: string
    updatedAt: Date
  }): WorkspaceCustomLlmTierDefault => row

  return {
    async list({ actingUserId, workspaceId }) {
      const [endpoints, profiles] = await Promise.all([
        queryWithRLS<EndpointRow>(
          actingUserId,
          `SELECT ${ENDPOINT_COLS}
             FROM workspace_custom_llm_endpoints
            WHERE workspace_id = $1
            ORDER BY lower(name), created_at`,
          [workspaceId],
        ),
        queryWithRLS<WorkspaceCustomLlmProfile>(
          actingUserId,
          `SELECT ${PROFILE_COLS}
             FROM workspace_custom_llm_profiles
            WHERE workspace_id = $1
            ORDER BY lower(name), created_at`,
          [workspaceId],
        ),
      ])
      return endpoints.rows.map((endpoint) => ({
        ...endpoint,
        profiles: profiles.rows.filter((profile) => profile.endpointId === endpoint.id),
      }))
    },

    async listProfiles({ actingUserId, workspaceId }) {
      const result = await queryWithRLS<WorkspaceCustomLlmProfile>(
        actingUserId,
        `SELECT ${PROFILE_COLS}
           FROM workspace_custom_llm_profiles
          WHERE workspace_id = $1
          ORDER BY lower(name), created_at`,
        [workspaceId],
      )
      return result.rows
    },

    async listTierDefaults({ actingUserId, workspaceId }) {
      const result = await queryWithRLS<WorkspaceCustomLlmTierDefault>(
        actingUserId,
        `SELECT workspace_id AS "workspaceId", tier,
                profile_id AS "profileId", updated_at AS "updatedAt"
           FROM workspace_custom_llm_tier_defaults
          WHERE workspace_id = $1
          ORDER BY tier`,
        [workspaceId],
      )
      return result.rows.map(tierDefaultFromRow)
    },

    async create({ actingUserId, workspaceId, input }) {
      const id = randomUUID()
      const encrypted = encryptOptional(input.apiKey)
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await applyRLSGucs(client, actingUserId)
        const endpointResult = await client.query<EndpointRow>(
          `INSERT INTO workspace_custom_llm_endpoints
             (id, workspace_id, name, base_url, api_key_encrypted)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING ${ENDPOINT_COLS}`,
          [id, workspaceId, input.name, input.baseUrl, encrypted],
        )
        const profileResult = await client.query<WorkspaceCustomLlmProfile>(
          `INSERT INTO workspace_custom_llm_profiles
             (id, endpoint_id, workspace_id, name, model_id, context_window,
              max_output_tokens, supports_tools, verified_at)
           VALUES ($1, $1, $2, $3, $4, $5, $6, true, $7)
           RETURNING ${PROFILE_COLS}`,
          [id, workspaceId, input.name, input.modelId, input.contextWindow, input.maxOutputTokens, input.verifiedAt],
        )
        await client.query('COMMIT')
        return { ...endpointResult.rows[0]!, profiles: [profileResult.rows[0]!] }
      } finally {
        await rollbackAndRelease(client)
      }
    },

    async createProfile({ actingUserId, workspaceId, endpointId, input }) {
      const result = await queryWithRLS<WorkspaceCustomLlmProfile>(
        actingUserId,
        `INSERT INTO workspace_custom_llm_profiles
           (endpoint_id, workspace_id, name, model_id, context_window,
            max_output_tokens, supports_tools, verified_at)
         SELECT e.id, e.workspace_id, $3, $4, $5, $6, true, $7
           FROM workspace_custom_llm_endpoints e
          WHERE e.workspace_id = $1 AND e.id = $2
         RETURNING ${PROFILE_COLS}`,
        [workspaceId, endpointId, input.name, input.modelId, input.contextWindow, input.maxOutputTokens, input.verifiedAt],
      )
      return result.rows[0] ?? null
    },

    async updateProfile({ actingUserId, workspaceId, endpointId, profileId, input }) {
      const result = await queryWithRLS<WorkspaceCustomLlmProfile>(
        actingUserId,
        `UPDATE workspace_custom_llm_profiles
            SET name = $4,
                model_id = $5,
                context_window = $6,
                max_output_tokens = $7,
                supports_tools = true,
                verified_at = $8,
                updated_at = now()
          WHERE workspace_id = $1 AND endpoint_id = $2 AND id = $3
          RETURNING ${PROFILE_COLS}`,
        [workspaceId, endpointId, profileId, input.name, input.modelId, input.contextWindow, input.maxOutputTokens, input.verifiedAt],
      )
      return result.rows[0] ?? null
    },

    async delete({ actingUserId, workspaceId, endpointId }) {
      const result = await queryWithRLS(
        actingUserId,
        `DELETE FROM workspace_custom_llm_endpoints WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, endpointId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async deleteProfile({ actingUserId, workspaceId, endpointId, profileId }) {
      const result = await queryWithRLS(
        actingUserId,
        `DELETE FROM workspace_custom_llm_profiles
          WHERE workspace_id = $1 AND endpoint_id = $2 AND id = $3`,
        [workspaceId, endpointId, profileId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async setTierDefault({ actingUserId, workspaceId, tier, profileId }) {
      const result = await queryWithRLS<WorkspaceCustomLlmTierDefault>(
        actingUserId,
        `INSERT INTO workspace_custom_llm_tier_defaults
           (workspace_id, tier, profile_id, updated_by_user_id)
         SELECT p.workspace_id, $2, p.id, $4
           FROM workspace_custom_llm_profiles p
          WHERE p.workspace_id = $1 AND p.id = $3
         ON CONFLICT (workspace_id, tier)
         DO UPDATE SET profile_id = EXCLUDED.profile_id,
                       updated_by_user_id = EXCLUDED.updated_by_user_id,
                       updated_at = now()
         RETURNING workspace_id AS "workspaceId", tier,
                   profile_id AS "profileId", updated_at AS "updatedAt"`,
        [workspaceId, tier, profileId, actingUserId],
      )
      return result.rows[0] ?? null
    },

    async clearTierDefault({ actingUserId, workspaceId, tier }) {
      await queryWithRLS(
        actingUserId,
        `DELETE FROM workspace_custom_llm_tier_defaults WHERE workspace_id = $1 AND tier = $2`,
        [workspaceId, tier],
      )
    },

    async getEndpointRuntimeSystem({ workspaceId, endpointId }) {
      const result = await query<RuntimeEndpointRow>(
        `SELECT ${ENDPOINT_COLS}, api_key_encrypted AS "apiKeyEncrypted"
           FROM workspace_custom_llm_endpoints
          WHERE workspace_id = $1 AND id = $2
          LIMIT 1`,
        [workspaceId, endpointId],
      )
      const row = result.rows[0]
      if (!row) return null
      const { apiKeyEncrypted, ...endpoint } = row
      return { ...endpoint, apiKey: decryptOptional(apiKeyEncrypted) }
    },

    async getRuntimeSystem({ workspaceId, profileId }) {
      const result = await query<RuntimeProfileRow>(
        `SELECT ${RUNTIME_PROFILE_COLS}
           FROM workspace_custom_llm_profiles p
           JOIN workspace_custom_llm_endpoints e
             ON e.id = p.endpoint_id AND e.workspace_id = p.workspace_id
          WHERE p.workspace_id = $1 AND p.id = $2
            AND p.supports_tools AND p.verified_at IS NOT NULL
          LIMIT 1`,
        [workspaceId, profileId],
      )
      return runtimeProfileFromRow(result.rows[0])
    },

    async getTierRuntimeSystem({ workspaceId, tier }) {
      const result = await query<RuntimeProfileRow>(
        `SELECT ${RUNTIME_PROFILE_COLS}
           FROM workspace_custom_llm_tier_defaults d
           JOIN workspace_custom_llm_profiles p
             ON p.id = d.profile_id AND p.workspace_id = d.workspace_id
           JOIN workspace_custom_llm_endpoints e
             ON e.id = p.endpoint_id AND e.workspace_id = p.workspace_id
          WHERE d.workspace_id = $1 AND d.tier = $2
            AND p.supports_tools AND p.verified_at IS NOT NULL
          LIMIT 1`,
        [workspaceId, tier],
      )
      return runtimeProfileFromRow(result.rows[0])
    },
  }
}
