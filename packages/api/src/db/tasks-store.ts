import {ContextScopeAccumulator,DerivedScopeError,intersectAccessCeilings,pinAccessCeiling,type ScopeSource} from '@use-brian/core'
import {readRetainedContextFrame,writeRetainedContextFrame} from './session-context-revisions.js'
import {readExternalSourceAncestors} from '../application-platform/external-source-ancestry.js'
import {readApplicationFieldAncestors} from '../application-platform/field-evidence.js'
import {getPool} from './client.js'
import type { EntityLinksStore, TaskAssignmentProvenance, TaskRecord, TaskStore, SessionContextAuthority } from '@use-brian/core'
import { createTask,emitCreatedTaskEffects, findTasksByExternalRefSystem, getTaskById, listTasks, resolveTaskById, updateTask } from './tasks.js'

/**
 * Create a TaskStore backed by PostgreSQL.
 * Adapts the SQL helpers in `tasks.ts` to the core `TaskStore` interface.
 *
 * All operations route through `queryWithRLS(userId, ...)` so the
 * `tasks_workspace_member` RLS policy enforces workspace isolation. The
 * SQL also filters by `workspace_id` explicitly — RLS is the second
 * layer of defense.
 *
 * WU-1.7 — the optional `entityLinks` dependency wires the edge-write
 * hook: `create` emits a `task → entity` `mentioned` edge per id in the
 * (cast-supplied) `linkedEntityIds` field, fire-and-forget. Optional so
 * callers without the graph layer keep working.
 *
 * The optional `onTaskTerminal` dependency wires the goal-seeker structural
 * rollup: when a sub-task closes (transitions to a terminal status), the
 * goal-seeker re-checks goals bound to that sub-task's PARENT — a parent's
 * `subtasks` done_when becomes met once its last open child closes (see
 * `docs/architecture/features/goals.md` → "The structural rollup"). Same
 * shape as `entityLinks`: best-effort, fire-and-forget, never blocks or
 * fails the task write, and absent callers keep working unchanged.
 *
 * The optional `onTaskCreate` dependency wires the task-autopilot auto-draft:
 * a TOP-LEVEL task auto-drafts a (curated, UNCONFIRMED) goal bound to it (see
 * `docs/plans/task-goal-autopilot.md`). A sub-task is decomposition under its
 * parent's goal, so it gets none. Same fire-and-forget contract.
 */
