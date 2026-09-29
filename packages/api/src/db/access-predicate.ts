/**
 * Universal access projection (P1-12) — see
 * docs/architecture/platform/sensitivity.md → "Universal access predicate"
 * and "Universal resource projection". (A fifth, non-hierarchical
 * Team compartment and Project context axes are specified in
 * docs/architecture/context-engine/scoped-context.md.)
 *
 * Composes the four projection axes — workspace partition, visibility user,
 * visibility assistant, sensitivity clearance — into a single AND-group
 * suitable for embedding in any store's WHERE clause.
 *
 * WU-4.1 shipped this helper; WU-4.2a applied it to `retrieval-store.ts`;
 * WU-4.2b extended `AccessContext.clearance` to optional and rolled the
 * predicate out across every other `packages/api/src/db/*` read path.
 * The no-clearance branch projects only workspace + visibility-double
 * (system-caller path; see `permissions.md` § Privileged-service exception).
 *
 * Bi-temporal filtering (`valid_to IS NULL`) and retraction filtering are
 * intentionally orthogonal — the caller composes them alongside this
 * predicate when needed.
 *
 * `sensitivity_rank()` (migration 065) is the existing PG ordering helper
 * reused here.
 */

import { intersectScopeGrants,minSensitivity,scopeGrantContains,RANK,type ResourceScope,type AccessContext } from '@use-brian/core'
import { currentAgentAccess } from './agent-access-context.js'

/**
 * `AccessContext` is defined in `@use-brian/core` so it can flow through
 * store interfaces (`MemoryStore`, `EntityStore`, etc.) without the core
 * package taking a dependency on `@use-brian/api`. We re-export it here
 * for ergonomic imports inside the API package.
 */
export type { AccessContext }

export type AccessPredicateOptions = {
  /** Source edits/deletes use the mutation envelope, never a read-only grant. */
  operation?: 'read' | 'mutation'
  /** Column prefix for JOINed queries, e.g. `'m'` → `m.workspace_id`. Default: no prefix. */
  alias?: string
  /** First `$N` placeholder index. Default: 1. */
  startIdx?: number
}

export type AccessPredicate = {
  /** SQL fragment, joinable as a single AND-group. Wrap in parens if combining with OR. */
  sql: string
  /**
   * Params in placeholder order. Length varies with the viewer shape and which
   * optional axes are present:
   *
   * - `kind='primary'` (workspace reflector) drops the `assistant_id` partition,
   *   so `assistantId` is NOT in the list: `[workspaceId, userId]`.
   * - `kind='standard' | 'app'`: `[workspaceId, userId, assistantId]`.
   * - `+ clearance` (a `Sensitivity` string) when `ctx.clearance` is set.
   * - `+ compartments` (a `string[]` for the `<@ $n::text[]` clause) when
   *   `ctx.compartments` is a finite grant (omitted for the universe grant).
   * - `+ projectIds` (a `string[]` for the `<@ $n::uuid[]` clause) when
   *   `ctx.projectIds` is a finite grant (omitted for the universe grant).
   *
   * Callers spread this straight into their values array, so the order — not a
   * precise tuple type — is what matters.
   */
  params: Array<string | string[]>
  /** First `$N` index available *after* this fragment — caller's next param goes here. */
  nextIdx: number
}

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/
/** The nil UUID: never a user id, so a shared-audience viewer owns no rows. */
const NO_USER = '00000000-0000-0000-0000-000000000000'

/** Current member floor for existing sources, including owner-pool compositions. */
export function buildCurrentMemberSourcePredicate(
  userId: string,
  options: { alias: string; startIdx?: number; operation?: 'read' | 'mutation' },
): AccessPredicate {
  if (!userId || !IDENTIFIER_RE.test(options.alias)) throw new Error('Invalid current-member source context')
  const i = options.startIdx ?? 1
  if (!Number.isSafeInteger(i) || i < 1) throw new Error('Invalid current-member parameter index')
  const p = options.alias
  const teamFunction = options.operation === 'read' ? 'effective_member_read_compartments' : 'effective_member_team_compartments'
  return {
    sql: `(${p}.user_id IS NULL OR ${p}.user_id=$${i})
      AND EXISTS(SELECT 1 FROM workspace_members member_floor
        WHERE member_floor.workspace_id=${p}.workspace_id AND member_floor.user_id=$${i}
          AND sensitivity_rank(${p}.sensitivity)<=sensitivity_rank(member_floor.clearance))
      AND (${teamFunction}($${i},${p}.workspace_id) IS NULL
        OR ${p}.compartments <@ ${teamFunction}($${i},${p}.workspace_id))`,
    params: [userId], nextIdx: i + 1,
  }
}

/**
 * Pin a user mutation to its authenticated actor. The default human projection
 * must run on the app-role transaction, where current membership still applies.
 * Spec: corrections.md -> Canonical Brain mutation authority.
 */
