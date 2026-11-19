/** Current Page-thread sink admission. [COMP:api/page-thread-audience] */
import { z } from 'zod'
import type { Pool } from 'pg'
import type { AccessCeiling } from '@use-brian/agent-runtime/security/access-ceiling.js'
import { ContextScopeAccumulator, type ScopeEvidence } from '@use-brian/agent-runtime/security/context-scope.js'
import { DerivedScopeError, resourceScopeKey, type ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import type { ExecutionContext } from '@use-brian/agent-runtime/security/execution-context.js'
import type { DocPageRead } from '@use-brian/core/doc/tools.js'
import { decodeConversationPreparationCohort, nativeSessionCurrentScopeSchema } from '../application-platform/conversation-evidence.js'
import { getApplicationExecutionBinding } from '../application-platform/execution-context.js'
import { getAppPool, rlsGucSettings, runWithAgentAccess } from '../db/client.js'
import { captureSessionAuthority } from './authority-lease.js'
import { assertScopeEvidenceFitsCeiling } from './caller-evidence.js'
import { nativeTurnAuthorityParameters } from './conversation-record-admission.js'

const signatures = [
  'public.capture_native_page_turn_delivery(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid,text,jsonb,jsonb)',
  'public.capture_native_page_turn_anchor(uuid,uuid,uuid,uuid,uuid,integer,uuid,boolean,boolean,uuid,uuid)',
]
const pageKinds = ['page_event_changed', 'page_event_destination', 'page_live_changed', 'page_live_destination'] as const
const pageScope = nativeSessionCurrentScopeSchema.extend({ resourceKind: z.enum(pageKinds), assistantId: z.null() })
const pageProof = z.object({ source: pageScope, requiredSources: z.array(pageScope).min(1), principalAllowed: z.literal(true) }).strict()
const result = z.object({ authority: z.unknown(), destination: z.unknown(), ordinary: z.unknown(), pages: z.array(pageProof).max(32) }).strict()
const anchorResult = z.object({ authority: z.unknown(), source: pageProof, page: z.object({
  page: z.custom<DocPageRead['page']>().nullable(), version: z.number().int().nullable(), title: z.string().nullable(),
  nameOrigin: z.enum(['placeholder', 'auto', 'user']).nullable(), icon: z.string().nullable(),
}).strict() }).strict()
const ordinaryKinds = new Set(['application_field', 'session_message', 'session_context_revision', 'memory', 'workspace_file', 'private_transcript'])
const isPage = (source: ScopeSource) => (pageKinds as readonly string[]).includes(source.resourceKind)
const root = (source: ScopeSource) => ({ kind: source.resourceKind, id: source.resourceId, version: source.version })
const installedPools = new WeakMap<Pool, boolean>()
function changed(): never { throw new DerivedScopeError('scope_source_changed') }

async function nativePagePool(execution: ExecutionContext, room: AccessCeiling): Promise<Pool | null> {
  const { identity, ownership, security, surface } = execution
  const actor = security.access.userId
  if (identity.kind !== 'attended' || identity.principal.kind !== 'workspace_member'
    || identity.principal.authenticationKind !== 'native_session' || identity.principal.userId !== actor
    || ownership.kind !== 'workspace' || ownership.workspaceId !== room.workspaceId || room.userId !== ''
    || !security.access.sharedAudience || security.access.systemRead || surface.systemRead || surface.clientSelfMemory
    || getApplicationExecutionBinding(execution) || security.provenance.sources?.length) return null
  const pool = getAppPool()
  if (installedPools.get(pool) === undefined) {
    const installed = (await pool.query<{ installed: boolean }>(`SELECT bool_and(coalesce(
      has_function_privilege(current_user,to_regprocedure(signature),'EXECUTE'),false)) AS installed
      FROM unnest($1::text[]) signature`, [signatures])).rows[0]?.installed
    installedPools.set(pool, installed === true)
  }
  return installedPools.get(pool) ? pool : null
}

const anonymous = (values: readonly ScopeSource[]) => values.map(source => isPage(source) ? { ...source, userId: null } : source)

/** A complete answer proves the original invocation and both recipients in
 * this sink operation. Null transfers independently owned cohorts to their
 * full legacy validator. A current denial or execution failure is final. */
export async function tryAdmitNativePageTurnDelivery(execution: ExecutionContext, evidence: ScopeEvidence,
  room: AccessCeiling, boundary: 'dispatch' | 'frame'): Promise<ScopeEvidence | null> {
  const sources = evidence.sources ?? []
  const ordinary = sources.filter(source => !isPage(source)), pages = sources.filter(isPage)
  if (ordinary.length > 4096 || pages.length > 32 || ordinary.some(source => !ordinaryKinds.has(source.resourceKind))
    || sources.some(source => source.workspaceId !== room.workspaceId)) return null
  const pool = await nativePagePool(execution, room)
  if (!pool) return null
  const captured = await captureSessionAuthority(execution.security.authority, async input => {
    if (!input.turn) return null
    const parameters = nativeTurnAuthorityParameters(execution, input)
    const row = await runWithAgentAccess(execution.security.access, () => {
      const settings = rlsGucSettings(input.userId, input.assistantId)
      return pool.query<{ value: unknown }>(`WITH context AS MATERIALIZED (
        SELECT count(set_config(setting.name,setting.value,true)) FROM unnest($14::text[],$15::text[]) AS setting(name,value)
      ) SELECT public.capture_native_page_turn_delivery($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) AS value FROM context`,
      [...parameters, boundary, JSON.stringify(ordinary.map(root)), JSON.stringify(pages.map(root)), settings.map(([name]) => name), settings.map(([, value]) => value)])
    })
    const raw = row.rows[0]?.value
    if (raw === null) return null
    const proof = result.parse(raw)
    const read = ordinary.length ? decodeConversationPreparationCohort(input.workspaceId, ordinary, proof.ordinary) : null
    if (read?.kind === 'refused' || read?.kind === 'memory_history' && !read.available) changed()
    if (ordinary.length && read?.kind !== 'complete') return null
    if (proof.pages.length !== pages.length || proof.pages.some(({ source }, index) =>
      source.version !== pages[index].version || resourceScopeKey(source) !== resourceScopeKey(pages[index]))) changed()
    const current = [...(read?.kind === 'complete' ? read.current : []), ...proof.pages.flatMap(page => page.requiredSources)]
    const proved = new ContextScopeAccumulator(evidence)
    if (read?.kind === 'complete') proved.note(read.evidence)
    proved.note({ sources: proof.pages.flatMap(page => page.requiredSources) })
    const member = execution.security.ceiling
    // Only the exact Page receipts' principal axis was proved by the live
    // anchor. All ordinary immutable/current ancestors retain their own.
    assertScopeEvidenceFitsCeiling(proved.evidence, member, 'caller')
    assertScopeEvidenceFitsCeiling({ sources: current }, member, 'audience')
    assertScopeEvidenceFitsCeiling({ ...proved.evidence, sources: anonymous(proved.evidence.sources ?? []) }, room, 'audience')
    assertScopeEvidenceFitsCeiling({ sources: anonymous(current) }, room, 'audience')
    for (const source of current) proved.note({ sensitivity: source.sensitivity, compartments: source.compartments, projectIds: source.projectIds })
    return { authority: proof.authority, value: proved.evidence }
  })
  return captured?.value ?? null
}

/** Read Page bytes once under the original operation's app-role policy. */
export async function tryReadNativePageTurnAnchor(execution: ExecutionContext, room: AccessCeiling, pageId: string):
  Promise<{ page: DocPageRead; evidence: ScopeEvidence } | null> {
  const pool = await nativePagePool(execution, room)
  if (!pool) return null
  const captured = await captureSessionAuthority(execution.security.authority, async input => {
    if (!input.turn) return null
    const parameters = nativeTurnAuthorityParameters(execution, input)
    const row = await runWithAgentAccess(execution.security.access, () => {
      const settings = rlsGucSettings(input.userId, input.assistantId)
      return pool.query<{ value: unknown }>(`WITH context AS MATERIALIZED (
        SELECT count(set_config(setting.name,setting.value,true)) FROM unnest($12::text[],$13::text[]) AS setting(name,value)
      ) SELECT public.capture_native_page_turn_anchor($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) AS value FROM context`,
      [...parameters, pageId, settings.map(([name]) => name), settings.map(([, value]) => value)])
    })
    const proof = anchorResult.parse(row.rows[0]?.value)
    const sources = [proof.source.source, ...proof.source.requiredSources]
    const evidence = new ContextScopeAccumulator({ sources }).evidence
    assertScopeEvidenceFitsCeiling(evidence, execution.security.ceiling, 'caller')
    assertScopeEvidenceFitsCeiling({ ...evidence, sources: anonymous(sources) }, room, 'audience')
    const page: DocPageRead = { page: proof.page.page ?? { blocks: [] }, version: proof.page.version ?? 1,
      title: proof.page.title ?? 'Untitled', nameOrigin: proof.page.nameOrigin ?? 'placeholder', icon: proof.page.icon }
    return { authority: proof.authority, value: { page, evidence } }
  })
  return captured?.value ?? null
}
