/** Internal source-backed native run -> atomic root Task intake.
 * No route/tool accepts routine provenance, quality or human flags.
 * Spec: docs/architecture/features/routine-work-intake.md
 * [COMP:api/routine-intake]
 */
import { createHash } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import {
  ContextScopeAccumulator, WorkflowDefinitionSchema, WorkflowTriggerSchema, crmDomainEventToDispatchEvent,
  evaluateTaskAdmission, matchesEvent, normalizeTaskTitle, parseAuthoringAuthority, pinAccessCeiling,
  qualifyRoutineTracking, readRoutineInput, routineConfigurationIssues, routineConfigurationShape,
  TASK_ADMISSION_THRESHOLDS, type AuthoringAuthority, type DispatchEvent, type ScopeEvidence,
  type TaskReadinessAssessment, type TaskRecord, type RoutineTrackingQualification,
} from '@use-brian/core'
import type { PoolClient } from 'pg'
import { applyRLSGucs, getPool, rollbackAndRelease } from '../db/client.js'
import { findRoutineReceipt, requireRoutineSchema, routineConfigurationDigest,
  type RoutineConfiguration, type RoutineIntakeReceipt } from '../db/routine-intake-store.js'
import { createTask } from '../db/tasks.js'
import { findSimilarTasks, findSimilarTombstones, listActiveRules } from '../db/task-admission-store.js'
import { readWorkflowRunInTransaction, validatePrimitiveEventMetadata } from '../db/workflow-store.js'
import { lockOperationalPolicy } from '../workspace-access/operational-admission.js'
import { resolveWorkflowAuthoringScope } from '../context-scope/workflow-authority.js'
import { readWorkflowInputEvidence } from '../context-scope/workflow-input-evidence.js'
import { validateCallerScopeEvidence } from '../context-scope/caller-evidence.js'
import { validateTaskResponsibility } from './responsibility.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')
class RoutineAdmissionError extends Error { constructor(readonly code: string) { super(code) } }
function refuse(code: string): never { throw new RoutineAdmissionError(code) }

type FrozenIntake = {
  revision: number; generation: number; digest: string; authorUserId: string;
  authority: AuthoringAuthority; configuration: RoutineConfiguration; sourceEvidence: ScopeEvidence;
}
type RunBinding = { workspace_id: string; workflow_id: string; input: Record<string, unknown>; trigger_kind: string;
  routine_intake_context: FrozenIntake | null; primitive_event_metadata_verified: boolean; crm_event_id: string | null }

/** Derived inside the writer transaction from immutable database context and
 * native event receipts. Its constructor is private to this internal service. */
type RoutineAdmissionContext = {
  runId: string; workspaceId: string; routineId: string; frozen: FrozenIntake;
  caseKey: string; event: DispatchEvent; evidence: ScopeEvidence; originSessionId: string | null;
}

