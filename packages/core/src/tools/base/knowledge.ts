/**
 * Knowledge base tools — search, browse, read, add, and update entries.
 *
 * Built-in tools injected directly into the tool map (no MCP indirection).
 *
 * Write surface (docs/architecture/features/knowledge-base.md → "Assistant
 * direct edits"): source-backed knowledge bases are assistant-editable only
 * when the injector passes a `repoWriter` — which it does only on
 * interactive, confirmation-capable surfaces AND when a source is writable.
 * GitHub uses its cached PAT probe; local sources use the filesystem writer.
 * Every write carries
 * `requiresConfirmation` (per-edit Approve/Deny) and the descriptions
 * forbid proactive use: the assistant edits the KB only when the user
 * explicitly asked in the conversation.
 */

import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '../types.js'
import { notFoundMessage, toolFailure } from '../tool-failure.js'
import type {
  KnowledgeStoreInterface,
  KnowledgeRepoWriter,
  KnowledgeRepoWriteResult,
} from '../../knowledge/types.js'
import { unifiedDiffLines } from '../../knowledge/text-diff.js'
import { RANK, researchWriteFloor, type Sensitivity } from '../../security/sensitivity.js'
import { unionCompartments } from '../../security/compartments.js'

export type KnowledgeToolOptions = {
  /** Whether any sync source is connected for this workspace. */
  repoConnected?: boolean
  /**
   * Repo write-back port. Present ONLY when the surface allows knowledge
   * writes (interactive chat — D2) AND at least one source's cached PAT
   * probe says push access. Enables repo mode on `addKnowledgeEntry` and
   * repo routing in `updateKnowledgeEntry`.
   */
  repoWriter?: KnowledgeRepoWriter
  /** Writable source targets. Local sources do not require a PAT probe. */
  writableSources?: Array<{ id: string; repo: string; sourceType: 'github' | 'local' }>
  /**
   * Interactive-surface flag: gates emission of `updateKnowledgeEntry`
   * entirely. Non-interactive surfaces (workflow, scheduled, A2A, public
   * API) never see the tool.
   */
  allowWrites?: boolean
  /** Requesting member's display label (email) for commit attribution. */
  requesterLabel?: string | null
}

/**
 * Read tools' no-workspace failure. Returned WITH `isError` — before
 * 2026-08-17 it was a plain success payload, so the model read three
 * failures as "the knowledge base is empty" and reported that to users.
 */
const NO_WORKSPACE_KB =
  'This assistant is not attached to a workspace, and the knowledge base is a workspace resource — so there is no knowledge base to read here (this is not an empty result). Nothing you pass will change that in this conversation: do not retry searchKnowledge / browseKnowledge / readKnowledgeEntry. Answer from what you already know and tell the user this assistant has no knowledge base.'

const EXPLICIT_ASK_RULE =
  'Only use this when the user has explicitly asked, in this conversation, to change the knowledge base — never proactively.'

/**
 * Retry verdict per repo-write rejection reason.
 *
 * `KnowledgeRepoWriteResult` carries a machine-readable `reason` next to its
 * `message`, and both write tools threw the `reason` away and relayed the
 * message alone. The messages are written for a human reading a diff, so the
 * model could not tell "the repo moved under you, re-read and try again"
 * (recoverable in one turn) from "GitHub refused the push" (never
 * recoverable) — and it retried both, repeatedly, on the same content.
 * See docs/architecture/features/knowledge-base.md → "Assistant direct edits".
 */
const REPO_WRITE_VERDICT: Record<KnowledgeRepoWriteReason, string> = {
  error:
    'This is a transient failure (network, or a source-side 5xx); nothing was committed. Retry once — if it fails again, tell the user rather than looping.',
  stale_entry:
    'The entry changed since it was read; re-read it after the next sync (or via readKnowledgeEntry) and retry once with current content.',
  push_denied:
    'The source repository refused the push (permissions / branch protection); never retry — tell the user.',
  not_writable:
    'This source is read-only for this workspace (its stored token has no push access), so no retry can succeed. Tell the user, and offer the content in chat instead.',
  no_credentials:
    'The source has no working token, so nothing can be committed and no retry will change that. Tell the user to reconnect the knowledge source in Studio → Knowledge.',
  source_missing:
    'The entry\'s source row is gone or malformed, so there is nowhere to write. Do not retry; tell the user the knowledge source needs to be reconnected.',
  file_missing:
    'No file in the source resolves to that entry path, so there is nothing to update. Do NOT retry this id — re-resolve the entry with searchKnowledge / readKnowledgeEntry, or create it with addKnowledgeEntry.',
  file_exists:
    'A file already exists at that path, so this create cannot proceed. Do NOT retry the same path — update the existing entry with updateKnowledgeEntry, or choose a different path.',
}

