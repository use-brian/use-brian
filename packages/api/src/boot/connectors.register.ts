/**
 * Connector, skill, channel-integration and custom-LLM stores.
 *
 * Boot register module registerConnectors: one ordered step of the open composition
 * root `bootOpenApi` (packages/api/src/boot.ts). It receives the bindings the
 * earlier steps built (`ConnectorsScope`) and returns the ones later
 * steps consume. Statement order, route mount order and every injected
 * dependency are those of the former inline boot body; see
 * docs/architecture/platform/deployment.md -> "Boot composition".
 *
 * INVARIANT: never import `@use-brian/api-platform/*` or
 * `@use-brian/shared-server` (closed code arrives through OpenApiPorts).
 */
import { createConnectorActorKeyStore } from '../application-platform/connector-actor-keys.js'
import {
  createConnectorSourceRuntimeFactory, configureConnectorSourceRuntimeFactory,
} from '../application-platform/source-runtime.js'
import { randomUUID } from 'node:crypto'
import { isSelfHostedOssEnv } from '../routes/local-session.js'
import { createDbMcpSettingsStore } from '../db/mcp-settings-store.js'
import { createDbConnectorStore } from '../db/connector-store.js'
import { createConnectorInstanceStore } from '../db/connector-instance-store.js'
import { createConnectorAppCredentialStore } from '../db/connector-app-credential-store.js'
import { createWorkspaceToolPolicyStore } from '../db/workspace-tool-policy-store.js'
import { createDbAssistantConnectorStore } from '../db/assistant-connector-store.js'
import { createDbAssistantConnectorGrantsStore } from '../db/assistant-connector-grants-store.js'
import { createDbSkillStore, type WorkspaceSkill, createDbWorkspaceSkillStore } from '../db/skill-store.js'
import { makeSkillEdgeRecomputer } from '../db/skill-edge-service.js'
import { createDbWorkspaceSkillFilesStore } from '../db/workspace-skill-files-store.js'
import { createDbWorkspaceSkillEnablementStore } from '../db/workspace-skill-enablement-store.js'
import { createDbSkillCuratorDigestStore } from '../db/skill-curator-digest-store.js'
import { loadSkillRegistry } from '../registry/load-skill-registry.js'
import { syncWorkspaceNativeSlashCommands } from '../routes/native-slash-commands.js'
import { createCustomChannelStore } from '../db/custom-channel-store.js'
import { createIngestRulesStore } from '../db/ingest-rules-store.js'
import { createIngestRuleEditorStore } from '../db/ingest-rules-editor-store.js'
import { createDocGateway } from '../doc/doc-gateway.js'
import { createChannelQuestionStore } from '../workflow/channel-questions.js'
import { createDbDocPageStore } from '../db/doc-page-store.js'
import { createDbJobStore } from '../db/job-store.js'
import { createDbSessionResumeStore } from '../db/session-resume-store.js'
import { createDbWorkerRunsStore } from '../db/worker-runs-store.js'
import { createDbCapabilityStore } from '../db/capability-store.js'
import { loadChannelCredentialKey, createDbChannelIntegrationStore } from '../db/channel-integrations.js'
import { createChannelIdentityBindingStore } from '../db/channel-identity-bindings.js'
import { createDbApiKeyStore } from '../db/api-key-store.js'
import { createDbBrainKeyStore } from '../db/brain-keys-store.js'
import { createProgrammaticCaptureStore } from '../db/programmatic-capture-store.js'
import {
  loadLlmProviderKeyEncryptionKey, createDbWorkspaceLlmProviderSettingsStore,
} from '../db/workspace-llm-provider-settings.js'
import { createDbWorkspaceCustomLlmEndpointStore } from '../db/workspace-custom-llm-endpoints.js'
import { createWorkspaceCustomLlmResolver } from '../custom-llm-runtime.js'
import { query } from '../db/client.js'
import type { ConnectorsScope } from './scope.js'