async function admittedEvent(client: PoolClient, run: RunBinding): Promise<{ event: DispatchEvent; caseKey: string; originSessionId: string | null }> {
  const trigger = run.input.trigger as Record<string, unknown> | undefined
  const payload = run.input.event as Record<string, unknown> | undefined
  if (!trigger || !payload) refuse('routine_source_unverified')
  const sourceType = trigger.sourceType
  let caseKey: string
  let originSessionId: string | null = null
  let event: DispatchEvent
  if (sourceType === 'task' || sourceType === 'knowledge' || sourceType === 'page') {
    if (!run.primitive_event_metadata_verified) refuse('routine_source_unverified')
    let metadata: unknown
    if (sourceType === 'task' && typeof payload.taskId === 'string') {
      metadata = (await client.query('SELECT metadata FROM workflow_task_event_receipts WHERE workspace_id=$1 AND task_id=$2 FOR SHARE',
        [run.workspace_id, payload.taskId])).rows[0]?.metadata
      originSessionId = (await client.query('SELECT source_session_id FROM tasks WHERE workspace_id=$1 AND id=$2 FOR SHARE',
        [run.workspace_id, payload.taskId])).rows[0]?.source_session_id ?? null
      caseKey = `task:${payload.taskId}`
    } else if (sourceType === 'knowledge' && typeof payload.entryId === 'string' && typeof payload.sourceVersion === 'string') {
      metadata = (await client.query('SELECT metadata FROM workflow_knowledge_event_receipts WHERE workspace_id=$1 AND entry_id=$2 AND source_version=$3 AND NOT held FOR SHARE',
        [run.workspace_id, payload.entryId, payload.sourceVersion])).rows[0]?.metadata
      caseKey = `knowledge:${payload.entryId}:${payload.sourceVersion}:${payload.action}`
    } else if (sourceType === 'page' && typeof payload.pageId === 'string' && typeof payload.sourceVersion === 'string') {
      metadata = (await client.query(`SELECT metadata||jsonb_build_object('sourceVersion',revision::text) AS metadata
        FROM workflow_page_event_receipts WHERE workspace_id=$1 AND page_id=$2 AND revision=$3 FOR SHARE`,
        [run.workspace_id, payload.pageId, payload.sourceVersion])).rows[0]?.metadata
      caseKey = `page:${payload.sourceVersion}`
    } else refuse('routine_source_unverified')
    validatePrimitiveEventMetadata(run.input, sourceType, metadata, run.workspace_id)
    event = { workspaceId: run.workspace_id,
      source: sourceType === 'page' ? { type: 'page', pageId: String(trigger.pageId) } : { type: sourceType },
      text: typeof payload.title === 'string' ? payload.title : null,
      actorId: typeof trigger.actorId === 'string' ? trigger.actorId : null,
      channelId: typeof trigger.channelId === 'string' ? trigger.channelId : null,
      actions: Array.isArray(payload.actions) ? payload.actions as string[] : undefined,
      tags: Array.isArray(sourceType === 'task' ? payload.tagsAdded : payload.tags) ? (sourceType === 'task' ? payload.tagsAdded : payload.tags) as string[] : [],
      currentTags: sourceType === 'task' && Array.isArray(payload.tags) ? payload.tags as string[] : undefined,
      mentions: typeof payload.assigneeId === 'string' ? [payload.assigneeId] : [], isBot: false, payload }
  } else if (sourceType === 'crm' && run.crm_event_id) {
    const row = (await client.query(`SELECT id,workspace_id AS "workspaceId",event_type AS "eventType",subject_kind AS "subjectKind",
      subject_id AS "subjectId",payload,actor_kind AS "actorKind",occurred_at AS "occurredAt"
      FROM crm_domain_event_outbox WHERE id=$1 AND workspace_id=$2 FOR SHARE`, [run.crm_event_id, run.workspace_id])).rows[0]
    if (!row) refuse('routine_source_unverified')
    event = crmDomainEventToDispatchEvent(row)
    if (!isDeepStrictEqual(payload, event.payload)) refuse('routine_source_unverified')
    caseKey = `crm:${row.id}`
  } else refuse('routine_source_authoring_not_ready')
  return { event, caseKey, originSessionId }
}

export type RoutineIntakeResult =
  | { kind: 'not_routine' }
  | { kind: 'refused'; reason: string }
  | { kind: 'replayed'; receipt: RoutineIntakeReceipt }
  | { kind: 'created'; receipt: RoutineIntakeReceipt; task: TaskRecord; authorUserId: string; qualification: RoutineTrackingQualification }

