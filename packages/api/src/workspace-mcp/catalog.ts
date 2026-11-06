/** Canonical native tool projection for explicitly admitted MCP work. [COMP:api/workspace-mcp] */
import type { executeWorkspaceMcpOperation } from './operations.js'
import { randomUUID } from 'node:crypto'
import {
  createLoopDetector, createToolExecutor, filterToolsByCapabilities, formatToolError,
  type ConfirmationResolver, type Tool, type ToolContext, type ToolResult,
} from '@use-brian/core'
import type { BrainTool } from '../brain-mcp/tools.js'
import { runWithAgentAccess } from '../db/client.js'
import { createWorkspaceDiscoveryTools, describeWorkspaceOperation, workspaceDiscoveryNames } from './discovery.js'

/** Host-owned facts. None of these fields are accepted from tool arguments. */
type WorkspaceMcpAdmission = {
  context: ToolContext
  tools: ReadonlyMap<string, Tool>
  /** The credential's explicitly consented operation maximum. */
  operationNames: ReadonlySet<string>
  readOnly: boolean
  executeOperation?: typeof executeWorkspaceMcpOperation
}

type ResolveAdmission = () => Promise<WorkspaceMcpAdmission>
const MAX_STRUCTURED_RESULT_CHARS = 64_000

function admittedTools(admission: WorkspaceMcpAdmission): Map<string, Tool> {
  return filterToolsByCapabilities(new Map([...admission.tools].filter(([name, tool]) =>
    admission.operationNames.has(name) && (!admission.readOnly || tool.isReadOnly === true),
  )), admission.context.activeCapabilities ?? new Set())
}

function failure(code: string, message: string) {
  return {
    isError: true,
    content: [{ type: 'text' as const, text: message }],
    structuredContent: { status: 'failed', code, message },
  }
}

/**
 * Discovery is a projection of native registration, not another tool whitelist.
 * Invocation re-resolves admission; a discovery snapshot never grants execution.
 */
export async function buildWorkspaceMcpCatalog(resolveAdmission: ResolveAdmission, includeDiscovery = true): Promise<BrainTool[]> {
  const admission = await resolveAdmission()
  const authority = admission.context.executionContext?.security.authority
  if (!authority) throw new Error('Workspace MCP requires canonical execution authority.')
  await authority.assertCurrent()
  const tools = admittedTools(admission)
  if ([...tools.keys()].some(name => (workspaceDiscoveryNames as readonly string[]).includes(name))) throw new Error('Reserved workspace discovery operation')
  const catalog = [...tools.values()].map<BrainTool>(tool => {
    return {
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      handler: async (input, invocation) => {
        try {
          const current = await resolveAdmission()
          const security = current.context.executionContext?.security
          if (!security || current.context.authority !== security.authority) {
            return failure('authority_unavailable', 'This operation has no current workspace authority.')
          }
          const execute = () => security.authority.execute(async () => {
            const selected = admittedTools(current).get(tool.name)
            if (!selected) return failure('operation_unavailable', 'This operation is no longer available to this connection.')
            if (invocation?.schemaRevision && describeWorkspaceOperation(selected).schemaRevision !== invocation.schemaRevision) {
              return failure('schema_changed', 'Fetch the current operation schema before calling.')
            }
            return executeWorkspaceNativeTool(selected, current.context, input)
          })
          return current.executeOperation
            ? await current.executeOperation({ context: current.context, name: tool.name, input,
              operationId: invocation?.operationId, isReadOnly: admittedTools(current).get(tool.name)?.isReadOnly === true, execute })
            : await execute()
        } catch {
          // A lost result after an effect is not a retry-safe failure. Do not
          // expose a protected payload or replay it after authority changes.
          return failure('operation_interrupted', 'The operation was interrupted or access changed. Check its outcome before retrying.')
        }
      },
    }
  })
  return includeDiscovery && admission.executeOperation
    ? [...catalog, ...createWorkspaceDiscoveryTools(() => buildWorkspaceMcpCatalog(resolveAdmission, false))] : catalog
}

/** Shared native executor for direct calls and a verified frozen approval. */
export async function executeWorkspaceNativeTool(selected: Tool, context: ToolContext, input: Record<string, unknown>, confirmationResolver?: ConfirmationResolver) {
  const parsed = selected.inputSchema.safeParse(input)
  if (!parsed.success) return failure('invalid_input', formatToolError(parsed.error))
  // Parse before invoking the native executor, including before its
  // confirmation preview. Preserve the native schema/defaults there.
  let original: ToolResult | undefined
  let approvalId: string | undefined
  const executor = createToolExecutor({
    tools: new Map([[selected.name, selected]]),
    context,
    confirmationResolver,
    loopDetector: createLoopDetector(),
    onToolEnd: (_id, _name, result) => { original = result },
    onAwaitingApproval: event => { if (!confirmationResolver) approvalId = event.approvalId },
  })
  const callId = randomUUID()
  const content: Array<{ type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string }> = []
  let isError = false
  await runWithAgentAccess(context.executionContext!.security.access, async () => {
    executor.addTool(callId, selected.name, input)
    for await (const batch of executor.getRemainingResults()) {
      for (const block of batch.blocks) {
        if (block.type === 'tool_result') {
          content.push({ type: 'text', text: block.content })
          isError ||= block.isError === true
        } else if (block.type === 'image') {
          content.push({ type: 'image', data: block.data, mimeType: block.mimeType })
        }
      }
    }
  })
  if (!content.length) return failure('empty_result', 'The operation returned no result. Check its outcome before retrying.')
  const data = original?.data
  const encoded = data === undefined ? undefined : JSON.stringify(data)
  // Staged control-plane tools create native approvals themselves;
  // they do not pass through the executor's confirmation callback.
  if (original?.continuation?.kind === 'approval') approvalId = original.continuation.approvalId
  return {
    content, isError,
    structuredContent: {
      status: approvalId ? 'waiting_approval' : isError ? 'failed' : 'succeeded',
      ...(isError && !original && !approvalId ? { code: 'operation_interrupted' } : {}),
      ...(approvalId ? { approvalId } : {}),
      ...(encoded && encoded.length <= MAX_STRUCTURED_RESULT_CHARS ? { data } : {}),
      ...(encoded && encoded.length > MAX_STRUCTURED_RESULT_CHARS ? { dataOmitted: 'result_too_large' } : {}),
    },
  }
}
