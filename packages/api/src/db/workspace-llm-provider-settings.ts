/**
 * Workspace LLM provider settings store.
 *
 * Persistence foundation for workspace-scoped bring-your-own provider keys.
 * The only provider enabled by the schema today is Gemini. API keys are
 * encrypted at rest with AES-256-GCM using this byte layout:
 *
 *   [iv (12 bytes)] [authTag (16 bytes)] [ciphertext (variable)]
 *
 * The key is supplied by LLM_PROVIDER_KEY_ENCRYPTION_KEY as a base64-encoded
 * 32-byte value. User-facing reads return only masked metadata; plaintext is
 * available solely through the system accessor used by provider construction.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { query, queryWithRLS } from './client.js'

const IV_LENGTH = 12
const TAG_LENGTH = 16

export type LlmProvider = 'gemini'

export type WorkspaceLlmProviderSetting = {
  id: string
  workspaceId: string
  provider: LlmProvider
  isByok: boolean
  createdAt: Date
  updatedAt: Date
}

export type MaskedWorkspaceLlmProviderKey = {
  provider: LlmProvider
  isSet: boolean
  last4: string | null
}

export type WorkspaceLlmProviderSettingsStore = {
  get(params: {
    actingUserId: string
    workspaceId: string
    provider?: LlmProvider
  }): Promise<WorkspaceLlmProviderSetting | null>

  set(params: {
    actingUserId: string
    workspaceId: string
    provider?: LlmProvider
    apiKey: string
  }): Promise<WorkspaceLlmProviderSetting>

  delete(params: {
    actingUserId: string
    workspaceId: string
    provider?: LlmProvider
  }): Promise<boolean>

  getMasked(params: {
    actingUserId: string
    workspaceId: string
    provider?: LlmProvider
  }): Promise<MaskedWorkspaceLlmProviderKey>

  getPlaintextKeySystem(params: {
    workspaceId: string
    provider?: LlmProvider
  }): Promise<string | null>
}

const PUBLIC_COLS = `
  id,
  workspace_id AS "workspaceId",
  provider,
  is_byok AS "isByok",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
`

type WorkspaceLlmProviderSettingRow = WorkspaceLlmProviderSetting

export function loadLlmProviderKeyEncryptionKey(base64Key: string | undefined): Buffer {
  if (!base64Key) {
    throw new Error(
      'LLM_PROVIDER_KEY_ENCRYPTION_KEY is required to manage workspace LLM provider keys. ' +
        'Generate one with: openssl rand -base64 32',
    )
  }
  const key = Buffer.from(base64Key, 'base64')
  if (key.length !== 32) {
    throw new Error(
      `LLM_PROVIDER_KEY_ENCRYPTION_KEY must decode to exactly 32 bytes (got ${key.length}). ` +
        'Generate with: openssl rand -base64 32',
    )
  }
  return key
}

export function encryptApiKey(apiKey: string, key: Buffer): Buffer {
  const iv = randomBytes(IV_LENGTH)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  const plaintext = Buffer.from(apiKey, 'utf8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ciphertext])
}

export function decryptApiKey(blob: Buffer, key: Buffer): string {
  if (blob.length < IV_LENGTH + TAG_LENGTH) {
    throw new Error('workspace_llm_provider_settings: ciphertext blob too short')
  }
  const iv = blob.subarray(0, IV_LENGTH)
  const tag = blob.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH)
  const ciphertext = blob.subarray(IV_LENGTH + TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, iv)
  decipher.setAuthTag(tag)
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
  return plaintext.toString('utf8')
}

export function createDbWorkspaceLlmProviderSettingsStore(
  encryptionKey: Buffer,
): WorkspaceLlmProviderSettingsStore {
  return {
    async get(params) {
      const provider = params.provider ?? 'gemini'
      const result = await queryWithRLS<WorkspaceLlmProviderSettingRow>(
        params.actingUserId,
        `SELECT ${PUBLIC_COLS}
         FROM workspace_llm_provider_settings
         WHERE workspace_id = $1 AND provider = $2
         LIMIT 1`,
        [params.workspaceId, provider],
      )
      return result.rows[0] ?? null
    },

    async set(params) {
      const provider = params.provider ?? 'gemini'
      const encrypted = encryptApiKey(params.apiKey, encryptionKey)
      const result = await queryWithRLS<WorkspaceLlmProviderSettingRow>(
        params.actingUserId,
        `INSERT INTO workspace_llm_provider_settings
           (workspace_id, provider, api_key_encrypted, is_byok)
         VALUES ($1, $2, $3, true)
         ON CONFLICT (workspace_id, provider)
         DO UPDATE SET
           api_key_encrypted = EXCLUDED.api_key_encrypted,
           is_byok = true,
           updated_at = now()
         RETURNING ${PUBLIC_COLS}`,
        [params.workspaceId, provider, encrypted],
      )
      return result.rows[0]
    },

    async delete(params) {
      const provider = params.provider ?? 'gemini'
      const result = await queryWithRLS(
        params.actingUserId,
        `DELETE FROM workspace_llm_provider_settings
         WHERE workspace_id = $1 AND provider = $2`,
        [params.workspaceId, provider],
      )
      return (result.rowCount ?? 0) > 0
    },

    async getMasked(params) {
      const provider = params.provider ?? 'gemini'
      const result = await queryWithRLS<{ api_key_encrypted: Buffer }>(
        params.actingUserId,
        `SELECT api_key_encrypted
         FROM workspace_llm_provider_settings
         WHERE workspace_id = $1 AND provider = $2
         LIMIT 1`,
        [params.workspaceId, provider],
      )
      const row = result.rows[0]
      if (!row) return { provider, isSet: false, last4: null }
      const plaintext = decryptApiKey(row.api_key_encrypted, encryptionKey)
      return { provider, isSet: true, last4: plaintext.slice(-4) }
    },

    async getPlaintextKeySystem(params) {
      const provider = params.provider ?? 'gemini'
      const result = await query<{ api_key_encrypted: Buffer }>(
        `SELECT api_key_encrypted
         FROM workspace_llm_provider_settings
         WHERE workspace_id = $1 AND provider = $2
         LIMIT 1`,
        [params.workspaceId, provider],
      )
      const row = result.rows[0]
      return row ? decryptApiKey(row.api_key_encrypted, encryptionKey) : null
    },
  }
}

