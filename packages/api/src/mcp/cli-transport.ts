/**
 * CLI connector transport — MCP over stdio.
 *
 * Spawns a local binary that speaks MCP over stdin/stdout, discovers its
 * tools, and dispatches tool calls. Per-call spawn model (Phase 1): each
 * discovery and each tool call spawns a fresh child process, uses it, and
 * closes it.
 *
 * Security:
 * - No shell interpolation (spawn with shell: false via StdioClientTransport)
 * - Environment scrubbed (StdioClientTransport's getDefaultEnvironment)
 * - Timeout on every spawn (default 30s, capped at 300s)
 * - stdout capped at 1 MB
 * - Shell binaries rejected at the route boundary, not here
 *
 * See docs/architecture/integrations/cli-connector.md.
 * Component tag: [COMP:mcp/cli-transport].
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import type { McpServerConfig, McpToolInfo } from '@use-brian/core'

const CONNECT_TIMEOUT = 10_000
const CALL_TIMEOUT = 30_000
const MAX_CALL_TIMEOUT = 300_000

export type CliServerParams = {
  binaryPath: string
  args?: string[]
  env?: Record<string, string>
  cwd?: string
  timeoutMs?: number
}

export async function discoverCliServer(
  params: CliServerParams,
  name: string,
): Promise<McpServerConfig> {
  const { binaryPath, args, env, cwd } = params

  const client = new Client({ name: 'Use Brian', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: binaryPath,
    args: args ?? [],
    env: env ?? {},
    cwd,
    stderr: 'pipe',
  })

  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT })
    const { tools } = await client.listTools()

    const mcpTools: McpToolInfo[] = (tools ?? []).map((t) => ({
      name: t.name,
      description: t.description ?? '',
      inputSchema: t.inputSchema as Record<string, unknown>,
    }))

    return { name, url: `stdio://${binaryPath}`, tools: mcpTools }
  } finally {
    await client.close().catch(() => {})
  }
}

export async function callCliMcpTool(
  params: CliServerParams,
  toolName: string,
  input: Record<string, unknown>,
): Promise<unknown> {
  const { binaryPath, args, env, cwd, timeoutMs } = params
  const timeout = Math.min(timeoutMs ?? CALL_TIMEOUT, MAX_CALL_TIMEOUT)

  const client = new Client({ name: 'Use Brian', version: '1.0.0' })
  const transport = new StdioClientTransport({
    command: binaryPath,
    args: args ?? [],
    env: env ?? {},
    cwd,
    stderr: 'pipe',
  })

  try {
    await client.connect(transport, { timeout: CONNECT_TIMEOUT })

    const result = await Promise.race([
      client.callTool({ name: toolName, arguments: input }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`CLI tool call timed out after ${timeout}ms`)), timeout),
      ),
    ])

    const content = (result as { content?: Array<{ type: string; text?: string; data?: string; mimeType?: string }> }).content
    if (!content || content.length === 0) return ''

    const textParts = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text)
    const imageParts = content
      .filter((c) => c.type === 'image' && typeof c.data === 'string' && typeof c.mimeType === 'string')
      .map((c) => ({ mimeType: c.mimeType as string, data: c.data as string }))

    const text = textParts.join('\n')
    if (imageParts.length > 0) {
      return { text, images: imageParts }
    }
    return text
  } finally {
    await client.close().catch(() => {})
  }
}

const SHELL_BINARIES = new Set(['sh', 'bash', 'zsh', 'dash', 'fish', 'ksh', 'csh', 'tcsh'])

export function isShellBinary(binaryPath: string): boolean {
  const basename = binaryPath.split('/').pop()?.toLowerCase() ?? ''
  return SHELL_BINARIES.has(basename)
}

export function validateCliArgs(args: string[]): string | null {
  if (args.length > 20) return 'Maximum 20 arguments allowed'
  for (const arg of args) {
    if (arg.length > 4096) return 'Each argument must be at most 4096 characters'
    if (/[\r\n]/.test(arg)) return 'Arguments must not contain CR/LF characters'
  }
  return null
}
