import type { WorkspaceMcpConsent } from '../workspace-mcp/consent.js'
/**
 * Workflow MCP bridge — builds the per-run tool registry for the workflow
 * executor.
 *
 * Returns `firstParty ∪ mcpTools` as a single `Map<string, Tool>`. The
 * capability catalog (`prepareComposedCatalog`, `workflow` surface profile)
 * admits the run's connectors and descriptors with metadata reads only;
 * `applyDirectCapabilities` then activates them by name through the provider
 * modules, which resolve each tool's effective policy and:
 *   - skip `block`-policy tools (not added to the map)
 *   - set `resolveConfirmation` on `ask` / `allow` tools so the executor
 *     can fail-fast on `ask` (Phase A) or pause for approval (Phase C).
 *
 * Built-in tools that declare `requiresConfirmation` (the KB write pair) ride
 * the same pause — see the `allowKnowledgeWrites` note below.
 *
 * Run once per workflow-run start; the resulting map is held immutable for
 * that run's duration. Adding/removing connectors mid-run does not affect
 * an in-flight run (good for predictability).
 *
 * [COMP:workflow/mcp-bridge]
 */

import type { KnowledgeStoreInterface, KnowledgeRepoWriter } from '@use-brian/core/knowledge/types.js'
import type { GDriveFilesStore } from '@use-brian/core/tools/base/gdrive-files.js'
import type { FilesApi } from '@use-brian/core/workspace-files/api.js'
import type { EngineHooks } from '@use-brian/agent-runtime/engine/hooks.js'
import type { McpSettingsStore } from '@use-brian/agent-runtime/mcp/types.js'
import type { TurnScope } from '@use-brian/agent-runtime/security/context-scope.js'
import type { Tool } from '@use-brian/agent-runtime/tools/types.js'
import { buildSourceServiceWorkflowTools } from './source-service.js'
import { surfaceProfile } from '../mcp/catalog.js'
import { applyDirectCapabilities, prepareComposedCatalog } from '../mcp/composition.js'
import { bindToolsToAgentAccess } from '../context-scope/agent-access-tools.js'
import type { ConnectorStore } from '../db/connector-store.js'
import type { AssistantConnectorStore } from '../db/assistant-connector-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'

export type WorkflowToolRegistryDeps = {
  /** Boot-time first-party tool map (injected once at apps/api startup). */
  firstParty: Map<string, Tool>
  connectorStore: ConnectorStore
  settingsStore: McpSettingsStore
  assistantConnectorStore?: AssistantConnectorStore
  connectorGrantStore?: ConnectorGrantStore
  connectorInstanceStore?: ConnectorInstanceStore
  workspaceToolPolicyStore?: import('../db/workspace-tool-policy-store.js').WorkspaceToolPolicyStore
  knowledgeStore?: KnowledgeStoreInterface
  /**
   * KB source write-back port. Present ⇒ a `tool_call` step may write the
   * knowledge base, gated by the executor's approval pause (see the
   * knowledge-writes note at the catalog call). Absent ⇒ only manual-KB
   * updates are reachable, and repo-backed writes are not exposed at all (the
   * catalog requires the port to emit them).
   */
  knowledgeRepoWriter?: KnowledgeRepoWriter
  gdriveFilesStore?: GDriveFilesStore
  /** Workspace-files byte layer — `gmailSendMessage` attachments on workflow
   *  `tool_call` steps (`docs/architecture/integrations/gmail.md`). */
  filesApi?: FilesApi
  engineHooks?: EngineHooks
  assistantConnectorGrantsStore?: import('../db/assistant-connector-grants-store.js').AssistantConnectorGrantsStore
}

const FORBIDDEN_WORKFLOW_REGISTRY_TOOLS = [
  'askAssistant',
  'listConnectedAssistants',
  'spawnWorker',
  'sendWorkerMessage',
  'stopWorker',
  'proposeWorkflow',
  'createWorkflow',
  'updateWorkflow',
  'runWorkflow',
  'scheduleWorkflow',
  'createScheduledJob',
  'updateScheduledJob',
  'deleteScheduledJob',
] as const

function stripOrchestrationTools(tools: Map<string, Tool>): void {
  for (const name of FORBIDDEN_WORKFLOW_REGISTRY_TOOLS) tools.delete(name)
}

/**
 * Build a tool registry for one workflow run. Snapshots both first-party
 * and MCP tools at run start.
 */