function materialize(configuration: RoutineConfiguration, event: DispatchEvent) {
  const config = configuration.definition.taskIntake!
  const input = { event: event.payload }
  const missing = new Map<string, string>()
  const bindings = config.blueprint.inputs.map(binding => {
    const value = readRoutineInput(input, binding.path)
    const present = value !== undefined && value !== null && value !== ''
    if (binding.required && !present) missing.set(binding.key, binding.label)
    return { key: binding.key, label: binding.label, path: binding.path, required: binding.required, present,
      valueDigest: present ? digest(value) : null }
  })
  const render = (template: string) => template.replace(/\{\{([^}]+)\}\}/g, (_token, path: string) => {
    const value = readRoutineInput(input, path.trim().slice(6))
    if (value === undefined || value === null || value === '') {
      missing.set(path.trim(), path.trim().slice(12))
      return ''
    }
    return typeof value === 'string' ? value : JSON.stringify(value)
  }).trim()
  const outcome = render(config.blueprint.outcome)
  const description = render(config.blueprint.description)
  const completionCheck = render(config.blueprint.completionCheck)
  const title = config.blueprint.title ?? outcome
  if (!title || !outcome) refuse('routine_outcome_missing')
  const nativeReference = event.source.type === 'task' ? `task:${event.payload.taskId}`
    : event.source.type === 'knowledge' ? `knowledge_entry:${event.payload.entryId}`
      : event.source.type === 'page' ? `page:${event.payload.pageId}` : `crm:${event.payload.subjectKind}:${event.payload.subjectId}`
  const target = missing.size ? null : nativeReference
  const quality: TaskReadinessAssessment = { classification: missing.size ? 'needs_spec' : 'ready',
    evidenceQuote: null, evidenceVerified: true, commitment: 'explicit', objective: outcome, description: description || null,
    target, startingPointKind: target ? 'explicit' : 'missing', startingPoint: target,
    completionSignal: completionCheck || null,
    missing: [...(!target ? ['target', 'starting_point'] as const : []), ...(!completionCheck ? ['completion_signal'] as const : [])],
    explanation: missing.size ? `Missing execution inputs: ${[...missing.values()].join('; ')}` : 'Configured work is grounded in the native event receipt.' }
  // A blueprint without a required target binding can still use the actual
  // typed event identity as its starting source; it never invents an account/tool.
  if (!config.blueprint.inputs.some(b => b.required)) {
    quality.target = nativeReference
    quality.startingPoint = nativeReference
    quality.startingPointKind = 'explicit'
    quality.missing = quality.missing.filter(fact => fact !== 'target' && fact !== 'starting_point')
  }
  const qualification = qualifyRoutineTracking(quality, [...missing.keys()])
  const basis = { title, outcome, descriptionDigest: digest(description), completionCheckDigest: digest(completionCheck),
    blueprintDigest: digest(config.blueprint), inputs: bindings, missingInputs: [...missing].map(([key, label]) => ({ key, label })),
    outcomeFingerprint: digest({ outcome, blueprint: config.blueprint, inputs: bindings.filter(b => b.required) }) }
  return { title, outcome, description, completionCheck, quality, qualification, basis }
}

/** Receipt and canonical Task commit together. No execution callback runs here
 * until phase 3 wires the proved intake route to native execution entry. */
