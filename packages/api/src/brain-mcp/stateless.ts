/** Shared transport, schema validation and lifecycle for authenticated MCP profiles. [COMP:api/brain-mcp] */
import { createHash } from 'node:crypto'
import type { Request, Response } from 'express'
import { z } from 'zod'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { toJsonSchemaCompat } from '@modelcontextprotocol/sdk/server/zod-json-schema-compat.js'
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from '@modelcontextprotocol/sdk/types.js'
import type { BrainTool } from './tools.js'
import { actionableInputSchema } from './actionable-input-schema.js'

/** The exact input contract shared by ordinary and compact discovery. */
export function mcpToolInputSchema(tool: Pick<BrainTool, 'inputSchema'>): Record<string, unknown> {
    const nativeSchema = tool.inputSchema instanceof z.ZodType ? tool.inputSchema : z.object(tool.inputSchema)
    // The SDK converter supports nested unions/effects, while McpServer's
    // discovery silently replaces non-object root schemas with {}. Convert
    // through an object property so all native constraints survive discovery.
    const envelope = toJsonSchemaCompat(z.object({ arguments: nativeSchema }), { strictUnions: true, pipeStrategy: 'input' })
    const nestedSchema = (envelope.properties as Record<string, Record<string, unknown>>).arguments!
    // Rebase references emitted for reused/recursive native fields when
    // unwrapping the temporary object. Values and descriptions stay untouched.
    const inputSchema = JSON.parse(JSON.stringify(nestedSchema, (key, value: unknown) =>
      key === '$ref' && typeof value === 'string' && value.startsWith('#/properties/arguments')
        ? `#${value.slice('#/properties/arguments'.length)}` : value,
    )) as Record<string, unknown>
    return inputSchema
}

/** Authentication and current operation authority belong to the supplied profile. */
export async function serveStatelessMcp(req: Request, res: Response, tools: readonly BrainTool[], name = 'use-brian-brain', compactOperationNames?: readonly string[]): Promise<void> {
  const server = new Server({ name, version: '1.0.0' }, { capabilities: { tools: {} } })
  const catalog = new Map(tools.map(tool => {
    const nativeSchema = tool.inputSchema instanceof z.ZodType ? tool.inputSchema : z.object(tool.inputSchema)
    return [tool.name, { tool, validator: actionableInputSchema(nativeSchema, tool.name), inputSchema: mcpToolInputSchema(tool) }] as const
  }))
  if (catalog.size !== tools.length) throw new Error('Duplicate MCP operation registration')
  const compact = req.query.catalog === 'compact' && compactOperationNames?.every(name => catalog.has(name))
  const advertised = [...catalog.values()].filter(({ tool }) => !compact || compactOperationNames!.includes(tool.name)).sort((a, b) => a.tool.name.localeCompare(b.tool.name)).map(({ tool, inputSchema }) => ({
    name: tool.name, description: tool.description, inputSchema: { ...inputSchema, type: 'object' as const },
  }))
  const revision = createHash('sha256').update(JSON.stringify(advertised)).digest('hex')
  const pageSize = 100
  server.setRequestHandler(ListToolsRequestSchema, async request => {
    const cursor = request.params?.cursor
    const match = cursor?.match(/^([a-f0-9]{64}):([1-9][0-9]*)$/)
    const offset = match ? Number(match[2]) : 0
    if (cursor !== undefined && (!match || match[1] !== revision || !Number.isSafeInteger(offset)
      || offset % pageSize !== 0 || offset >= advertised.length)) {
      throw new McpError(ErrorCode.InvalidParams, 'The tool catalog changed or this cursor is invalid. Restart tools/list without a cursor.')
    }
    return { tools: advertised.slice(offset, offset + pageSize),
      ...(offset + pageSize < advertised.length ? { nextCursor: `${revision}:${offset + pageSize}` } : {}) }
  })
  server.setRequestHandler(CallToolRequestSchema, async request => {
    const operation = catalog.get(request.params.name)
    if (!operation) return { isError: true, content: [{ type: 'text', text: 'This operation is not available to this connection.' }] }
    const args = request.params.arguments ?? {}
    const validation = await operation.validator.safeParseAsync(args)
    if (!validation.success) return { isError: true, content: [{ type: 'text', text: validation.error.message }] }
    // Native execution owns transforms/defaults. Passing the parsed value
    // would apply transforms twice and could silently change the effect.
    const operationId = request.params._meta?.['usebrian.ai/operation-id']
    if (operationId !== undefined && !z.string().uuid().safeParse(operationId).success) {
      return { isError: true, content: [{ type: 'text', text: 'usebrian.ai/operation-id must be a UUID.' }] }
    }
    return operation.tool.handler(args, operationId === undefined ? undefined : { operationId: operationId as string })
  })
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
