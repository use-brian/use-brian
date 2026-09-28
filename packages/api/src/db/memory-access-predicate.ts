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

import type { AccessContext } from '@use-brian/core'
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
  const holding = `${options?.alias ? `${options.alias}.` : ''}scope_held = false`
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
