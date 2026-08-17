/**
 * MCP server connector.
 *
 * Connects to external MCP servers, discovers tools, and wraps them
 * as Use Brian Tool instances with policy enforcement.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import { classifyTool, defaultPolicy } from './classifier.js'
import { mcpResultToToolResult } from './tool-result.js'
import type { McpSettingsStore, McpServerConfig, McpToolInfo } from './types.js'

/** Sanitize a string for use in LLM tool names (Gemini restriction). */
function sanitizeToolName(raw: string): string {
  // Replace any char that isn't alphanumeric, underscore, dot, colon, or dash
  return raw.replace(/[^a-zA-Z0-9_.\-:]/g, '_')
}

/**
 * Connect to an MCP server and return wrapped tools.
 *
 * Each MCP tool becomes a Use Brian Tool with:
 * - Auto-classification (read/write/destructive)
 * - Policy enforcement (allow/ask/block from user settings or defaults)
 * - Usage tracking
 */
export function wrapMcpTools(params: {
  server: McpServerConfig
  settingsStore: McpSettingsStore
  assistantId: string
  userId: string
  callMcpTool: (serverName: string, toolName: string, input: Record<string, unknown>) => Promise<unknown>
  appLevelAssistantId?: string
  policyServerName?: string
}): Tool[] {
  const {
    server, settingsStore, assistantId, userId, callMcpTool,
    appLevelAssistantId, policyServerName = server.name,
  } = params

  async function resolveEffectivePolicy(toolName: string, fallback: 'allow' | 'ask' | 'block') {
    const assistantSetting = await settingsStore.getPolicy({
      assistantId, userId, serverName: policyServerName, toolName,
    })
    if (!appLevelAssistantId) return assistantSetting?.policy ?? fallback

    const appSetting = await settingsStore.getPolicy({
      assistantId: appLevelAssistantId, userId, serverName: policyServerName, toolName,
    })
    const strictness: Record<string, number> = { allow: 0, ask: 1, block: 2 }
    const appPolicy = appSetting?.policy ?? fallback
    const assistantPolicy = assistantSetting?.policy ?? fallback
    return (strictness[appPolicy] ?? 0) >= (strictness[assistantPolicy] ?? 0)
      ? appPolicy
      : assistantPolicy
  }

  return server.tools.map((mcpTool) => {
    const classification = classifyTool(mcpTool.name, mcpTool.description)
    const policy = defaultPolicy(classification)

    return buildTool({
      name: sanitizeToolName(`mcp_${server.name}_${mcpTool.name}`).slice(0, 128),
      description: `[${server.name}] ${mcpTool.description}`,
      inputSchema: z.record(z.unknown()),
      isConcurrencySafe: classification === 'read',
      isReadOnly: classification === 'read',
      requiresConfirmation: policy === 'ask',

      // Dynamic policy check — the user may have overridden the default
      // policy via the web UI since this tool was wrapped.
      async resolveConfirmation() {
        const effective = await resolveEffectivePolicy(mcpTool.name, policy)
        return effective === 'ask'
      },

      async execute(input, context) {
        // Check user's policy override
        const effectivePolicy = await resolveEffectivePolicy(mcpTool.name, policy)

        if (effectivePolicy === 'block') {
          return { data: `ERROR: "${mcpTool.name}" is blocked by settings. Capability unavailable.`, isError: true }
        }

        try {
          const result = await callMcpTool(server.name, mcpTool.name, input as Record<string, unknown>)

          // Track usage
          settingsStore.recordUsage({
            assistantId, userId,
            serverName: policyServerName,
            toolName: mcpTool.name,
            allowed: true,
          }).catch((err) => console.debug('MCP usage tracking failed:', err))

          // Lift any inline image content onto ToolResult.images so the model sees it.
          return mcpResultToToolResult(result)
        } catch (err) {
          return {
            data: `MCP tool ${mcpTool.name} failed: ${err instanceof Error ? err.message : String(err)}`,
            isError: true,
          }
        }
      },
    })
  })
}
