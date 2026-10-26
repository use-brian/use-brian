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
import type { StreamableHTTPClientTransportOptions } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
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
  dispatchFetch?: FetchLike,
): StreamableHTTPClientTransportOptions | undefined {
  const options = headers && Object.keys(headers).length > 0 ? { requestInit: { headers } } : undefined
  return dispatchFetch ? { ...options, fetch: dispatchFetch } : options
}

/**
 * Connect to a remote MCP server, discover its tools, and return a McpServerConfig.
 */
export async function discoverMcpServer(
  url: string,
  name: string,
  headers?: Record<string, string>,
  dispatchFetch?: FetchLike,
): Promise<McpServerConfig> {
  const client = new Client({ name: 'Use Brian', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(url), buildTransportOptions(headers, dispatchFetch))

  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT })
    const { tools } = await client.listTools()

    const mcpTools: McpToolInfo[] = (tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
      ...(typeof t.annotations?.readOnlyHint === 'boolean' ? { readOnlyHint: t.annotations.readOnlyHint } : {}),
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
  dispatchFetch?: FetchLike,
): Promise<unknown> {
  const result = await callRemoteMcpToolEnvelope(serverUrl, toolName, input, headers, dispatchFetch)
  return mcpToolDisplayResult(result)
}

/** Protected readers must inspect authenticated reserved metadata before compacting content. */
export async function callRemoteMcpToolEnvelope(
  serverUrl: string,
  toolName: string,
  input: Record<string, unknown>,
  headers?: Record<string, string>,
  dispatchFetch?: FetchLike,
): Promise<CallToolResult> {
  const client = new Client({ name: 'Use Brian', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(serverUrl), buildTransportOptions(headers, dispatchFetch))

  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT })
    const result = await client.callTool(
      { name: toolName, arguments: input },
      undefined,
      { timeout: CALL_TIMEOUT },
    )

    return result as CallToolResult
  } finally {
    await client.close().catch(() => {})
  }
}

/** Compatibility display conversion. This intentionally creates no trusted source evidence. */
export function mcpToolDisplayResult(result: CallToolResult): unknown {
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
}
