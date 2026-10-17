/** Shared transport, schema validation and lifecycle for authenticated MCP profiles. [COMP:api/brain-mcp] */
import type { Request, Response } from 'express'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import type { BrainTool } from './tools.js'
import { actionableInputSchema } from './actionable-input-schema.js'

/** Authentication and current operation authority belong to the supplied profile. */
export async function serveStatelessMcp(req: Request, res: Response, tools: readonly BrainTool[], name = 'use-brian-brain'): Promise<void> {
  const server = new McpServer({ name, version: '1.0.0' })
  for (const tool of tools) server.registerTool(tool.name,
    { description: tool.description, inputSchema: actionableInputSchema(tool.inputSchema, tool.name) }, tool.handler)
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.once('close', () => { void transport.close(); void server.close() })
  try {
    await server.connect(transport)
    await transport.handleRequest(req, res, req.body)
  } catch (error) {
    await transport.close(); await server.close()
    throw error
  }
}
