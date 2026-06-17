/**
 * MCP gateway tool — a single proxy tool per MCP server that replaces
 * injecting all N tools into the LLM context.
 *
 * Phase 1: model calls with action "list" → gets tool names + descriptions
 * Phase 2: model calls with action "call" + tool name + args → proxies to the MCP tool
 *
 * This saves ~5-10K tokens per connector in every LLM request.
 * See docs/architecture/integrations/mcp.md.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import { classifyTool, defaultPolicy } from './classifier.js'
import type { McpSettingsStore, McpServerConfig, McpToolInfo } from './types.js'

/** Sanitize a string for use in LLM tool names (Gemini restriction). */
function sanitizeToolName(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9_.\-:]/g, '_')
}

/**
 * Create a single gateway tool for an MCP server.
 *
 * The gateway exposes two actions:
 * - `list`: returns all available tools with descriptions
 * - `call`: proxies a call to a specific tool on the server
 */
export function createMcpGateway(params: {
  server: McpServerConfig
  settingsStore: McpSettingsStore
  assistantId: string
  userId: string
  callMcpTool: (serverName: string, toolName: string, input: Record<string, unknown>) => Promise<unknown>
}): Tool {
  const { server, settingsStore, assistantId, userId, callMcpTool } = params

  // Build a lookup for quick tool resolution
  const toolMap = new Map<string, McpToolInfo>()
  for (const t of server.tools) {
    toolMap.set(t.name, t)
  }

  // Build the tool list summary (shown when action=list)
  const toolSummary = server.tools
    .map((t) => `- **${t.name}**: ${t.description}`)
    .join('\n')

  const gatewayName = sanitizeToolName(`mcp_${server.name}`).slice(0, 128)

  // Build a short capability summary from tool descriptions for the gateway description
  const toolCount = server.tools.length
  const sampleTools = server.tools.slice(0, 5).map((t) => t.name).join(', ')
  const suffix = toolCount > 5 ? `, and ${toolCount - 5} more` : ''

  return buildTool({
    name: gatewayName,
    description: `[${server.name}] Gateway to ${toolCount} tools. Use action "list" to see available tools, or action "call" with tool_name and args to execute. Tools include: ${sampleTools}${suffix}.`,
    inputSchema: z.object({
      action: z.enum(['list', 'call']).describe('"list" to see available tools, "call" to execute one'),
      tool_name: z.string().optional().describe('The tool name to call (required for action "call")'),
      args: z.record(z.unknown()).optional().describe('Arguments to pass to the tool (for action "call")'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    requiresConfirmation: false,

    async execute(input, _context) {
      const { action, tool_name, args } = input as {
        action: 'list' | 'call'
        tool_name?: string
        args?: Record<string, unknown>
      }

      // ── List: return tool catalog ──
      if (action === 'list') {
        return {
          data: `Available tools for ${server.name} (${toolCount} tools):\n\n${toolSummary}\n\nTo use a tool, call this gateway again with action "call", tool_name, and args.`,
        }
      }

      // ── Call: proxy to the specific MCP tool ──
      if (!tool_name) {
        return { data: 'Missing tool_name. Use action "list" to see available tools.', isError: true }
      }

      const mcpTool = toolMap.get(tool_name)
      if (!mcpTool) {
        return {
          data: `Unknown tool "${tool_name}" on ${server.name}. Use action "list" to see available tools.`,
          isError: true,
        }
      }

      // Check classification + policy
      const classification = classifyTool(mcpTool.name, mcpTool.description)
      const policy = defaultPolicy(classification)

      const setting = await settingsStore.getPolicy({
        assistantId, userId,
        serverName: server.name,
        toolName: mcpTool.name,
      })
      const effectivePolicy = setting?.policy ?? policy

      if (effectivePolicy === 'block') {
        return { data: `ERROR: "${mcpTool.name}" is blocked by settings. Capability unavailable.`, isError: true }
      }

      if (effectivePolicy === 'ask') {
        return {
          data: `ERROR: "${mcpTool.name}" requires user confirmation (policy: ask) but the legacy gateway does not support confirmation. The tool was NOT executed. Use mcp_search + mcp_call instead, or set the tool policy to 'allow'.`,
          isError: true,
        }
      }

      try {
        const result = await callMcpTool(server.name, mcpTool.name, args ?? {})

        // Track usage
        settingsStore.recordUsage({
          assistantId, userId,
          serverName: server.name,
          toolName: mcpTool.name,
          allowed: true,
        }).catch((err) => console.debug('MCP usage tracking failed:', err))

        return { data: result }
      } catch (err) {
        return {
          data: `MCP tool ${mcpTool.name} failed: ${err instanceof Error ? err.message : String(err)}`,
          isError: true,
        }
      }
    },
  })
}
