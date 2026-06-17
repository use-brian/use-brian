/**
 * Knowledge base tools — search, browse, read, and add entries.
 *
 * Built-in tools injected directly into the tool map (no MCP indirection).
 * Write tool is disabled when a GitHub repo source is connected.
 *
 * See docs/architecture/features/knowledge-base.md.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import type { KnowledgeStoreInterface } from '../../knowledge/types.js'
import { RANK, researchWriteFloor, type Sensitivity } from '../../security/sensitivity.js'
import { unionCompartments } from '../../security/compartments.js'

export function createKnowledgeTools(
  store: KnowledgeStoreInterface,
  opts?: { repoConnected?: boolean },
): Tool[] {
  const searchKnowledge = buildTool({
    name: 'searchKnowledge',
    description:
      'Search the knowledge base by keyword. Returns matching entries with titles, paths, and summaries. Use this when you need to find specific information in the team\'s knowledge base.',
    inputSchema: z.object({
      query: z.string().describe('Search keywords (e.g. "vault fee structure", "deployment architecture").'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 5_000,

    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'This assistant is not in a team — no knowledge base is available.' }
      }
      try {
        const results = await store.search(
          {
            workspaceId: context.workspaceId,
            userId: context.userId,
            assistantId: context.assistantId,
            assistantKind: context.assistantKind ?? 'standard',
            clearance: context.clearance,
            compartments: context.compartments,
          },
          input.query,
          10,
        )
        if (results.length === 0) {
          return { data: 'No knowledge entries found for this query. Try browseKnowledge to explore the knowledge base structure.' }
        }
        for (const r of results) context.sensitivity?.note(r.sensitivity)
        return {
          data: results.map((r) => ({
            id: r.id,
            path: r.path,
            title: r.title,
            summary: r.summary,
            tags: r.tags,
          })),
        }
      } catch (err) {
        return { data: `Knowledge search error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const browseKnowledge = buildTool({
    name: 'browseKnowledge',
    description:
      'Browse the knowledge base by navigating its directory structure. Returns entries at the given path with summaries. Start with no path to see top-level domains, then drill into specific areas.',
    inputSchema: z.object({
      path: z.string().optional().describe('Path to browse (e.g. "products/vault"). Omit for top-level listing.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 5_000,

    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'This assistant is not in a team — no knowledge base is available.' }
      }
      try {
        const entries = await store.listByPath(
          {
            workspaceId: context.workspaceId,
            userId: context.userId,
            assistantId: context.assistantId,
            assistantKind: context.assistantKind ?? 'standard',
            clearance: context.clearance,
            compartments: context.compartments,
          },
          input.path ?? '',
        )
        if (entries.length === 0) {
          return { data: input.path ? `No entries found at path "${input.path}".` : 'The knowledge base is empty.' }
        }
        for (const r of entries) context.sensitivity?.note(r.sensitivity)
        return {
          data: entries.map((r) => ({
            id: r.id,
            path: r.path,
            title: r.title,
            summary: r.summary,
          })),
        }
      } catch (err) {
        return { data: `Browse error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const readKnowledgeEntry = buildTool({
    name: 'readKnowledgeEntry',
    description:
      'Read the full content of a knowledge base entry by its ID. Use after searching or browsing to get the complete information.',
    inputSchema: z.object({
      id: z.string().describe('Entry ID (full UUID from search/browse results).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 5_000,

    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'This assistant is not in a team — no knowledge base is available.' }
      }
      try {
        const entry = await store.getById(
          {
            workspaceId: context.workspaceId,
            userId: context.userId,
            assistantId: context.assistantId,
            assistantKind: context.assistantKind ?? 'standard',
            clearance: context.clearance,
            compartments: context.compartments,
          },
          input.id,
        )
        if (!entry) {
          return { data: `Knowledge entry "${input.id}" not found.`, isError: true }
        }
        context.sensitivity?.note(entry.sensitivity)
        return {
          data: {
            path: entry.path,
            title: entry.title,
            content: entry.content,
            tags: entry.tags,
            relatedEntries: entry.relatedIds.length > 0 ? entry.relatedIds : undefined,
            metadata: Object.keys(entry.metadata).length > 0 ? entry.metadata : undefined,
          },
        }
      } catch (err) {
        return { data: `Read error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const addKnowledgeEntry = buildTool({
    name: 'addKnowledgeEntry',
    description:
      'Add a new entry to the knowledge base. Requires a path (directory-like), title, and content. The knowledge base is for curated, reusable information — not personal notes. ' +
      'Sensitivity controls which assistants can read the entry: `public` (safe for external output), `internal` (team-wide, default), `confidential` (restricted to high-clearance assistants only). ' +
      'If the turn has drawn on confidential sources, the entry will be stamped `confidential` even if a lower tier was requested — no silent downgrade.',
    inputSchema: z.object({
      path: z.string().describe('Path for the entry (e.g. "products/vault/fees"). Use "/" as separator.'),
      title: z.string().describe('Entry title.'),
      content: z.string().describe('Full content in markdown.'),
      tags: z.array(z.string()).optional().describe('Optional tags for search.'),
      sensitivity: z.enum(['public', 'internal', 'confidential']).optional().describe(
        'Access tier for this entry. Defaults to `internal`. Use `public` only for customer-facing content.',
      ),
    }),
    isConcurrencySafe: true,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 5_000,

    async execute(input, context) {
      if (!context.workspaceId) {
        return {
          data: 'This assistant is not in a team — knowledge entries can only be created under a team.',
          isError: true,
        }
      }
      if (opts?.repoConnected) {
        return {
          data: 'This knowledge base is synced from a GitHub repository. Edits must be made in the repository — the changes will sync automatically.',
          isError: true,
        }
      }

      // Stamp: max of what the model was exposed to this turn vs the requested
      // value. Prevents a downgrade laundering path where confidential context
      // gets summarised back into a public entry. Research turns default the
      // requested tier to `public` (public-web provenance) and drop the
      // accumulator floor for internal-tier orientation reads — confidential
      // stays a hard floor. See researchWriteFloor.
      const requested: Sensitivity =
        input.sensitivity ?? (context.researchMode ? 'public' : 'internal')
      const accumulatorMax: Sensitivity = researchWriteFloor(
        context.sensitivity?.max,
        context.researchMode,
      )
      const stamp: Sensitivity = RANK[accumulatorMax] > RANK[requested] ? accumulatorMax : requested
      const stampedCompartments = unionCompartments(
        context.compartmentAccumulator?.compartments,
        context.assistantDefaultCompartments,
      )

      try {
        const entry = await store.create({
          workspaceId: context.workspaceId,
          path: input.path,
          title: input.title,
          content: input.content,
          tags: input.tags,
          sensitivity: stamp,
          compartments: stampedCompartments,
          createdBy: context.userId,
        })
        return { data: { id: entry.id, path: entry.path, sensitivity: stamp, message: 'Knowledge entry created.' } }
      } catch (err) {
        return { data: `Create error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  return [searchKnowledge, browseKnowledge, readKnowledgeEntry, addKnowledgeEntry]
}