export async function admitRoutineRun(runId: string): Promise<RoutineIntakeResult> {
  const client = await getPool().connect()
  try {
    await client.query('BEGIN')
    await requireRoutineSchema(client)
    const pointer = (await client.query<RunBinding>('SELECT * FROM workflow_runs WHERE id=$1', [runId])).rows[0]
    if (!pointer?.routine_intake_context || pointer.trigger_kind !== 'event') { await client.query('COMMIT'); return { kind: 'not_routine' } }
    const policy = await lockOperationalPolicy(client, pointer.workspace_id)
    if (policy && policy.setupState !== 'legacy' && policy.setupState !== 'ready') refuse('routine_authority_unproven')
    const current = (await client.query(`SELECT w.* FROM workflows w WHERE w.id=$1 AND w.workspace_id=$2 FOR UPDATE`,
      [pointer.workflow_id, pointer.workspace_id])).rows[0]
    const run = (await client.query<RunBinding>('SELECT * FROM workflow_runs WHERE id=$1 FOR SHARE', [runId])).rows[0]
    const frozen = run.routine_intake_context
    if (!current || !frozen) refuse('routine_configuration_unavailable')
    const author = parseAuthoringAuthority(frozen.authority)
    if (!author || author.ceiling.userId !== frozen.authorUserId) refuse('routine_authority_unproven')
    await applyRLSGucs(client, frozen.authorUserId)
    const signal = await admittedEvent(client, run)
    const previous = await findRoutineReceipt(client, run.workspace_id, run.workflow_id, signal.caseKey)
    if (previous) { await client.query('COMMIT'); return { kind: 'replayed', receipt: previous } }
    if (!current.enabled || Number(current.task_intake_revision) !== frozen.revision
      || Number(current.task_intake_generation) !== frozen.generation || current.task_intake_digest !== frozen.digest
      || current.task_intake_applied_by !== frozen.authorUserId || !current.task_intake_apply_receipt) refuse('routine_intake_fenced')
    const definition = WorkflowDefinitionSchema.safeParse(frozen.configuration.definition)
    const trigger = WorkflowTriggerSchema.safeParse(frozen.configuration.trigger)
    if (!definition.success || !trigger.success) refuse('routine_configuration_unavailable')
    const configuration = { ...frozen.configuration, definition: definition.data, trigger: trigger.data }
    if (routineConfigurationIssues(configuration).length || routineConfigurationDigest(configuration) !== frozen.digest
      || !isDeepStrictEqual(routineConfigurationShape(configuration), routineConfigurationShape({
        definition: current.definition, trigger: current.trigger, contextGroupId: current.context_group_id, contextProjectId: current.context_project_id }))) {
      refuse('routine_configuration_unavailable')
    }
    if (configuration.trigger.kind !== 'event' || !configuration.trigger.event.sources.some(s => matchesEvent(signal.event, s))) refuse('routine_source_unmatched')
    const nativeRun = await readWorkflowRunInTransaction(client, run.workspace_id, runId)
    if (!nativeRun) refuse('routine_source_unverified')
    const source = new ContextScopeAccumulator(frozen.sourceEvidence)
    source.note(await readWorkflowInputEvidence(runId, run.workspace_id, client))
    if (!source.evidence.sources?.length) refuse('routine_source_unverified')
    const scope = await resolveWorkflowAuthoringScope({ userId: frozen.authorUserId, workspaceId: run.workspace_id,
      assistantId: author.assistantId, authoringAuthority: author,
      contextGroupId: configuration.contextGroupId, contextProjectId: configuration.contextProjectId }, client)
    // This run is an intake signal, not an initialized workflow action lane.
    // Validate current native sources under the retained human ceiling; do not
    // borrow a workflow execution snapshot or initialize a second pursuit.
    const evidence = await validateCallerScopeEvidence(source.evidence, pinAccessCeiling(scope.access), client)
    const executor = configuration.definition.defaultExecutor!
    if (executor.kind === 'assistant') {
      const selected = await resolveWorkflowAuthoringScope({ userId: frozen.authorUserId, workspaceId: run.workspace_id,
        assistantId: executor.assistantId, authoringAuthority: author,
        contextGroupId: configuration.contextGroupId, contextProjectId: configuration.contextProjectId }, client)
      await validateCallerScopeEvidence(evidence, pinAccessCeiling(selected.access), client)
    } else {
      const person = (await client.query('SELECT user_id FROM workspace_members WHERE id=$1 AND workspace_id=$2 FOR SHARE',
        [executor.memberId, run.workspace_id])).rows[0]?.user_id
      if (!person) refuse('routine_executor_unavailable')
      await applyRLSGucs(client, person)
      const allowed = (await client.query<{ ok: boolean }>('SELECT routine_workflow_sources_visible($1,$2::jsonb) AS ok',
        [run.workspace_id, JSON.stringify(evidence)])).rows[0]?.ok
      await applyRLSGucs(client, frozen.authorUserId)
      if (!allowed) refuse('routine_executor_unavailable')
    }
    const context: RoutineAdmissionContext = { runId, workspaceId: run.workspace_id, routineId: run.workflow_id,
      frozen, ...signal, evidence }
    const work = materialize(configuration, context.event)
    const normalized = normalizeTaskTitle(work.title)
    const rules = await listActiveRules(context.workspaceId, client)
    const tombstoneMatches = await findSimilarTombstones(context.workspaceId, normalized, TASK_ADMISSION_THRESHOLDS.TOMBSTONE_MATCH, client)
    let taskMatches = await findSimilarTasks(context.workspaceId, normalized, TASK_ADMISSION_THRESHOLDS.NEAR_DUPLICATE_HOLD, client)
    if (taskMatches.length) {
      const readable = (await client.query<{ id: string }>(`SELECT id FROM tasks WHERE workspace_id=$1 AND id=ANY($2::uuid[])
        AND NOT scope_held AND routine_task_sources_visible(id)
        AND workflow_evidence_envelope_visible(workspace_id,read_scope_source(workspace_id,'task',id))`,
        [context.workspaceId, taskMatches.map(t => t.id)])).rows
      const readableIds = new Set(readable.map(t => t.id))
      taskMatches = taskMatches.filter(match => readableIds.has(match.id))
      const known = (await client.query<{ task_id: string; fingerprint: string }>(`SELECT task_id,basis->>'outcomeFingerprint' AS fingerprint
        FROM task_routine_intake_receipts WHERE workspace_id=$1 AND task_id=ANY($2::uuid[])`, [context.workspaceId, taskMatches.map(t => t.id)])).rows
      const distinct = new Set(known.filter(r => r.fingerprint && r.fingerprint !== work.basis.outcomeFingerprint).map(r => r.task_id))
      taskMatches = taskMatches.filter(match => !distinct.has(match.id))
    }
    const decision = evaluateTaskAdmission({ candidate: { workspaceId: context.workspaceId, title: work.title, lane: 'extracted',
      sourceKind: `${context.event.source.type}_event`, channelRef: context.event.channelId, quality: work.quality,
      assigneeId: executor.kind === 'person' ? executor.memberId : null }, rules, tombstoneMatches, taskMatches }, work.qualification)
    if (work.qualification.kind !== 'trackable') refuse(`routine_${work.qualification.reason}`)
    if (decision.outcome !== 'allow') { await client.query('COMMIT'); return { kind: 'refused', reason: decision.reasonCode } }
    const config = configuration.definition.taskIntake!
    const envelope = { workspaceId: context.workspaceId, sensitivity: evidence.sensitivity ?? 'internal',
      compartments: [...new Set([...scope.writeCompartments, ...(evidence.compartments ?? [])])],
      projectIds: [...new Set([...scope.writeProjectIds, ...(evidence.projectIds ?? [])])],
      privateUserId: null, privateAssistantId: null }
    await validateTaskResponsibility(client, frozen.authorUserId, envelope, null, {
      assigneeId: executor.kind === 'person' ? executor.memberId : null, executorAssistantId: executor.kind === 'assistant' ? executor.assistantId : null,
      followUpMemberId: null, home: config.home!,
    })
    if (executor.kind === 'person') {
      const eligible = (await client.query<{ ok: boolean }>(`SELECT public.task_follow_up_eligible($1,$2,$3,$4::text[],NULL,$5,$6) AS ok`,
        [context.workspaceId, executor.memberId, envelope.sensitivity, envelope.compartments, config.home!.kind, config.home!.id])).rows[0]?.ok
      if (!eligible) refuse('routine_executor_unavailable')
    }
    const task = await createTask(frozen.authorUserId, { workspaceId: context.workspaceId, title: work.title,
      status: work.qualification.execution === 'waiting_for_input' ? 'blocked' : 'todo',
      assigneeId: executor.kind === 'person' ? executor.memberId : null, executorAssistantId: executor.kind === 'assistant' ? executor.assistantId : null,
      home: config.home!, attributes: { description: work.description, completionCheck: work.completionCheck },
      sensitivity: envelope.sensitivity, compartments: envelope.compartments, projectIds: envelope.projectIds,
      access: scope.access, source: 'extracted', sourceSessionId: context.originSessionId,
      createdByAssistantId: author.assistantId, writtenBy: 'system' }, undefined, client)
    await client.query(`INSERT INTO task_routine_intake_receipts(workspace_id,routine_id,accepted_revision,accepted_digest,case_key,
      run_id,task_id,source_evidence,basis,executor,home,qualification) VALUES($1,$2,$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb,$10::jsonb,$11::jsonb,$12::jsonb)`,
      [context.workspaceId, context.routineId, frozen.revision, frozen.digest, context.caseKey, runId, task.id,
        JSON.stringify(evidence), JSON.stringify({ ...work.basis, authorUserId: frozen.authorUserId, authoringAuthority: author,
          contextGroupId: configuration.contextGroupId, contextProjectId: configuration.contextProjectId,
          permittedActions: config.permittedActions, requiredAccounts: config.requiredAccounts }),
        JSON.stringify(executor), JSON.stringify(config.home), JSON.stringify(work.qualification)])
    const receipt = (await findRoutineReceipt(client, context.workspaceId, context.routineId, context.caseKey))!
    await client.query('COMMIT')
    notifyWorkspaceChange(context.workspaceId, 'task', 'create', task.id)
    return { kind: 'created', receipt, task, authorUserId: frozen.authorUserId, qualification: work.qualification }
  } catch (error) {
    if (error instanceof RoutineAdmissionError) return { kind: 'refused', reason: error.code }
    throw error
  } finally { await rollbackAndRelease(client) }
}