export function mutationActorAccess(userId: string, workspaceId: string, access?: AccessContext): AccessContext {
  const agent = currentAgentAccess()
  if (!userId || !workspaceId
    || (agent && (agent.userId !== userId || agent.workspaceId !== workspaceId))
    || (access && (access.userId !== userId || access.workspaceId !== workspaceId))) {
    throw Object.assign(new Error('The operation requires the executing author.'), { code: 'scope_operation_denied' })
  }
  return access ?? { userId, workspaceId, assistantId: '', assistantKind: 'primary' }
}

/**
 * Build the universal access projection (P1-12) as an SQL fragment + ordered
 * params + the next-available placeholder index.
 *
 * The fragment is a single AND-group (no leading `AND`, no trailing
 * whitespace), so a caller can embed it as the first condition after `WHERE`
 * or join it with further conditions via `AND`.
 *
 *     const ap = buildAccessPredicate(ctx, { alias: 'm', startIdx: 1 })
 *     const sql = `SELECT ... FROM memories m
 *                  WHERE ${ap.sql}
 *                    AND m.valid_to IS NULL`
 *     const values = [...ap.params, ...]  // next param uses ap.nextIdx
 */
export function buildAccessPredicate(
  ctx: AccessContext,
  options?: AccessPredicateOptions,
): AccessPredicate {
  const agent=currentAgentAccess()
  const intersect=(a:string[]|null|undefined,b:string[]|null|undefined)=>
    b===undefined?a:intersectScopeGrants(a??null,b)
  ctx={...ctx,
    clearance:agent?.clearance?minSensitivity(ctx.clearance??'confidential',agent.clearance):ctx.clearance,
    compartments:resolveOperationCompartments(ctx,options?.operation??'read'),
    projectIds:intersect(ctx.projectIds,agent?.projectIds),
    visibilityAssistantIds:intersect(ctx.visibilityAssistantIds,agent?.visibilityAssistantIds),
  }
  const startIdx = options?.startIdx ?? 1
  const alias = options?.alias
  if (alias !== undefined && !IDENTIFIER_RE.test(alias)) {
    throw new Error(
      `buildAccessPredicate: invalid alias ${JSON.stringify(alias)} — must match /^[A-Za-z_][A-Za-z0-9_]*$/`,
    )
  }
  const p = alias ? `${alias}.` : ''
  const i = startIdx
  // Transitional NULL tolerance on workspace_id: WU-4.1 spec wants
  // `workspace_id = $W` (strict), but the current schema still allows
  // `workspace_id IS NULL` on personal-scope rows (see migration 110's
  // `workspace_scope_consistency` CHECK). Until a follow-up migration
  // backfills + enforces NOT NULL, NULL acts like "global" and is
  // gated by the visibility-double instead. Strict-match becomes
  // safe once the schema is tightened — drop the IS NULL branch then.
  //
  // Primary widen: `kind='primary'` is the workspace reflector — the
  // assistant_id partition is dropped so the primary sees every
  // assistant's rows in its workspace. The `user_id` partition still
  // applies (user-specific rows stay scoped to the viewing user), and
  // the clearance ceiling still applies (downcleared primary stays
  // bounded). See `docs/architecture/platform/sensitivity.md`
  // → "Primary widens".
  const isPrimary = ctx.assistantKind === 'primary'
  const visibilityClauses = isPrimary
    ? `(${p}workspace_id IS NULL OR ${p}workspace_id = $${i})` +
      ` AND (${p}user_id IS NULL OR ${p}user_id = $${i + 1})`
    : `(${p}workspace_id IS NULL OR ${p}workspace_id = $${i})` +
      ` AND (${p}user_id IS NULL OR ${p}user_id = $${i + 1})` +
      ` AND (${p}assistant_id IS NULL OR ${p}assistant_id = $${i + 2})`
  const baseNextIdx = isPrimary ? i + 2 : i + 3

  // Build the optional trailing axes incrementally. Each is omitted when its
  // `ctx` field is absent, so the fragment stays byte-identical to the
  // visibility-only / +clearance forms for every existing caller.
  let sql = visibilityClauses
  // A shared audience (room, doc thread, Feed draft, team group) reads only
  // rows with no user owner (decision D4). The nil UUID is never a user, so
  // `user_id = $viewer` matches nothing and the fragment keeps its shape.
  const viewerUserId = ctx.sharedAudience || agent?.sharedAudience ? NO_USER : ctx.userId
  const params: Array<string | string[]> = isPrimary
    ? [ctx.workspaceId, viewerUserId]
    : [ctx.workspaceId, viewerUserId, ctx.assistantId]
  let nextIdx = baseNextIdx

  // Sensitivity ladder (optional — system callers omit it; see header).
  if (ctx.clearance !== undefined) {
    sql += ` AND sensitivity_rank(${p}sensitivity) <= sensitivity_rank($${nextIdx})`
    params.push(ctx.clearance)
    nextIdx += 1
  }

  // Compartment axis (optional — null/undefined = universe grant ⇒ clause
  // dropped). Superset rule: a row is visible iff its compartment set is a
  // subset of the viewer's effective grant (`row.compartments <@ $grant`). An
  // empty grant (`[]`) matches only uncompartmented (`'{}'`) rows. See
  // docs/plans/compartment-axis.md.
  if (ctx.compartments !== undefined && ctx.compartments !== null) {
    sql += ` AND ${p}compartments <@ $${nextIdx}::text[]`
    params.push(ctx.compartments)
    nextIdx += 1
  }

  // Project axis (optional: null/undefined = universe grant). Project is a
  // discovery boundary, not an ACL, but uses the same all-of subset rule.
  if (ctx.projectIds !== undefined && ctx.projectIds !== null) {
    sql += ` AND ${p}project_ids <@ $${nextIdx}::uuid[]`
    params.push(ctx.projectIds)
    nextIdx += 1
  }

  const visibility=buildExecutionVisibilityPredicate(ctx,{alias,startIdx:nextIdx})
  if(visibility.sql!=='TRUE')sql+=` AND ${visibility.sql}`
  params.push(...visibility.params);nextIdx=visibility.nextIdx

  return { sql, params, nextIdx }
}

