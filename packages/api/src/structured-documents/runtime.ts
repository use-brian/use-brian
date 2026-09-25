import { z } from 'zod'
import type { FilesApi, FilesContext, Tool, ToolContext } from '@use-brian/core'
import type { OfficeCommand } from '@use-brian/office-model'
import { createStructuredExtractionStore } from '../db/structured-document-extractions.js'
import { createStructuredFillProposalStore } from '../db/structured-fill-proposals.js'
import type { StructuredOcrConnectorResolver } from './connector.js'
import { createStructuredDocumentService, SavedPrincipalSchema, type StructuredDocumentServiceOptions } from './service.js'
import { createStructuredDocumentTools } from './tools.js'
import { createStructuredExtractionWorker } from './worker.js'
import { prepareStructuredFill, FillMappingSchema } from '../office/structured-fill.js'

const lineageSchema = z.object({
  extractionId: z.string().uuid(), artifactId: z.string().uuid(),
  recordsSha256: z.string().regex(/^[a-f0-9]{64}$/), pdfSha256: z.string().regex(/^[a-f0-9]{64}$/),
  expectedVersion: z.number().int().nonnegative(), expectedSeq: z.number().int().positive(),
  baseVersionId: z.string().uuid(), mappings: z.array(FillMappingSchema.passthrough()).min(1).max(100),
}).passthrough()
const ranks = { public: 0, internal: 1, confidential: 2 }
const contains = (grant: string[] | null | undefined, requirements: string[]) => grant === null || (Array.isArray(grant) && requirements.every(v => grant.includes(v)))
function commandContent(command: OfficeCommand): unknown {
  const { commandId: _id, ...rest } = command
  return { ...rest, ...(command.kind === 'batch' ? { commands: command.commands.map(commandContent) } : {}) }
}

/** Boot composition only. The service never calls an LLM or applies a workbook. */
export function createStructuredDocumentRuntime(options: {
  connectors: StructuredOcrConnectorResolver
  files: FilesApi
  tools: Map<string, Tool>
  resolveContext(saved: FilesContext): Promise<FilesContext>
  resolvePolicy(name: string, ctx: ToolContext): Promise<'allow' | 'ask' | 'block'>
  getOffice: StructuredDocumentServiceOptions['getOffice']
  pendingActors(): Promise<string[]>
  warn?: () => void
  store?: ReturnType<typeof createStructuredExtractionStore>
  proposals?: ReturnType<typeof createStructuredFillProposalStore>
}) {
  const store = options.store ?? createStructuredExtractionStore()
  const proposals = options.proposals ?? createStructuredFillProposalStore()
  const service = createStructuredDocumentService({ files: options.files, store, connectors: options.connectors,
    resolveContext: options.resolveContext, getOffice: options.getOffice, saveProposal: proposals.save })
  const worker = createStructuredExtractionWorker({ store, resolveClient: service.resolveClient, files: options.files, authorize: service.authorize })
  for (const tool of createStructuredDocumentTools({ service, resolvePolicy: options.resolvePolicy })) options.tools.set(tool.name, tool)
  let timer: ReturnType<typeof setInterval> | undefined
  let running = false, stopped = true
  async function tick() {
    if (running || stopped) return
    running = true
    try {
      for (const userId of (await options.pendingActors()).slice(0, 20)) {
        if (stopped) break
        await worker.runOnce(userId)
      }
    } catch { options.warn?.() } finally { running = false }
  }
  return {
    service,
    start() { if (timer) return; stopped = false; timer = setInterval(() => { void tick() }, 5_000); timer.unref?.(); void tick() },
    stop() { stopped = true; if (timer) clearInterval(timer); timer = undefined },
    /** Acceptance is a separate human action. Recheck original and archived
     * evidence, live scopes and exact plan before the authoritative room applies it. */
    async verifySuggestion(userId: string, suggestionId: string, command: OfficeCommand): Promise<boolean> {
      try {
        const row = await proposals.get(userId, suggestionId)
        if (!row || command.kind !== 'batch' || !command.expectedSnapshotHash) return false
        const lineage = lineageSchema.parse(row.lineage)
        const job = await store.get(userId, lineage.extractionId)
        if (!job || job.userId !== userId) return false
        const principal = SavedPrincipalSchema.parse(job.context.principal)
        const evidence = await service.evidence(principal, job.id)
        if (job.pdfSha256 !== lineage.pdfSha256 || job.recordsSha256 !== lineage.recordsSha256) return false
        const office = await options.getOffice(userId, lineage.artifactId)
        if (!office) return false
        const { artifact, access, live } = office
        if (!access.canEdit || artifact.mode !== 'artifact' || artifact.family !== 'spreadsheet' || artifact.lifecycleState !== 'active' || artifact.workspaceId !== job.workspaceId ||
            artifact.headVersion !== lineage.expectedVersion || artifact.headVersionId !== lineage.baseVersionId || live.seq !== lineage.expectedSeq || live.baseVersion !== lineage.expectedVersion ||
            ranks[artifact.sensitivity] < ranks[evidence.scopeEvidence.sensitivity] || ranks[artifact.sensitivity] > ranks[evidence.context.clearance!] ||
            !contains(artifact.compartments,evidence.scopeEvidence.compartments ?? []) || !contains(artifact.projectIds,evidence.scopeEvidence.projectIds ?? []) ||
            !contains(evidence.context.compartments,artifact.compartments) || !contains(evidence.context.projectIds,artifact.projectIds)) return false
        const mappings = lineage.mappings.map(({targetId,source,meaning,reason}) => ({targetId,source,meaning,reason}))
        const rebuilt = prepareStructuredFill({ snapshot: live.snapshot, records: evidence.records, artifactId: artifact.id,
          assistantId: principal.assistantId, expectedVersion: lineage.expectedVersion, mappings })
        return JSON.stringify(commandContent(rebuilt.command)) === JSON.stringify(commandContent(command))
      } catch { return false }
    },
  }
}