export async function buildWorkflowToolRegistry(
  deps: WorkflowToolRegistryDeps,
  scope: {
    workspaceId: string
    /** Acting assistant — typically the workspace's primary. */
    assistantId: string
    /** User who triggered the run. Null for scheduled triggers. */
    userId: string | null
    /** Optional — workflow runs do not have a per-request user timezone. */
    userTimezone?: string
    workspaceConsent?: WorkspaceMcpConsent
    turnScope?: TurnScope
  },
): Promise<Map<string, Tool> & { discoveryWarnings?: readonly string[] }> {
  if(scope.turnScope){const service=await buildSourceServiceWorkflowTools(scope.turnScope);if(service)return service}
  // Start from a fresh shallow copy so first-party tool entries aren't
  // mutated (activation attaches a `resolveConfirmation` closure to any tool
  // it builds; we never want that on the boot-time entries).
  const tools = new Map<string, Tool>(deps.firstParty)

  // For scheduled triggers there is no user. Fall back to the workflow's
  // creator at the call site (executor passes that). Here we require
  // a userId — the executor is responsible for substituting if missing.
  if (!scope.userId) {
    // Without a user we cannot resolve MCP policies (mcp_tool_settings is
    // keyed by user). Skip MCP entirely; first-party tools still work.
    // Phase B's scheduled trigger always passes the workflow.created_by
    // here so this branch is a defensive no-op.
    if (scope.workspaceConsent) for (const name of tools.keys()) if (!scope.workspaceConsent.operationNames.includes(name)) tools.delete(name)
    stripOrchestrationTools(tools)
    return tools
  }

  // The direct activation mutates `tools` in place. Block-policy tools are
  // skipped; ask-policy tools get a `resolveConfirmation` closure that the
  // executor checks before invoking.
  //
  // The `workflow` profile keeps built-ins direct: the workflow executor
  // inspects each built-in's `requiresConfirmation` and routes ask-policy
  // pauses through the `kind='workflow_step'` unified-approvals surface +
  // per-step permission grants. Routing built-ins through `mcp_call` would
  // hide those flags from the executor.
  //
  // It also keeps dynamic tools direct: server-side registry adapters for
  // custom HTTP/CLI tools. A deterministic tool_call cannot perform a model
  // search/call sequence, and the adapter keeps policy + hooks intact while
  // exposing the metadata the workflow approval gate needs. See
  // docs/architecture/integrations/mcp.md → "Tool search pattern" and
  // docs/architecture/features/workflow.md → "Unified approvals".
  const composed = await prepareComposedCatalog({
    // A consented workspace-MCP run narrows the folded dynamic sources to the
    // consented operation names; the profile can never be widened.
    profile: surfaceProfile('workflow', scope.workspaceConsent ? { restrictSearchToToolNames: scope.workspaceConsent.operationNames } : {}),
    assistant: { id: scope.assistantId, workspaceId: scope.workspaceId },
    connectorUserId: scope.userId,
    contextScope: scope.turnScope,
    bindingMaximum: scope.workspaceConsent?.connectorBindings,
    stores: {
      connectorStore: deps.connectorStore,
      connectorInstanceStore: deps.connectorInstanceStore,
      connectorGrantStore: deps.connectorGrantStore,
      assistantConnectorStore: deps.assistantConnectorStore,
    },
    // No grants store wired (legacy call sites, tests) ⇒ no grant filter, as before.
    actionGrantReader: deps.assistantConnectorGrantsStore ? undefined : null,
    // KB writes ARE exposed here (the `workflow` profile's knowledge writes),
    // and are governed by the executor's own approval pause rather than a chat
    // Approve/Deny card. Both write tools carry `requiresConfirmation: true`,
    // and the direct profile (above) is what keeps that flag visible to the
    // executor: `dispatchToolCall` reads it, routes to `askPolicyOutcome`, and
    // — with `deps.requestApproval` wired — pauses the run on a
    // `kind='workflow_step'` approval carrying frozen arguments. So a workflow
    // never writes the KB unattended; it parks in the Approvals inbox exactly
    // like an ask-policy MCP tool.
    //
    // This is what makes the `knowledge` event source a closed loop: an entry
    // changes → a workflow wakes → it drafts an edit → a human approves it.
    // Without the write half the loop can only ever notify.
    //
    // Deliberately NOT extended to `assistant_call` steps: the callee executor
    // strips confirmation UX (`inter-assistant/executor.ts` keeps
    // `allowKnowledgeWrites: false`), so a KB write there would have no gate.
    // Author the decision as an `assistant_call` and the write as a
    // `tool_call`.
    ...(deps.knowledgeStore ? { knowledge: { store: deps.knowledgeStore, repoWriter: deps.knowledgeRepoWriter } } : {}),
    composition: {
      stores: {
        connectorStore: deps.connectorStore,
        settingsStore: deps.settingsStore,
        assistantConnectorStore: deps.assistantConnectorStore,
        connectorGrantStore: deps.connectorGrantStore,
        connectorInstanceStore: deps.connectorInstanceStore,
        workspaceToolPolicyStore: deps.workspaceToolPolicyStore,
        assistantConnectorGrantsStore: deps.assistantConnectorGrantsStore,
        gdriveFilesStore: deps.gdriveFilesStore,
        knowledgeStore: deps.knowledgeStore,
        knowledgeRepoWriter: deps.knowledgeRepoWriter,
      },
      userTimezone: scope.userTimezone,
      attachments: { filesApi: deps.filesApi },
      hosted: { engineHooks: deps.engineHooks },
    },
  })
  const unavailable = await applyDirectCapabilities(tools, composed, { settingsStore: deps.settingsStore, hooks: deps.engineHooks })

  if (scope.workspaceConsent) for (const name of tools.keys()) if (!scope.workspaceConsent.operationNames.includes(name)) tools.delete(name)
  stripOrchestrationTools(tools)
  const registry = scope.turnScope ? bindToolsToAgentAccess(tools, {
    clearance: scope.turnScope.access.clearance,
    compartments: scope.turnScope.effectiveCompartments,
    mutationCompartments: scope.turnScope.access.mutationCompartments,
    projectIds: scope.turnScope.effectiveProjectIds,
    visibilityAssistantIds: scope.turnScope.access.visibilityAssistantIds,
  }) : tools
  // Preserve discovery diagnostics through access binding so a missing tool
  // reports the scope/policy limitation rather than suggesting reconnection.
  return Object.assign(registry, { discoveryWarnings: unavailable })
}
