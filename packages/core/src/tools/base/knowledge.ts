/**
 * Knowledge base tools — search, browse, read, add, and update entries.
 *
 * Built-in tools injected directly into the tool map (no MCP indirection).
 *
 * Write surface (docs/architecture/features/knowledge-base.md → "Assistant
 * direct edits"): repo-synced knowledge bases are assistant-editable only
 * when the injector passes a `repoWriter` — which it does only on
 * interactive, confirmation-capable surfaces AND when a source's cached
 * PAT write-capability probe passed. Every write carries
 * `requiresConfirmation` (per-edit Approve/Deny) and the descriptions
 * forbid proactive use: the assistant edits the KB only when the user
 * explicitly asked in the conversation.
 */

import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '../types.js'
import type { KnowledgeStoreInterface, KnowledgeRepoWriter } from '../../knowledge/types.js'
import { RANK, researchWriteFloor, type Sensitivity } from '../../security/sensitivity.js'
import { unionCompartments } from '../../security/compartments.js'

export type KnowledgeToolOptions = {
  /** Whether any GitHub sync source is connected for this workspace. */
  repoConnected?: boolean
  /**
   * Repo write-back port. Present ONLY when the surface allows knowledge
   * writes (interactive chat — D2) AND at least one source's cached PAT
   * probe says push access. Enables repo mode on `addKnowledgeEntry` and
   * repo routing in `updateKnowledgeEntry`.
   */
  repoWriter?: KnowledgeRepoWriter
  /** Sources whose cached write probe passed — creates target one of these. */
  writableSources?: Array<{ id: string; repo: string }>
  /**
   * Interactive-surface flag: gates emission of `updateKnowledgeEntry`
   * entirely. Non-interactive surfaces (workflow, scheduled, A2A, public
   * API) never see the tool.
   */
  allowWrites?: boolean
  /** Requesting member's display label (email) for commit attribution. */
  requesterLabel?: string | null
}

const EXPLICIT_ASK_RULE =
  'Only use this when the user has explicitly asked, in this conversation, to change the knowledge base — never proactively.'

/** One-line YAML scalar (JSON string quoting is valid YAML). */
function yamlString(value: string): string {
  return JSON.stringify(value)
}

/** First non-heading paragraph, single-line, truncated — the generated `description`. */
function firstParagraph(body: string): string | null {
  for (const block of body.split(/\n\s*\n/)) {
    const text = block.trim().replace(/\s+/g, ' ')
    if (!text || text.startsWith('#')) continue
    return text.length > 160 ? `${text.slice(0, 157)}...` : text
  }
  return null
}

/**
 * Generate a full KB markdown file (Tier-1 frontmatter + body) matching the
 * authoring shape the sync parser reads back (title / description / tags /
 * sensitivity — see brian-kb README → "Authoring").
 */
function buildKbFileContent(params: {
  title: string
  tags: string[]
  sensitivity: Sensitivity
  body: string
}): string {
  const description = firstParagraph(params.body)
  const lines = ['---', `title: ${yamlString(params.title)}`]
  if (description) lines.push(`description: ${yamlString(description)}`)
  if (params.tags.length > 0) lines.push(`tags: [${params.tags.map(yamlString).join(', ')}]`)
  lines.push(`sensitivity: ${params.sensitivity}`, '---', '', params.body.trim(), '')
  return lines.join('\n')
}

function bodyPreview(content: string): string {
  const flat = content.trim().replace(/\s+/g, ' ')
  return flat.length > 200 ? `${flat.slice(0, 197)}...` : flat
}