export function registerConnectors(scope: ConnectorsScope) {
  const {
    env, bootGeminiCredential, provider, selectKeyedMediaBackend, unavailableMediaBackend,
    scheduleNativeSlashCommandSync, entityLinksStore, sharedEmbedder, documentDistill, distillateCache,
    workflowStore, late,
  } = scope
  const voiceTranscription = {
    enabled: env.VOICE_TRANSCRIPTION_ENABLED ?? false,
    apiKey: bootGeminiCredential?.secret ?? env.GEMINI_API_KEY ?? '',
    get backend() { return selectKeyedMediaBackend() ?? unavailableMediaBackend },
    model: env.VOICE_TRANSCRIPTION_MODEL,
  }
  const docGateway = createDocGateway()
  const docPageStore = createDbDocPageStore()
  const jobStore = createDbJobStore()
  const sessionResumeStore = createDbSessionResumeStore()
  const workerRunsStore = createDbWorkerRunsStore()
  const capabilityStore = createDbCapabilityStore()
  const mcpSettingsStore = createDbMcpSettingsStore()
  const credKey = env.CHANNEL_CREDENTIAL_KEY ? loadChannelCredentialKey(env.CHANNEL_CREDENTIAL_KEY) : null
  const connectorInstanceStore = createConnectorInstanceStore(credKey)
  const connectorSourceRuntimeFactory = createConnectorSourceRuntimeFactory({ issuer: env.API_URL,
    keys: credKey ? createConnectorActorKeyStore(credKey) : undefined, instances: connectorInstanceStore })
  configureConnectorSourceRuntimeFactory(connectorSourceRuntimeFactory, { instances: connectorInstanceStore })
  // Workspace-owned OAuth app credentials (migration 394) — a customer's own
  // Entra registration, resolved ahead of deployment config. See
  // docs/architecture/integrations/msgraph.md → "Auth".
  const connectorAppCredentialStore = createConnectorAppCredentialStore(credKey)
  // Shared workspace tool policy (migration 312) — governs allow/ask/block for
  // team-owned connector tools. See workspace-owned-connector-transfer.md §2C.
  const workspaceToolPolicyStore = createWorkspaceToolPolicyStore()
  const ingestRulesStore = createIngestRulesStore()
  const ingestRuleEditorStore = createIngestRuleEditorStore()
  const connectorStore = createDbConnectorStore(credKey)
  const assistantConnectorStore = createDbAssistantConnectorStore()
  const assistantConnectorGrantsStore = createDbAssistantConnectorGrantsStore()
  const skillStore = createDbSkillStore()
  let recomputeSkillEdgesOnWrite:
    | ((skill: WorkspaceSkill, options?: { retiredResourceIds?: readonly string[] }) => void)
    | undefined
  const workspaceSkillStore = createDbWorkspaceSkillStore({
    onWritten: (skill) => recomputeSkillEdgesOnWrite?.(skill),
    onCommandRosterChanged: (userId, workspaceId) =>
      scheduleNativeSlashCommandSync(userId, workspaceId),
  })
  const workspaceSkillFilesStore = createDbWorkspaceSkillFilesStore({
    onChanged: (workspaceSkillId, retiredResourceIds) => {
      void workspaceSkillStore.getByIdSystem(workspaceSkillId).then((skill) => {
        if (skill) recomputeSkillEdgesOnWrite?.(skill, { retiredResourceIds })
      }).catch((err) => {
        console.error(`[skill-edge-service] resource-change lookup failed (skill=${workspaceSkillId}):`, err)
      })
    },
  })
  recomputeSkillEdgesOnWrite = makeSkillEdgeRecomputer({
    entityLinks: entityLinksStore,
    connectorInstanceStore,
    workspaceSkillStore,
    workspaceSkillFilesStore,
  })
  const workspaceSkillEnablementStore = createDbWorkspaceSkillEnablementStore()
  const skillCuratorDigestStore = createDbSkillCuratorDigestStore()
  const curatorEmbedder = sharedEmbedder
  const skillReviewLeaseHolderId = randomUUID()
  const communitySkillRegistry = loadSkillRegistry()

  const integrationStore = credKey ? createDbChannelIntegrationStore(credKey) : null
  late.integrationStore = integrationStore
  // Canonical channel identity bindings (migration 743) - the WeChat staff
  // identity slice. Same key as the integrations it rotates; its challenge
  // digest derives a separate key under its own domain string.
  const channelIdentityStore = credKey ? createChannelIdentityBindingStore(credKey) : null
  const channelQuestionStore = createChannelQuestionStore()
  late.syncNativeSlashCommands = integrationStore
    ? (userId: string, workspaceId: string) => syncWorkspaceNativeSlashCommands({
        userId,
        workspaceId,
        skillStore,
        workflowStore,
        integrationStore,
      })
    : undefined
  // Custom (bridge-driven) channel state + outbox (migration 450). Internal
  // path, no RLS — reachable only through the bridge token or member routes.
  const customChannelStore = createCustomChannelStore()
  const apiKeyStore = createDbApiKeyStore()
  const brainKeyStore = createDbBrainKeyStore()
  const programmaticCaptureStore = createProgrammaticCaptureStore()
  const llmProviderEncryptionKey = (() => {
    if (!env.LLM_PROVIDER_KEY_ENCRYPTION_KEY) return null
    try {
      return loadLlmProviderKeyEncryptionKey(env.LLM_PROVIDER_KEY_ENCRYPTION_KEY)
    } catch (err) {
      console.warn('[provider] LLM_PROVIDER_KEY_ENCRYPTION_KEY invalid — provider bearer-key storage disabled:', (err as Error).message)
      return null
    }
  })()
  const llmProviderSettingsStore = llmProviderEncryptionKey
    ? createDbWorkspaceLlmProviderSettingsStore(llmProviderEncryptionKey)
    : null
  const resolveWorkspaceByoGeminiKey = async (workspaceId: string): Promise<string | null> => {
    if (llmProviderSettingsStore) {
      return llmProviderSettingsStore.getPlaintextKeySystem({ workspaceId, provider: 'gemini' })
    }
    const existing = await query<{ present: boolean }>(
      `SELECT true AS present FROM workspace_llm_provider_settings
        WHERE workspace_id = $1 AND provider = 'gemini' LIMIT 1`,
      [workspaceId],
    )
    if (existing.rows[0]?.present) {
      throw new Error('Workspace Gemini key exists but LLM_PROVIDER_KEY_ENCRYPTION_KEY is unavailable')
    }
    return null
  }
  const customLlmNetworkPolicy = isSelfHostedOssEnv() ? 'private-network' : 'public-only'
  const customLlmEndpointStore = createDbWorkspaceCustomLlmEndpointStore(llmProviderEncryptionKey ?? undefined)
  const resolveWorkspaceCustomLlm = createWorkspaceCustomLlmResolver(customLlmEndpointStore, {
    networkPolicy: customLlmNetworkPolicy,
    managedProvider: provider,
    documentAdaptation: { distill: documentDistill, cache: distillateCache },
  })

  return {
    integrationStore, credKey, connectorInstanceStore, connectorSourceRuntimeFactory, workspaceSkillStore,
    workspaceSkillFilesStore, skillStore, llmProviderSettingsStore, customLlmEndpointStore,
    customLlmNetworkPolicy, resolveWorkspaceCustomLlm, jobStore, channelQuestionStore, customChannelStore,
    mcpSettingsStore, programmaticCaptureStore, workerRunsStore, connectorStore, assistantConnectorStore,
    workspaceToolPolicyStore, assistantConnectorGrantsStore, capabilityStore, apiKeyStore,
    workspaceSkillEnablementStore, docPageStore, brainKeyStore, resolveWorkspaceByoGeminiKey,
    communitySkillRegistry, sessionResumeStore, voiceTranscription, docGateway, channelIdentityStore,
    connectorAppCredentialStore, skillCuratorDigestStore, curatorEmbedder, skillReviewLeaseHolderId,
    ingestRulesStore, ingestRuleEditorStore, syncNativeSlashCommands: late.syncNativeSlashCommands,
  } as const
}
