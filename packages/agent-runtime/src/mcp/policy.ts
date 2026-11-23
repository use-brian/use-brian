import { AsyncLocalStorage } from 'node:async_hooks'
import { APP_LEVEL_ASSISTANT_ID } from '@use-brian/shared'
import type { ToolContext } from '../tools/types.js'
import type { McpPolicyScope, McpSettingsStore, McpToolSetting } from './types.js'

export type ToolPolicy = McpToolSetting['policy']
type PolicyTool = { name: string; defaultPolicy: ToolPolicy }
type ToolPolicyKeys = {
  assistantId: string
  serverName: string
  appServerName?: string
  assistantFallbackServerName?: string
}

const STRICTNESS: Record<ToolPolicy, number> = { allow: 0, ask: 1, block: 2 }

export function resolveToolPolicy(
  keys: ToolPolicyKeys,
  fallback: ToolPolicy,
  lookup: (assistantId: string, serverName: string) => ToolPolicy | undefined,
) {
  const { assistantId, serverName, appServerName = serverName, assistantFallbackServerName } = keys
  const appPolicy = lookup(APP_LEVEL_ASSISTANT_ID, appServerName) ?? fallback
  const assistantPolicy = lookup(assistantId, serverName)
    ?? (assistantFallbackServerName && assistantFallbackServerName !== serverName
      ? lookup(assistantId, assistantFallbackServerName)
      : undefined)
    ?? fallback
  const effectivePolicy = STRICTNESS[appPolicy] >= STRICTNESS[assistantPolicy] ? appPolicy : assistantPolicy
  return { appPolicy, assistantPolicy, effectivePolicy }
}

const scopeKey = (assistantId: string, serverName: string) => `${assistantId}\u0000${serverName}`

export async function readToolPolicies(
  settingsStore: McpSettingsStore,
  keys: ToolPolicyKeys & { userId: string },
  tools: readonly PolicyTool[],
) {
  if (tools.length === 0) return []
  const { userId, assistantId, serverName, appServerName = serverName, assistantFallbackServerName } = keys
  const scopes: McpPolicyScope[] = [
    { assistantId: APP_LEVEL_ASSISTANT_ID, serverName: appServerName },
    { assistantId, serverName },
  ]
  if (assistantFallbackServerName && assistantFallbackServerName !== serverName) {
    scopes.push({ assistantId, serverName: assistantFallbackServerName })
  }
  const rows = new Map<string, ToolPolicy>()
  const key = (assistant: string, server: string, name: string) => `${scopeKey(assistant, server)}\u0000${name}`
  if (settingsStore.getPolicies) {
    const overrides = await settingsStore.getPolicies({ userId, scopes, toolNames: [...new Set(tools.map(tool => tool.name))] })
    for (const row of overrides) rows.set(key(row.assistantId, row.serverName, row.toolName), row.policy)
  } else {
    // Legacy injected stores can implement the point read only.
    for (const tool of tools) {
      for (const scope of scopes) {
        if (scope.serverName === assistantFallbackServerName && scope.assistantId === assistantId
          && rows.has(key(assistantId, serverName, tool.name))) continue
        const row = await settingsStore.getPolicy({ ...scope, userId, toolName: tool.name })
        if (row) rows.set(key(scope.assistantId, scope.serverName, tool.name), row.policy)
      }
    }
  }
  return tools.map(tool => resolveToolPolicy(keys, tool.defaultPolicy,
    (assistant, server) => rows.get(key(assistant, server, tool.name))))
}

// Folded MCP calls must forward the original context object. Scope the live
// approval to this call's async execution, context, tool, and parsed input.
const currentConfirmation = new AsyncLocalStorage<{ context: ToolContext; toolName: string; input: unknown }>()

export function withToolConfirmation<T>(context: ToolContext, toolName: string, input: unknown, execute: () => Promise<T>) {
  return currentConfirmation.run({ context, toolName, input }, execute)
}

export function hasToolConfirmation(context: ToolContext, toolName: string, input: unknown): boolean {
  if (context.approvedToolInvocation?.toolName === toolName || context.confirmedToolName === toolName) return true
  const confirmation = currentConfirmation.getStore()
  return confirmation?.context === context && confirmation.toolName === toolName && confirmation.input === input
}
