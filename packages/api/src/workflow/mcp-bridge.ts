/**
 * Workflow MCP bridge — builds the per-run tool registry for the workflow
 * executor.
 *
 * Returns `firstParty ∪ mcpTools` as a single `Map<string, Tool>`. The
 * `injectMcpTools` call resolves each MCP tool's effective policy and:
 *   - skips `block`-policy tools (not added to the map)
 *   - sets `resolveConfirmation` on `ask` / `allow` tools so the executor
 *     can fail-fast on `ask` (Phase A) or pause for approval (Phase C).
 *
 * Run once per workflow-run start; the resulting map is held immutable for
 * that run's duration. Adding/removing connectors mid-run does not affect
 * an in-flight run (good for predictability).
 *
 * [COMP:workflow/mcp-bridge]
 */

import type { Tool, KnowledgeStoreInterface, GDriveFilesStore, McpSettingsStore, FilesApi } from '@sidanclaw/core'
import { injectMcpTools } from '../mcp/inject.js'
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
  knowledgeStore?: KnowledgeStoreInterface
  gdriveFilesStore?: GDriveFilesStore
  /** Workspace-files byte layer — `gmailSendMessage` attachments on workflow
   *  `tool_call` steps (`docs/architecture/integrations/gmail.md`). */
  filesApi?: FilesApi
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
  },
): Promise<Map<string, Tool>> {
  // Start from a fresh shallow copy so first-party tool entries aren't
  // mutated (injectMcpTools attaches a `resolveConfirmation` closure to
  // any tool it touches; we never want that on the boot-time entries).
  const tools = new Map<string, Tool>(deps.firstParty)

  // For scheduled triggers there is no user. Fall back to the workflow's
  // creator at the call site (executor passes that). Here we require
  // a userId — the executor is responsible for substituting if missing.
  if (!scope.userId) {
    // Without a user we cannot resolve MCP policies (mcp_tool_settings is
    // keyed by user). Skip MCP entirely; first-party tools still work.
    // Phase B's scheduled trigger always passes the workflow.created_by
    // here so this branch is a defensive no-op.
    return tools
  }

  // The MCP injection mutates `tools` in place. Block-policy tools are
  // skipped; ask-policy tools get a `resolveConfirmation` closure that
  // the executor checks before invoking.
  //
  // `keepBuiltinsDirect: true` — preserves the workflow executor's
  // ability to inspect each built-in's `requiresConfirmation` and route
  // ask-policy pauses through the `kind='workflow_step'` unified-approvals
  // surface + per-step permission grants. Routing built-ins through
  // `mcp_call` would hide those flags from the executor. Custom MCP
  // still goes through `mcp_search` / `mcp_call` here for the token
  // win. See docs/architecture/integrations/mcp.md → "Tool search
  // pattern" and docs/architecture/features/workflow.md → "Unified
  // approvals".
  await injectMcpTools({
    userId: scope.userId,
    assistantId: scope.assistantId,
    tools,
    connectorStore: deps.connectorStore,
    settingsStore: deps.settingsStore,
    assistantConnectorStore: deps.assistantConnectorStore,
    userTimezone: scope.userTimezone,
    knowledgeStore: deps.knowledgeStore,
    gdriveFilesStore: deps.gdriveFilesStore,
    connectorGrantStore: deps.connectorGrantStore,
    connectorInstanceStore: deps.connectorInstanceStore,
    assistantTeamId: scope.workspaceId,
    keepBuiltinsDirect: true,
    filesApi: deps.filesApi,
  })

  return tools
}
