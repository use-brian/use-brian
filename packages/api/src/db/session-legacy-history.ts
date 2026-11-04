/** Recorded-owner display; never a model transcript or scope source. [COMP:api/session-legacy-history] */
import { z } from 'zod'
import { applyRLSGucs, getAppPool } from './client.js'
import type { AuthTokenClaims } from './auth-session-store.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

const page = z.object({
  sessionId: z.string().uuid(), workspaceId: z.string().uuid(), mode: z.literal('private_legacy_history'),
  rows: z.array(z.object({ id: z.string().uuid(), sequence: z.number().int(), role: z.enum(['user', 'assistant']),
    timestamp: z.string(), available: z.boolean(), content: z.unknown() })),
  nextSequence: z.number().int().nullable(),
})

/** Drop internal blocks and attachment bodies. A tool-bearing assistant turn is not a final reply. */
export function privateHistoryText(content: unknown, role: 'user' | 'assistant'): string | null {
  let text: string
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    if (role === 'assistant' && content.some(block => block?.type === 'tool_use')) return null
    text = content.flatMap(block => block?.type === 'text' && typeof block.text === 'string' ? [block.text] : []).join('\n')
  } else return null
  // An unfinished wrapper must not reveal an embedded file body either.
  text = text.replace(/<attached_file\b[^>]*>[\s\S]*?(?:<\/attached_file>|$)/gi, '').trim()
  return text || null
}

export async function readPrivateLegacyHistory(input: {
  claims: Readonly<AuthTokenClaims>; workspaceId: string; sessionId: string; afterSequence: number; limit: number;
}) {
  const { claims } = input
  if (!claims.sessionId || claims.authVersion === undefined) throw new WorkspaceAccessError('authenticated_session_required', 401)
  const client = await getAppPool().connect()
  try {
    await client.query('BEGIN')
    await applyRLSGucs(client, claims.userId)
    const result = await client.query<{ value: unknown }>(
      'SELECT read_private_legacy_history($1,$2,$3,$4,$5,$6) AS value',
      [input.workspaceId, input.sessionId, claims.sessionId, claims.authVersion, input.afterSequence, input.limit])
    const captured = page.parse(result.rows[0]?.value)
    if (captured.sessionId !== input.sessionId || captured.workspaceId !== input.workspaceId) throw new Error('legacy_history_identity_mismatch')
    const rows = captured.rows.map(({ content, available, ...row }) => {
      const text = available ? privateHistoryText(content, row.role) : null
      return { ...row, text, available: text !== null }
    })
    await client.query('COMMIT')
    return { ...captured, rows }
  } catch (error) {
    await client.query('ROLLBACK')
    if ((error as { code?: string }).code === '42501') throw new WorkspaceAccessError('legacy_history_unavailable', 404)
    throw error
  } finally { client.release() }
}