type KnowledgeRepoWriteFailure = Extract<KnowledgeRepoWriteResult, { ok: false }>
type KnowledgeRepoWriteReason = KnowledgeRepoWriteFailure['reason']

/** The writer's own message plus the verdict its `reason` implies. */
function repoWriteFailure(result: KnowledgeRepoWriteFailure): { data: string; isError: true } {
  const verdict = REPO_WRITE_VERDICT[result.reason] ?? REPO_WRITE_VERDICT.error
  return { data: `${result.message} (${result.reason}) ${verdict}`, isError: true }
}

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
      'Search the workspace knowledge base (KB) by keyword. Returns matching entries with titles, paths, and summaries. Use this when you need to find specific information in the team\'s knowledge base.',
    inputSchema: z.object({
      query: z.string().describe('Search keywords (e.g. "vault fee structure", "deployment architecture").'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 5_000,

    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: NO_WORKSPACE_KB, isError: true }
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
        return toolFailure(err, {
          tool: 'searchKnowledge',
          target: `query "${input.query}"`,
          next: 'This is a failed search, NOT an empty knowledge base — do not tell the user nothing was found.',
        })
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
        return { data: NO_WORKSPACE_KB, isError: true }
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
        return toolFailure(err, {
          tool: 'browseKnowledge',
          target: input.path ? `path "${input.path}"` : 'the top level',
          next: 'This is a failed listing, NOT an empty knowledge base — do not tell the user there are no entries.',
        })
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
        return { data: NO_WORKSPACE_KB, isError: true }
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
          return {
            data: notFoundMessage({
              kind: 'Knowledge entry',
              id: `"${input.id}"`,
              discoveryTool: 'searchKnowledge or browseKnowledge',
              extra: 'It may also sit above your clearance, which reads the same as absent.',
              idSource: 'searchKnowledge / browseKnowledge results and are full UUIDs, never a path or a title',
            }),
            isError: true,
          }
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
        return toolFailure(err, {
          tool: 'readKnowledgeEntry',
          target: `entry "${input.id}"`,
          next: 'The entry may well exist — this is a read failure, not a missing entry.',
        })
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
  function pickWritableSource(
    requestedRepo: string | undefined,
  ): NonNullable<KnowledgeToolOptions['writableSources']>[number] | string {
    const writable = opts?.writableSources ?? []
    if (writable.length === 0) {
      return (
        'No writable knowledge source is available: every connected source is read-only from here, so there is nowhere to commit this entry. ' +
        'No argument change or retry will fix that. Tell the user the knowledge base cannot be written to from this assistant, and offer the content in chat instead.'
      )
    }
    if (requestedRepo) {
      const found = writable.find((s) => s.repo === requestedRepo.trim())
      return (
        found ??
        `"${requestedRepo}" is not a writable knowledge source. Writable: ${writable.map((s) => s.repo).join(', ')}. ` +
          `Retry with "repo" set to one of those exact values; retrying "${requestedRepo}" will fail the same way.`
      )
    }
    if (writable.length > 1) {
      return (
        `Multiple knowledge sources are writable — pass "repo" to choose one of: ${writable.map((s) => s.repo).join(', ')}. ` +
        'Nothing was written. Retry the same call with "repo" set, or ask the user which source the entry belongs in; the call cannot succeed without it.'
      )
    }
    return writable[0]
  }

  const addKnowledgeEntry = buildTool({
    name: 'addKnowledgeEntry',
    description:
      `Add a new entry to the knowledge base. ${EXPLICIT_ASK_RULE} ` +
      'Requires a path (directory-like), title, and content. The knowledge base is for curated, reusable information — not personal notes. ' +
      'When the knowledge base is synced from a source, the entry is written directly to that source on approval. ' +
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
        'Target source (GitHub owner/name or local directory). Only needed when more than one source is writable.',
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
          ? target.sourceType === 'local' ? `Writes directly to ${target.repo}` : `Commits directly to ${target.repo}`
          : 'Saves to the workspace knowledge base',
        `Sensitivity: ${args.sensitivity ?? 'internal'} (raised automatically if this turn used higher-tier sources)`,
      ]
      if (args.content) lines.push(`Body: ${bodyPreview(args.content)}`)
      return lines
    },

    async execute(input, context) {
      if (!context.workspaceId) {
        return {
          data: `Cannot create knowledge entry "${input.path}": this assistant is not attached to a workspace, and knowledge entries are stored per workspace. Retrying will not help and no argument fixes it — tell the user the entry cannot be saved here, and offer the content directly instead.`,
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
            data:
              'No writable knowledge source is available on this surface, so the entry was not created. ' +
              'GitHub sources require a read-write token; local sources require filesystem write-back to be enabled. ' +
              'This is a workspace setup gap, not an argument problem: no retry will change it. ' +
              'Tell the user the knowledge base is read-only here and that a read-write source must be connected in Studio → Knowledge, and offer the content in chat instead.',
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
          return repoWriteFailure(result)
        }
        return {
          data: {
            id: result.entryId,
            path: result.path,
            sensitivity: stamp,
            commit: result.commitSha ?? undefined,
            commitUrl: result.commitUrl ?? undefined,
            message: result.sourceType === 'local'
              ? 'Knowledge entry created in the local source directory.'
              : 'Knowledge entry created and committed to the repository.',
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
        return toolFailure(err, {
          tool: 'addKnowledgeEntry',
          target: `path "${input.path}"`,
          mutating: true,
          next: 'The entry does not exist, so do not tell the user it was saved.',
        })
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
        const target = entry.sourceId
          ? opts?.writableSources?.find((s) => s.id === entry.sourceId)
          : null
        const lines = [
          `Update knowledge entry "${entry.title}" (${entry.path})`,
          entry.sourceId
            ? target?.sourceType === 'local'
              ? `Writes directly to ${target.repo}`
              : `Commits directly to ${target?.repo ?? 'the knowledge repository'}`
            : 'Manual entry — updates the workspace knowledge base',
        ]
        if (args.changeSummary) lines.push(`Change: ${args.changeSummary}`)
        // "View proposed change": old-vs-new unified diff, computed here
        // because only the server holds the old body. The web card renders
        // these lines as a styled diff block (keyed on this tool's name);
        // channel surfaces show them as plain text. Falls back to the flat
        // body preview when the diff is empty (whitespace-only edit).
        if (args.content) {
          const diff = unifiedDiffLines(entry.content, args.content, { maxLines: 40 })
          if (diff.length > 0) {
            lines.push('Changes:')
            lines.push(...diff)
          } else {
            lines.push(`New body: ${bodyPreview(args.content)}`)
          }
        }
        return lines
      } catch {
        return null
      }
    },

    async execute(input, context) {
      if (!context.workspaceId) {
        return { data: NO_WORKSPACE_KB, isError: true }
      }
      let entry
      try {
        entry = await readEntry(context, input.id)
      } catch (err) {
        // NOT `mutating` — this catch fires on the pre-read, strictly before
        // any write, so the transient branch's "the write may or may not have
        // been applied, read it back" would be a false statement.
        return toolFailure(err, {
          tool: 'updateKnowledgeEntry',
          target: `entry "${input.id}"`,
          next:
            'Nothing was written: it never got as far as the write. The entry may well exist — this is a read failure, not a missing entry.',
        })
      }
      if (!entry) {
        return {
            data: notFoundMessage({
              kind: 'Knowledge entry',
              id: `"${input.id}"`,
              discoveryTool: 'searchKnowledge or browseKnowledge',
              extra: 'It may also sit above your clearance, which reads the same as absent.',
              idSource: 'searchKnowledge / browseKnowledge results and are full UUIDs, never a path or a title',
            }),
            isError: true,
          }
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
            data:
              'This source-backed entry cannot be edited from here because source write-back is unavailable on this surface, so nothing was changed. ' +
              'Repo-synced entries are edited by committing to their source, which needs a read-write connection this surface does not have. ' +
              'No retry and no argument change will help. Tell the user the entry must be edited in its source repository, or hand them the revised text.',
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
          return repoWriteFailure(result)
        }
        return {
          data: {
            id: result.entryId,
            path: result.path,
            commit: result.commitSha ?? undefined,
            commitUrl: result.commitUrl ?? undefined,
            message: result.sourceType === 'local'
              ? 'Entry updated in the local source directory.'
              : 'Entry updated and committed to the repository.',
          },
        }
      }

      // Manual entry — targeted body-only store update (title / tags /
      // sensitivity / compartments / related links untouched).
      try {
        const updated = await store.updateManualEntryContent(context.workspaceId, entry.id, input.content)
        if (!updated) {
          return {
            data: notFoundMessage({
              kind: 'Knowledge entry',
              id: `"${input.id}"`,
              discoveryTool: 'searchKnowledge or browseKnowledge',
              extra: 'It may also sit above your clearance, which reads the same as absent.',
              idSource: 'searchKnowledge / browseKnowledge results and are full UUIDs, never a path or a title',
            }),
            isError: true,
          }
        }
        return { data: { id: updated.id, path: updated.path, message: 'Knowledge entry updated.' } }
      } catch (err) {
        return toolFailure(err, {
          tool: 'updateKnowledgeEntry',
          target: `entry "${input.id}"`,
          mutating: true,
          next: 'The entry still holds its previous body, so do not tell the user the change was saved.',
        })
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
