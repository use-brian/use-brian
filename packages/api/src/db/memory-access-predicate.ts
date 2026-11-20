/**
 * Memory-only access projection for authenticated external-client self memory.
 *
 * The universal predicate remains the ordinary branch. When the trusted
 * public-turn path supplies `ctx.clientSelfMemory`, a second, narrower branch
 * admits only an internal-or-lower memory that is exact on workspace, user,
 * assistant, and the one machine-minted client compartment.
 *
 * Component tag: [COMP:brain/client-self-memory].
 */

import type { AccessContext } from '@use-brian/agent-runtime/security/access-context.js'
import {
  buildAccessPredicate,
  buildExecutionVisibilityPredicate,
  type AccessPredicate,
  type AccessPredicateOptions,
} from './access-predicate.js'

const IDENTIFIER_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

export function buildMemoryAccessPredicate(
  ctx: AccessContext,
  options?: AccessPredicateOptions,
): AccessPredicate {
  const ordinary = buildAccessPredicate(ctx, options)
  const prefix = options?.alias ? `${options.alias}.` : ''
  // A system/share projection has no current proof for protected ancestors. Native
  // viewers run on the app role and use the same reader floor as raw SQL.
  const fieldAuthority = ctx.systemRead
    ? `public.application_memory_unproven_ancestry_allows(${prefix}workspace_id,${prefix}id,${prefix}scope_version::text)`
    : `public.application_memory_field_ancestry_allows(${prefix}workspace_id,${prefix}id,${prefix}scope_version::text)`
  let semantic = ''
  if (options?.operation !== 'mutation' && ctx.memoryReview !== true) {
    const context = ctx.memoryContext ? `$${ordinary.nextIdx}::jsonb` : "'{}'::jsonb"
    if (ctx.memoryContext) { ordinary.params.push(JSON.stringify(ctx.memoryContext)); ordinary.nextIdx++ }
    const exception = buildMemoryAccessPredicate({...ctx,memoryReview:true},{...options,alias:'learning_exception',startIdx:ordinary.nextIdx})
    ordinary.params.push(...exception.params); ordinary.nextIdx=exception.nextIdx
    const exceptionTo = "learning_exception.learning#>>'{applicability,exceptionTo}'"
    // UUID output is lowercase and hyphenated. Older noncanonical strings
    // cannot match that output, and malformed strings must never reach a cast.
    const exceptionTarget = `CASE WHEN ${exceptionTo} ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
      THEN (${exceptionTo})::uuid END`
    semantic = ` AND public.memory_learning_allows(${prefix}learning,${context})
      AND ${prefix}id NOT IN (
        WITH eligible_exceptions AS MATERIALIZED (
          SELECT ${exceptionTarget} AS target_id, user_id, assistant_id, created_by_user_id,
            (learning->'applicability')-'exceptionTo' AS applicability
          FROM memories learning_exception
          WHERE ${exceptionTo} IS NOT NULL
            AND learning_exception.learning->>'origin'='explicit' AND learning_exception.learning->>'confirmed'='true'
            AND learning_exception.valid_to IS NULL AND learning_exception.retracted_at IS NULL AND NOT learning_exception.scope_held
            AND public.memory_learning_allows(learning_exception.learning,${context}) AND ${exception.sql}
            AND public.application_memory_field_ancestry_allows(learning_exception.workspace_id,learning_exception.id,learning_exception.scope_version::text)
        )
        SELECT eligible.target_id FROM eligible_exceptions eligible
        JOIN LATERAL (
          SELECT 1 FROM memories learning_broad
          WHERE learning_broad.id=eligible.target_id
            AND learning_broad.created_by_user_id=eligible.created_by_user_id
            AND learning_broad.user_id IS NOT DISTINCT FROM eligible.user_id
            AND learning_broad.assistant_id IS NOT DISTINCT FROM eligible.assistant_id
            AND (coalesce(learning_broad.learning->'applicability','{}')-'exceptionTo') <@ eligible.applicability
            AND (coalesce(learning_broad.learning->'applicability','{}')-'exceptionTo') <> eligible.applicability
          LIMIT 1
        ) matching_target ON true
      )`
  }
  const holding = `${prefix}scope_held = false AND ${fieldAuthority}${semantic}`
  const self = ctx.clientSelfMemory
  if (!self) return { ...ordinary, sql: `(${ordinary.sql}) AND ${holding}` }
  if (!self.compartment.startsWith('client:')) {
    throw new Error('buildMemoryAccessPredicate: client self compartment must use the client: namespace')
  }

  const alias = options?.alias
  if (alias !== undefined && !IDENTIFIER_RE.test(alias)) {
    throw new Error('buildMemoryAccessPredicate: invalid alias')
  }
  const p = alias ? `${alias}.` : ''
  const i = ordinary.nextIdx
  const selfSql =
    `${p}workspace_id = $${i}` +
    ` AND ${p}user_id = $${i + 1}` +
    ` AND ${p}assistant_id = $${i + 2}` +
    ` AND sensitivity_rank(${p}sensitivity) <= sensitivity_rank($${i + 3})` +
    ` AND ${p}compartments = ARRAY[$${i + 4}]::text[]`

  const visibility=buildExecutionVisibilityPredicate(ctx,{...options,startIdx:i+5})
  return {
    sql: `((${ordinary.sql}) OR (${selfSql}${visibility.sql==='TRUE'?'':` AND ${visibility.sql}`})) AND ${holding}`,
    params: [
      ...ordinary.params,
      ctx.workspaceId,
      ctx.userId,
      ctx.assistantId,
      'internal',
      self.compartment,
      ...visibility.params,
    ],
    nextIdx: visibility.nextIdx,
  }
}
