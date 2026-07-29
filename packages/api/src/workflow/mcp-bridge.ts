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
 * Built-in tools that declare `requiresConfirmation` (the KB write pair) ride
 * the same pause — see the `allowKnowledgeWrites` note below.
 *
 * Run once per workflow-run start; the resulting map is held immutable for
 * that run's duration. Adding/removing connectors mid-run does not affect
 * an in-flight run (good for predictability).
 *
 * [COMP:workflow/mcp-bridge]
 */

import type { Tool, KnowledgeStoreInterface, KnowledgeRepoWriter, GDriveFilesStore, McpSettingsStore, FilesApi } from '@use-brian/core'
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
  workspaceToolPolicyStore?: import('../db/workspace-tool-policy-store.js').WorkspaceToolPolicyStore
  knowledgeStore?: KnowledgeStoreInterface
  /**
   * KB source write-back port. Present ⇒ a `tool_call` step may write the
   * knowledge base, gated by the executor's approval pause (see the
   * `allowKnowledgeWrites` note at the injection call). Absent ⇒ only
   * manual-KB updates are reachable, and repo-backed writes are not exposed
   * at all (`injectMcpTools` requires the port to emit them).
   */
  knowledgeRepoWriter?: KnowledgeRepoWriter
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
    workspaceToolPolicyStore: deps.workspaceToolPolicyStore,
    assistantTeamId: scope.workspaceId,
    keepBuiltinsDirect: true,
    // KB writes ARE exposed here, and are governed by the executor's own
    // approval pause rather than a chat Approve/Deny card. Both write tools
    // carry `requiresConfirmation: true`, and `keepBuiltinsDirect` (above) is
    // what keeps that flag visible to the executor: `dispatchToolCall` reads
    // it, routes to `askPolicyOutcome`, and — with `deps.requestApproval`
    // wired — pauses the run on a `kind='workflow_step'` approval carrying
    // frozen arguments. So a workflow never writes the KB unattended; it
    // parks in the Approvals inbox exactly like an ask-policy MCP tool.
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
    allowKnowledgeWrites: true,
    knowledgeRepoWriter: deps.knowledgeRepoWriter,
    filesApi: deps.filesApi,
  })

  return tools
}
