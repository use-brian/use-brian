/**
 * MCP client — connects to remote MCP servers via Streamable HTTP transport.
 *
 * Uses the official @modelcontextprotocol/sdk. Each tool call gets a fresh
 * connection (connect → call → close). No persistent connections.
 *
 * See docs/architecture/integrations/mcp.md → "Runtime".
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerConfig, McpToolInfo } from '@use-brian/core'

const CONNECT_TIMEOUT = 10_000
const CALL_TIMEOUT = 30_000

/**
 * Attach per-connector auth headers (bearer / custom header — see
 * mcp/auth-headers.ts) to every HTTP request the transport makes.
 * Undefined when there are no headers, so unauthenticated connectors
 * construct the transport exactly as before.
 */
function buildTransportOptions(
  headers?: Record<string, string>,
): { requestInit: RequestInit } | undefined {
  return headers && Object.keys(headers).length > 0 ? { requestInit: { headers } } : undefined
}

/**
 * Connect to a remote MCP server, discover its tools, and return a McpServerConfig.
 */
export async function discoverMcpServer(
  url: string,
  name: string,
  headers?: Record<string, string>,
): Promise<McpServerConfig> {
  const client = new Client({ name: 'Use Brian', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), buildTransportOptions(headers))

  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT })
    const { tools } = await client.listTools()

    const mcpTools: McpToolInfo[] = (tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
    }))

    return { name, url, tools: mcpTools }
  } finally {
    await client.close().catch(() => {})
  }
}

/**
 * A remote MCP tool result that carried inline image content (e.g. sampled
 * video frames). Returned by `callRemoteMcpTool` instead of a bare string so
 * the images can be lifted onto `ToolResult.images` and shown to the model.
 * See `@use-brian/core` `mcpResultToToolResult`.
 */
export type McpImageToolResult = {
  text: string
  images: Array<{ mimeType: string; data: string }>
}

/**
 * Call a tool on a remote MCP server. Opens a fresh connection, calls the tool,
 * and closes. Returns the joined text content, or — when the tool returned
 * inline image content — an `McpImageToolResult` carrying the text plus images.
 */
export async function callRemoteMcpTool(
  serverUrl: string,
  toolName: string,
  input: Record<string, unknown>,
  headers?: Record<string, string>,
): Promise<unknown> {
  const client = new Client({ name: 'Use Brian', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), buildTransportOptions(headers))

  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT })
    const result = await client.callTool(
      { name: toolName, arguments: input },
      undefined,
      { timeout: CALL_TIMEOUT },
    )

    if (result.isError) {
      const errorText = (result.content as Array<{ type: string; text?: string }>)
        ?.filter((c) => c.type === 'text')
        .map((c) => c.text)
        .join('\n') ?? 'MCP tool returned an error'
      throw new Error(errorText)
    }

    // Split the result into text + inline images. Text-only results return the
    // joined string (unchanged behavior). When the tool returned image content
    // (e.g. sampled video frames), return a structured payload so the images can
    // reach the model — core's `mcpResultToToolResult` lifts them onto
    // `ToolResult.images`, which the engine renders as inline image blocks.
    const content = (result.content ?? []) as Array<{
      type: string
      text?: string
      data?: string
      mimeType?: string
    }>
    const texts = content.filter((c) => c.type === 'text').map((c) => c.text ?? '')
    const images = content
      .filter((c) => c.type === 'image' && typeof c.data === 'string')
      .map((c) => ({ mimeType: c.mimeType ?? 'image/jpeg', data: c.data as string }))

    if (images.length > 0) {
      const out: McpImageToolResult = { text: texts.join('\n'), images }
      return out
    }
    return texts.length ? texts.join('\n') : result.content
  } finally {
    await client.close().catch(() => {})
  }
}
