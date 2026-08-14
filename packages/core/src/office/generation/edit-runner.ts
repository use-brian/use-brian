/** Context-clean explicit @Brian Office revision lane. [COMP:office/generation] */
import { z } from 'zod'
import {
  OfficeArtifactSnapshotSchema,
  OfficeCommandSchema,
  applyOfficeCommand,
  preflightOfficeCandidate,
  type OfficeArtifactSnapshot,
  type OfficeCommand,
} from '@use-brian/office-model'
import { fitOfficeArtifact } from '@use-brian/office-renderer'

export const OfficeEditBriefSchema = z.object({
  artifactId: z.string().uuid(),
  baseVersion: z.number().int().min(0),
  currentVersion: z.number().int().min(0),
  role: z.enum(['comment', 'edit']),
  assistantId: z.string().uuid(),
  instruction: z.string().min(1).max(20_000),
  targetIds: z.array(z.string().uuid()).min(1).max(1_000),
  changedObjectIdsSinceBase: z.array(z.string().uuid()).max(10_000).default([]),
  threadExcerpt: z.array(z.object({ author: z.string().max(255), body: z.string().max(20_000) }).strict()).max(50),
  templateConstraints: z.array(z.string().max(2_000)).max(100),
  evidencePacket: z.array(z.object({ handle: z.string(), excerpt: z.string(), sensitivity: z.enum(['public','internal','confidential']) }).strict()).max(200),
  snapshot: OfficeArtifactSnapshotSchema,
}).strict()
export type OfficeEditBrief = z.infer<typeof OfficeEditBriefSchema>

export type OfficeEditReceipt = {
  mode: 'direct' | 'proposal'
  reason: 'applied' | 'comment_role' | 'overlap_conflict'
  commands: OfficeCommand[]
  snapshot?: OfficeArtifactSnapshot
  affectedObjectIds: string[]
}

export async function runOfficeEdit(
  input: OfficeEditBrief,
  generate: (context: { instruction: string; targetIds: string[]; threadExcerpt: OfficeEditBrief['threadExcerpt']; templateConstraints: string[]; evidencePacket: OfficeEditBrief['evidencePacket']; snapshot: OfficeArtifactSnapshot }) => Promise<unknown[]>,
): Promise<OfficeEditReceipt> {
  const brief = OfficeEditBriefSchema.parse(input)
  if (brief.snapshot.artifactId !== brief.artifactId) throw new Error('Office edit snapshot does not match artifact')
  const commands = (await generate({ instruction: brief.instruction, targetIds: brief.targetIds, threadExcerpt: brief.threadExcerpt, templateConstraints: brief.templateConstraints, evidencePacket: brief.evidencePacket, snapshot: brief.snapshot })).map((command) => OfficeCommandSchema.parse(command))
  if (commands.some((command) => command.artifactId !== brief.artifactId || command.baseVersion !== brief.baseVersion)) throw new Error('Office edit command authority does not match brief')
  if (commands.some((command) => command.actor.type !== 'assistant' || command.actor.id !== brief.assistantId || command.origin !== 'ai')) throw new Error('Office edit command actor does not match Brian revision authority')
  if (commands.length === 0) throw new Error('Office edit returned no commands')
  const changed = new Set(brief.changedObjectIdsSinceBase)
  const overlap = brief.targetIds.some((id) => changed.has(id)) || brief.currentVersion < brief.baseVersion
  const affectedObjectIds = [...new Set(commands.flatMap(commandTargets))]
  if (affectedObjectIds.length === 0) throw new Error('Office edit commands have no semantic targets')
  let snapshot = brief.snapshot
  for (const command of commands) snapshot = applyOfficeCommand(snapshot, command)
  const preflight = preflightOfficeCandidate(snapshot)
  if (!preflight.ok) throw new Error(`Office edit failed preflight: ${preflight.diagnostics.map((item) => `${item.path}: ${item.message}`).join('; ')}`)
  const fit = fitOfficeArtifact(snapshot)
  if (!fit.ok) throw new Error(`Office edit failed fit: ${fit.issues.map((item) => `${item.objectId}: ${item.message}`).join('; ')}`)
  if (brief.role === 'comment') return { mode: 'proposal', reason: 'comment_role', commands, affectedObjectIds }
  if (overlap) return { mode: 'proposal', reason: 'overlap_conflict', commands, affectedObjectIds }
  return { mode: 'direct', reason: 'applied', commands, snapshot, affectedObjectIds }
}

function commandTargets(command: OfficeCommand): string[] {
  if ('targetId' in command) return [command.targetId]
  if (command.kind === 'updateSpreadsheetImage') return [command.imageId]
  if (command.kind === 'setSpreadsheetCell') return [command.cellId]
  if (command.kind === 'reorderSlideObject') return [command.objectId]
  if (command.kind === 'addSlide') return [command.slide.id]
  if (command.kind === 'addWorksheet') return [command.worksheet.id]
  if ('slideId' in command) return [command.slideId]
  if ('sheetId' in command) return [command.sheetId]
  if ('sectionId' in command) return [command.sectionId]
  if (command.kind === 'batch') return command.commands.flatMap((child) => {
    const parsed = OfficeCommandSchema.safeParse(child)
    return parsed.success ? commandTargets(parsed.data) : []
  })
  return []
}
