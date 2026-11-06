/** Bounded transport aliases over the admitted native catalog. [COMP:api/workspace-mcp] */
import { createHash } from 'node:crypto'
import { z } from 'zod'
import { formatToolError } from '@use-brian/core'
import type { BrainTool } from '../brain-mcp/tools.js'
import { mcpToolInputSchema } from '../brain-mcp/stateless.js'

export const workspaceDiscoveryNames = ['searchWorkspaceOperations', 'getWorkspaceOperationSchema', 'callWorkspaceOperation'] as const
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
const fail = (code: string, message: string) => ({ isError: true, content: [{ type: 'text' as const, text: message }], structuredContent: { status: 'failed', code, message, retrySafe: false } })
const result = (data: Record<string, unknown>) => ({ content: [{ type: 'text' as const, text: JSON.stringify(data) }], structuredContent: { status: 'succeeded', data }, isError: false })
const searchSchema = z.object({ query: z.string().trim().max(200).default(''), limit: z.number().int().min(1).max(50).default(20), cursor: z.string().max(100).optional() }).strict()
const detailSchema = z.object({ name: z.string().min(1).max(200) }).strict()
const callSchema = detailSchema.extend({ schemaRevision: z.string().regex(/^[a-f0-9]{64}$/), arguments: z.record(z.unknown()).default({}) }).strict()
const reserved = new Set<string>(workspaceDiscoveryNames)
export function describeWorkspaceOperation(tool: Pick<BrainTool, 'name' | 'description' | 'inputSchema'>) {
  const operation = { name: tool.name, description: tool.description, inputSchema: mcpToolInputSchema(tool) }
  return { ...operation, schemaRevision: digest(operation) }
}
export function createWorkspaceDiscoveryTools(resolve: () => Promise<BrainTool[]>): BrainTool[] {
  const current = async () => (await resolve()).filter(tool => !reserved.has(tool.name)).sort((a,b) => a.name.localeCompare(b.name))
  return [{ name: workspaceDiscoveryNames[0], description: 'Search currently admitted workspace operations. Fetch the exact schema before calling. A cursor becomes invalid when the catalog or query changes.', inputSchema: searchSchema,
    handler: async raw => {
      const parsed = searchSchema.safeParse(raw); if (!parsed.success) return fail('invalid_input', formatToolError(parsed.error))
      const { query, limit, cursor } = parsed.data
      const entries = (await current()).map(describeWorkspaceOperation)
      const revision = digest({ query, entries })
      const match = cursor?.match(/^([a-f0-9]{64}):([1-9][0-9]*)$/)
      const offset = match ? Number(match[2]) : 0
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
      const matching = entries.filter(entry => terms.every(term => `${entry.name} ${entry.description}`.toLowerCase().includes(term)))
      if (cursor && (!match || match[1] !== revision || !Number.isSafeInteger(offset) || offset >= matching.length)) return fail('catalog_changed', 'Restart the search without a cursor.')
      return result({ operations: matching.slice(offset, offset + limit).map(({ inputSchema: _schema, ...entry }) => entry),
        ...(offset + limit < matching.length ? { nextCursor: `${revision}:${offset + limit}` } : {}) })
    } },
  { name: workspaceDiscoveryNames[1], description: 'Get the complete native input schema and schemaRevision of an admitted workspace operation. This schema is required by callWorkspaceOperation.', inputSchema: detailSchema,
    handler: async raw => {
      const parsed = detailSchema.safeParse(raw); if (!parsed.success) return fail('invalid_input', formatToolError(parsed.error))
      const tool = (await current()).find(tool => tool.name === parsed.data.name)
      return tool ? result(describeWorkspaceOperation(tool)) : fail('operation_unavailable', 'This operation is not available to this connection.')
    } },
  { name: workspaceDiscoveryNames[2], description: 'Call an admitted native operation using its exact schemaRevision and arguments. Preserves the target operation’s permissions, approvals and durable receipt. Pass usebrian.ai/operation-id in MCP metadata for safe receipt lookup across retries.', inputSchema: callSchema,
    handler: async (raw, invocation) => {
      const parsed = callSchema.safeParse(raw); if (!parsed.success) return fail('invalid_input', formatToolError(parsed.error))
      const tool = (await current()).find(tool => tool.name === parsed.data.name)
      if (!tool) return fail('operation_unavailable', 'This operation is not available to this connection.')
      if (describeWorkspaceOperation(tool).schemaRevision !== parsed.data.schemaRevision) return fail('schema_changed', 'Fetch the current operation schema before calling.')
      return tool.handler(parsed.data.arguments, { ...invocation, schemaRevision: parsed.data.schemaRevision })
    } }]
}