export function createKnowledgeTools(
  store: KnowledgeStoreInterface,
  opts?: KnowledgeToolOptions,
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

  /** Access-scoped single-entry read shared by the write tools + previews. */
  async function readEntry(context: ToolContext, id: string) {
    return await store.getById(
      {
        workspaceId: context.workspaceId!,
        userId: context.userId,
        assistantId: context.assistantId,
        assistantKind: context.assistantKind ?? 'standard',
        clearance: context.clearance,
        compartments: context.compartments,
      },
      id,
    )
  }

  /** Pick the create target among writable sources; string = error message. */
  function pickWritableSource(requestedRepo: string | undefined): { id: string; repo: string } | string {
    const writable = opts?.writableSources ?? []
    if (writable.length === 0) return 'No writable knowledge source is available.'
    if (requestedRepo) {
      const found = writable.find((s) => s.repo === requestedRepo.trim())
      return found ?? `"${requestedRepo}" is not a writable knowledge source. Writable: ${writable.map((s) => s.repo).join(', ')}.`
    }
    if (writable.length > 1) {
      return `Multiple knowledge sources are writable — pass "repo" to choose one of: ${writable.map((s) => s.repo).join(', ')}.`
    }
    return writable[0]
  }

  const addKnowledgeEntry = buildTool({
    name: 'addKnowledgeEntry',
    description:
      `Add a new entry to the knowledge base. ${EXPLICIT_ASK_RULE} ` +
      'Requires a path (directory-like), title, and content. The knowledge base is for curated, reusable information — not personal notes. ' +
      'When the knowledge base is synced from a GitHub repository, the entry is committed directly to the repository on approval. ' +
      'Sensitivity controls which assistants can read the entry: `public` (safe for external output), `internal` (team-wide, default), `confidential` (restricted to high-clearance assistants only). ' +
      'If the turn has drawn on confidential sources, the entry will be stamped `confidential` even if a lower tier was requested — no silent downgrade.',
    inputSchema: z.object({
      path: z.string().describe('Path for the entry (e.g. "products/vault/fees"). Use "/" as separator.'),
      title: z.string().describe('Entry title.'),
      content: z.string().describe('Full content in markdown. Do not include YAML frontmatter — it is generated from the other fields.'),
      tags: z.array(z.string()).optional().describe('Optional tags for search.'),
      sensitivity: z.enum(['public', 'internal', 'confidential']).optional().describe(
        'Access tier for this entry. Defaults to `internal`. Use `public` only for customer-facing content.',
      ),
      repo: z.string().optional().describe(
        'Target repository (owner/name). Only needed when more than one knowledge source is writable.',
      ),
    }),
    isConcurrencySafe: true,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 30_000,

    async describeConfirmation(input, _context) {
      const args = input as { path?: string; title?: string; content?: string; sensitivity?: string; repo?: string }
      const target = opts?.repoConnected ? pickWritableSource(args.repo) : null
      const lines = [
        `Create knowledge entry "${args.title ?? ''}" at ${args.path ?? ''}`,
        target && typeof target !== 'string'
          ? `Commits directly to ${target.repo}`
          : 'Saves to the workspace knowledge base',
        `Sensitivity: ${args.sensitivity ?? 'internal'} (raised automatically if this turn used higher-tier sources)`,
      ]
      if (args.content) lines.push(`Body: ${bodyPreview(args.content)}`)
      return lines
    },

    async execute(input, context) {
      if (!context.workspaceId) {
        return {
          data: 'This assistant is not in a team — knowledge entries can only be created under a team.',
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

      if (opts?.repoConnected) {
        // Repo mode — direct commit through the write-back port. The port is
        // present only on interactive surfaces with a push-capable source
        // (docs/architecture/features/knowledge-base.md → "Assistant direct
        // edits"); its absence here is a normal, explainable state.
        if (!opts.repoWriter || (opts.writableSources ?? []).length === 0) {
          return {
            data: 'This knowledge base is synced from a GitHub repository and cannot be edited from here — the connected GitHub token is read-only (or knowledge editing is not available on this surface). Edits land in the repository and sync automatically; to enable direct edits, reconnect the source with a read-write token in Studio → Connectors.',
            isError: true,
          }
        }
        const target = pickWritableSource(input.repo)
        if (typeof target === 'string') {
          return { data: target, isError: true }
        }
        const fileContent = buildKbFileContent({
          title: input.title,
          tags: input.tags ?? [],
          sensitivity: stamp,
          body: input.content,
        })
        const result = await opts.repoWriter.commitEntryCreate({
          workspaceId: context.workspaceId,
          sourceId: target.id,
          path: input.path,
          fileContent,
          changeSummary: `add ${input.path}: ${input.title}`,
          requestedBy: { userId: context.userId, label: opts.requesterLabel ?? null },
        })
        if (!result.ok) {
          return { data: result.message, isError: true }
        }
        return {
          data: {
            id: result.entryId,
            path: result.path,
            sensitivity: stamp,
            commit: result.commitSha ?? undefined,
            commitUrl: result.commitUrl ?? undefined,
            message: 'Knowledge entry created and committed to the repository.',
          },
        }
      }

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

  const updateKnowledgeEntry = buildTool({
    name: 'updateKnowledgeEntry',
    description:
      `Replace the body of an existing knowledge base entry. ${EXPLICIT_ASK_RULE} ` +
      'Read the entry first (readKnowledgeEntry) and pass the complete new body in markdown — this is a full replacement, not a patch. ' +
      'The entry\'s metadata (title, tags, sensitivity) is preserved as-is; do not include YAML frontmatter. ' +
      'Repo-synced entries are committed directly to the source repository on approval.',
    inputSchema: z.object({
      id: z.string().describe('Entry ID (full UUID from search/browse results).'),
      content: z.string().describe('The complete replacement body in markdown (no frontmatter).'),
      changeSummary: z.string().describe('One line describing the change — becomes the commit message subject.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 30_000,

    async describeConfirmation(input, context) {
      const args = input as { id?: string; content?: string; changeSummary?: string }
      if (!args.id || !context.workspaceId) return null
      try {
        const entry = await readEntry(context, args.id)
        if (!entry) return null
        const repo = entry.sourceId
          ? opts?.writableSources?.find((s) => s.id === entry.sourceId)?.repo
          : null
        const lines = [
          `Update knowledge entry "${entry.title}" (${entry.path})`,
          entry.sourceId
            ? `Commits directly to ${repo ?? 'the knowledge repository'}`
            : 'Manual entry — updates the workspace knowledge base',
        ]
        if (args.changeSummary) lines.push(`Change: ${args.changeSummary}`)
        if (args.content) lines.push(`New body: ${bodyPreview(args.content)}`)
        return lines
      } catch {
        return null
      }
    },

    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: 'This assistant is not in a team — no knowledge base is available.', isError: true }
      }
      let entry
      try {
        entry = await readEntry(context, input.id)
      } catch (err) {
        return { data: `Read error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
      if (!entry) {
        return { data: `Knowledge entry "${input.id}" not found.`, isError: true }
      }

      // No-laundering guard: an update never reclassifies the entry
      // (frontmatter is preserved verbatim), so a turn that drew on
      // higher-tier sources must not write into a lower-tier entry.
      const accumulatorMax: Sensitivity = researchWriteFloor(
        context.sensitivity?.max,
        context.researchMode,
      )
      if (RANK[accumulatorMax] > RANK[entry.sensitivity]) {
        return {
          data: `This turn has drawn on ${accumulatorMax} sources, but this entry is ${entry.sensitivity} — updating it could expose ${accumulatorMax} material to lower-clearance readers. Create a separate entry with addKnowledgeEntry (it will be stamped ${accumulatorMax}) instead.`,
          isError: true,
        }
      }
      context.sensitivity?.note(entry.sensitivity)

      if (entry.sourceId) {
        // Repo-synced entry — direct commit through the write-back port.
        if (!opts?.repoWriter) {
          return {
            data: 'This entry is synced from a GitHub repository and cannot be edited from here — the connected GitHub token is read-only (or knowledge editing is not available on this surface). Reconnect the source with a read-write token in Studio → Connectors to enable direct edits.',
            isError: true,
          }
        }
        const result = await opts.repoWriter.commitEntryUpdate({
          workspaceId: context.workspaceId,
          entry: { id: entry.id, path: entry.path, content: entry.content, sourceId: entry.sourceId },
          newBody: input.content,
          changeSummary: input.changeSummary,
          requestedBy: { userId: context.userId, label: opts.requesterLabel ?? null },
        })
        if (!result.ok) {
          return { data: result.message, isError: true }
        }
        return {
          data: {
            id: result.entryId,
            path: result.path,
            commit: result.commitSha ?? undefined,
            commitUrl: result.commitUrl ?? undefined,
            message: 'Entry updated and committed to the repository.',
          },
        }
      }

      // Manual entry — targeted body-only store update (title / tags /
      // sensitivity / compartments / related links untouched).
      try {
        const updated = await store.updateManualEntryContent(context.workspaceId, entry.id, input.content)
        if (!updated) {
          return { data: `Knowledge entry "${input.id}" not found.`, isError: true }
        }
        return { data: { id: updated.id, path: updated.path, message: 'Knowledge entry updated.' } }
      } catch (err) {
        return { data: `Update error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const tools = [searchKnowledge, browseKnowledge, readKnowledgeEntry, addKnowledgeEntry]
  // D2 (chat-only writes): `updateKnowledgeEntry` exists only on interactive
  // surfaces — for repo-synced KBs it additionally needs a push-capable
  // source (the injector only passes `repoWriter` then). Not injected ⇒ not
  // discoverable via mcp_search (closed world).
  if (opts?.allowWrites && (opts.repoWriter || !opts.repoConnected)) {
    tools.push(updateKnowledgeEntry)
  }
  return tools
}
