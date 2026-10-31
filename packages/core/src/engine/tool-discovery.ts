import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { ToolDefinition } from '../providers/types.js'

/** Presentation only: callers retain the original, already filtered executor registry. */
export function createToolDiscovery(all: ToolDefinition[]): {
  definitions: ToolDefinition[]
  tool: Tool
} {
  if (all.some(tool => tool.name === 'discoverTools')) throw new Error('Reserved discovery tool name')
  const direct = new Set(['mcp_search', 'mcp_call', 'askQuestion'])
  const deferred = all.filter(tool => !direct.has(tool.name))
  const definitions = all.filter(tool => direct.has(tool.name))
  const loaded = new Set(definitions.map(tool => tool.name))
  const words = (value: string) => value.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase().match(/[a-z0-9]+/g) ?? []
  const index = deferred.map(tool => ({ tool, words: new Set(words(`${tool.name} ${tool.description}`)) }))
  const tool = buildTool({
    name: 'discoverTools',
    description: 'Find Brian tools by task keywords or exact tool name before calling them. Returns their full parameter schemas and makes them available for the next call. No discovery is needed for a conversational reply. Available tool names: ' + deferred.map(tool => tool.name).join(', '),
    inputSchema: z.object({
      query: z.string().min(1).describe('Task keywords or an exact available tool name'),
      limit: z.number().int().min(1).max(5).default(3),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    requiresConfirmation: false,
    async execute({ query, limit }) {
      const terms = [...new Set(words(query))]
      const matches = index.map(entry => ({
        tool: entry.tool,
        score: entry.tool.name.toLowerCase() === query.trim().toLowerCase() ? Number.MAX_SAFE_INTEGER
          : terms.reduce((score, term) => score + (entry.words.has(term) ? 1 : 0), 0),
      })).filter(entry => entry.score > 0)
        .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name))
        .slice(0, limit).map(entry => entry.tool)
      for (const match of matches) {
        if (loaded.has(match.name)) continue
        loaded.add(match.name)
        // Keep array identity: stateful providers read it on each send.
        definitions.push(match)
      }
      return { data: matches.length ? { tools: matches } : { tools: [], message: 'No matching tools. Try an available tool name or different keywords.' } }
    },
  })
  return { definitions, tool }
}