export function createDbTaskStore(
  deps: {
    entityLinks?: EntityLinksStore
    onTaskTerminal?: (host: { type: 'task'; id: string }) => void
    onTaskCreate?: (task: TaskRecord, userId: string, assignment?: TaskAssignmentProvenance, authority?: SessionContextAuthority) => void
  } = {},
): TaskStore {
  const { entityLinks, onTaskTerminal, onTaskCreate } = deps
  return {
    async create({ userId, assignment, authority, ...params }) {
      if(authority){
        const {execution,accumulator}=authority
        if(!(accumulator instanceof ContextScopeAccumulator)||userId!==execution.security.access.userId||params.workspaceId!==execution.security.access.workspaceId
          ||params.createdByAssistantId!=null&&params.createdByAssistantId!==execution.assistant.id
          ||params.sourceSessionId!=null&&params.sourceSessionId!==execution.lifecycle.sessionId)throw new DerivedScopeError('scope_evidence_missing')
        const roots=new ContextScopeAccumulator({sources:[...(accumulator.evidence.sources??[]),...(params.derivation?.sources??[])]})
        const initial=roots.evidence.sources??[],workspaceId=execution.security.access.workspaceId
        roots.note({sources:[...await readExternalSourceAncestors(workspaceId,initial),...await readApplicationFieldAncestors(workspaceId,initial)]})
        const sources=roots.evidence.sources??[];let inserted:TaskRecord|undefined
        if(sources.length&&params.dependsOn?.length)throw new DerivedScopeError('scope_evidence_missing')
        const requested=pinAccessCeiling({...execution.security.access,...Object.fromEntries(Object.entries(params.access??{}).filter(([,value])=>value!==undefined))})
        const access={...execution.security.access,...intersectAccessCeilings(execution.security.ceiling,requested)}
        const task=await writeRetainedContextFrame(authority,sources,client=>createTask(userId,{...params,access,...(sources.length?{derivation:{producer:params.derivation?.producer??'tool:saveTask:create',sources}}:{})},undefined,client,
          {deduplicate:true,onInsertedInTransaction:row=>{inserted=row}}))
        // Source-backed Goal/event/graph consumers need their own original-authority admission.
        if(inserted&&!sources.length)try{emitCreatedTaskEffects(inserted,userId,params,entityLinks);if(onTaskCreate&&inserted.parentId===null)onTaskCreate(inserted,userId,assignment)}
        catch(error){throw Object.assign(error instanceof Error?error:new Error('task_post_commit_unavailable'),{retrySafe:false,operationMayHaveExecuted:true})}
        const goalDraftRequested=!!(inserted&&sources.length&&onTaskCreate&&inserted.parentId===null)
        if(goalDraftRequested)try{onTaskCreate!(inserted!,userId,assignment,{execution,accumulator:new ContextScopeAccumulator({sources})})}
        catch(error){throw Object.assign(error instanceof Error?error:new Error('task_post_commit_unavailable'),{retrySafe:false,operationMayHaveExecuted:true})}
        return sources.length?Object.assign(task,{sourceContinuation:{state:'held' as const,reason:'source_authority_required' as const,goalDraft:goalDraftRequested?'requested' as const:'held' as const}}):task
      }
      if(params.derivation?.sources.length)throw new DerivedScopeError('scope_evidence_missing')
      // Admission and dedup share the writer transaction; only inserts emit hooks.
      // `linkedEntityIds` is not on the `TaskStore.create` interface
      // yet (a follow-up type widening) — read it via a permissive
      // cast and thread it into `createTask` for the `mentioned` edge.
      const extras = params as typeof params & { linkedEntityIds?: readonly string[] }
      const record = await createTask(userId, { ...params, linkedEntityIds: extras.linkedEntityIds }, entityLinks, undefined, {
        deduplicate: true,
        onInserted: task => { if (onTaskCreate && task.parentId === null) onTaskCreate(task, userId, assignment) },
      })
      return record
    },
    async getById(ctx, id, authority) {
      if(!authority)return getTaskById(ctx,id)
      const {execution}=authority
      if(ctx.userId!==execution.security.access.userId||ctx.workspaceId!==execution.security.access.workspaceId||ctx.assistantId!==execution.assistant.id)throw new DerivedScopeError('scope_evidence_missing')
      const source=(await getPool().query<{source:ScopeSource&{held?:boolean}}>("SELECT read_scope_source($1,'task',$2) AS source",[ctx.workspaceId,id])).rows[0]?.source
      if(!source||source.held!==false)return null
      const requested=pinAccessCeiling({...execution.security.access,...Object.fromEntries(Object.entries(ctx).filter(([,value])=>value!==undefined))})
      const access={...execution.security.access,...intersectAccessCeilings(execution.security.ceiling,requested)}
      return readRetainedContextFrame(authority,[source],client=>getTaskById(access,id,client))
    },
    resolveById(ctx, id) {
      return resolveTaskById(ctx, id)
    },
    list(ctx, filters) {
      return listTasks(ctx, filters)
    },
    findByExternalRefSystem(workspaceId, match) {
      return findTasksByExternalRefSystem(workspaceId, match)
    },
    async update(userId, id, fields, opts) {
      const record = await updateTask(userId, id, fields, entityLinks, opts)
      // Fire the rollup only on an actual close (status set to terminal) of a
      // task that has a parent to roll up to. Fire-and-forget: a goal rollup
      // must never block or break a task write (the goal also re-checks itself
      // when next driven). `updateTask` carries `parentId` forward onto the
      // new bi-temporal row, so `record.parentId` is the live parent id.
      if (
        onTaskTerminal &&
        record?.parentId &&
        (fields.status === 'done' || fields.status === 'archived')
      ) {
        onTaskTerminal({ type: 'task', id: record.parentId })
      }
      return record
    },
  }
}