/** Also fences special read branches that intentionally have different content rules. */
export function buildExecutionVisibilityPredicate(ctx:AccessContext,options?:AccessPredicateOptions):AccessPredicate {
  const alias=options?.alias
  if(alias!==undefined&&!IDENTIFIER_RE.test(alias))throw new Error('Invalid access alias')
  const p=alias?`${alias}.`:''
  const agent=currentAgentAccess()
  const ids=ctx.visibilityAssistantIds===undefined&&agent?.visibilityAssistantIds===undefined
    ?undefined:intersectScopeGrants(ctx.visibilityAssistantIds??null,agent?.visibilityAssistantIds??null)
  let sql='TRUE',nextIdx=options?.startIdx??1
  const params:Array<string|string[]>=[]
  if(agent?.workspaceId!==undefined&&agent.workspaceId!==ctx.workspaceId)sql='FALSE'
  if(agent?.userId!==undefined&&agent.userId!==ctx.userId){
    sql+=` AND (${p}user_id IS NULL OR ${p}user_id = $${nextIdx})`
    params.push(agent.userId);nextIdx+=1
  }
  if(ids!==undefined&&ids!==null){
    sql+=` AND (${p}assistant_id IS NULL OR ${p}assistant_id = ANY($${nextIdx}::uuid[]))`
    params.push(ids);nextIdx+=1
  }
  return {sql,params,nextIdx}
}

/** Shared by SQL predicates and canonical writers checking a candidate envelope. */
export function resolveOperationCompartments(ctx:Pick<AccessContext,'compartments'|'mutationCompartments'>={},operation:'read'|'mutation'='read'):string[]|null|undefined {
  const agent=currentAgentAccess();
  const grants=operation==='read'?[ctx.compartments,agent?.compartments]:[ctx.compartments,ctx.mutationCompartments,agent?.compartments,agent?.mutationCompartments];
  return grants.every(grant=>grant===undefined)?undefined:intersectScopeGrants(...grants.map(grant=>grant??null));
}

/** No resource names or labels in errors. System callers retain their explicit service path. */
export function assertExecutionResourceScope(resource:ResourceScope & {scopeHeld?:boolean},operation:'read'|'mutation',ctx?:AccessContext):void {
  const agent=currentAgentAccess();
  const fail=()=>{throw Object.assign(new Error('The operation is outside the current access scope.'),{code:'scope_operation_denied'})};
  if((ctx||agent)&&resource.scopeHeld)fail();
  if(!scopeGrantContains(resolveOperationCompartments(ctx,operation),resource.compartments))fail();
  for(const ceiling of [ctx,agent]){
    if(!ceiling)continue;
    if(ceiling.workspaceId!==undefined&&resource.workspaceId!==ceiling.workspaceId)fail();
    if(ceiling.userId!==undefined&&resource.userId!==null&&resource.userId!==ceiling.userId)fail();
    // A source must be readable. A destination may be classified more
    // strictly under the primitive's existing authoring-clearance policy.
    if(operation==='read'&&ceiling.clearance!==undefined&&RANK[resource.sensitivity]>RANK[ceiling.clearance])fail();
    if(!scopeGrantContains(ceiling.projectIds,resource.projectIds))fail();
    if(resource.assistantId!==null&&!scopeGrantContains(ceiling.visibilityAssistantIds,[resource.assistantId]))fail();
  }
  if(ctx&&ctx.assistantKind!=='primary'&&resource.assistantId!==null&&resource.assistantId!==ctx.assistantId)fail();
}
