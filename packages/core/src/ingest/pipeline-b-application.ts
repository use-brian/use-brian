/**
 * Serializable Pipeline B application commands.
 *
 * Extraction and model-backed resolution produce these commands once. The
 * API persistence adapter can replay them without invoking a provider or
 * reconstructing policy decisions from prose.
 *
 * [COMP:brain/extraction-application]
 */
import type { Sensitivity } from '../security/sensitivity.js'
import type { StableExternalIdentity } from '../decision-learning/types.js'
import type { TaskReadinessAssessment } from '../tasks/admission.js'
import type { ExtractionApplicationRun } from './application.js'
import type { FrozenExtractionPlan } from './extraction-plan.js'

export type PipelineBSourceEnvelope = {
  workspaceId: string
  episodeId: string
  userId: string | null
  assistantId: string | null
  createdByUserId: string
  createdByAssistantId: string | null
  sensitivity: Sensitivity
  compartments: string[]
  projectIds: string[]
}

export type PipelineBEntityApplication = PipelineBSourceEnvelope & {
  command: 'entity'
  action: 'create_entity' | 'create_company' | 'create_contact' | 'supersede_entity' | 'reuse_entity'
  entityKind: 'person' | 'company' | 'project' | 'product' | 'repository'
  displayName: string
  canonicalId: string | null
  attributes: Record<string, unknown>
  targetEntityId: string | null
  alias: string | null
  externalRef?: Record<string, unknown> | null
  stableIdentity?: StableExternalIdentity | null
  phone?: string | null
}

export type PipelineBEdgeApplication = PipelineBSourceEnvelope & {
  command: 'edge' | 'digest_edge'
  edgeType: string
  attributes: Record<string, unknown>
  sourceDependencyIndex: number
  targetDependencyIndex: number | null
  targetRecordId: string | null
  sourceKind: 'entity' | 'memory'
  targetKind: 'entity' | 'episode'
}

export type PipelineBMemoryApplication = PipelineBSourceEnvelope & {
  command: 'memory' | 'digest_memory'
  scope: 'shared' | 'workspace'
  tags: string[]
  summary: string
  detail: string | null
}

export type PipelineBTaskApplication = PipelineBSourceEnvelope & {
  command: 'task'
  title: string
  dueIso: string | null
  channelRef: string | null
  sourceKind: string
  quality: TaskReadinessAssessment | null
}

export type PipelineBFinalizationApplication = PipelineBSourceEnvelope & {
  command: 'episode_finalization'
  summaryText: string
  tags: string[]
  sensitivityResult: unknown | null
}

export type PipelineBApplicationCommand =
  | PipelineBEntityApplication
  | PipelineBEdgeApplication
  | PipelineBMemoryApplication
  | PipelineBTaskApplication
  | PipelineBFinalizationApplication

export type PipelineBApplicationPort = {
  apply(input: {
    workspaceId: string
    actorUserId: string
    mutationCompartments: string[] | null
    projectIds: string[] | null
    attemptKey: string
    plan: FrozenExtractionPlan
    outboxJobId?: string | null
  }): Promise<ExtractionApplicationRun>
}

export function isPipelineBApplicationCommand(value: unknown): value is PipelineBApplicationCommand {
  if (!value || typeof value !== 'object') return false
  const command = (value as { command?: unknown }).command
  return typeof command === 'string' && [
    'entity', 'edge', 'digest_edge', 'memory', 'digest_memory', 'task', 'episode_finalization',
  ].includes(command)
}
