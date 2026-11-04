/** Native human transcript display, never model/source evidence. [COMP:api/session-display-history] */
import { z } from 'zod'
import { DerivedScopeError } from '@use-brian/core'
import { applyRLSGucs, getAppPool, runWithAgentAccess } from './client.js'
import type { AuthTokenClaims } from './auth-session-store.js'
import { privateHistoryText } from './session-legacy-history.js'
import { resolveSessionTitleAuthority } from '../routes/session-title-authority.js'
import { isAuthorityChangedError } from '../context-scope/authority-lease.js'
import { WorkspaceAccessError } from '../workspace-access/policy.js'

const page = z.object({
  sessionId: z.string().uuid(), workspaceId: z.string().uuid(), mode: z.literal('personal_transcript_display'),
  rows: z.array(z.object({ id: z.string().uuid(), sequence: z.number().int().positive(),
    role: z.enum(['user', 'assistant']), timestamp: z.string(), available: z.boolean(), content: z.unknown() })),
  nextSequence: z.number().int().nullable(),
})

export async function readPrivateSessionDisplay(input: {
  claims: Readonly<AuthTokenClaims>; workspaceId: string; sessionId: string; afterSequence: number; limit: number;
}) {
  const command = structuredClone(input)
  if (!command.claims.sessionId || command.claims.authVersion === undefined) {
    throw new WorkspaceAccessError('authenticated_session_required', 401)
  }
  try {
    const authority = await resolveSessionTitleAuthority({ claims: command.claims, sessionId: command.sessionId, readOnly: true })
    const { execution } = authority
    if (execution.security.access.workspaceId !== command.workspaceId) {
      throw new WorkspaceAccessError('display_history_unavailable', 404)
    }
    const result = await runWithAgentAccess(execution.security.access, async () => {
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await applyRLSGucs(client, command.claims.userId)
        await client.query("SELECT set_config('app.v2_assistant_id',$1,true)", [execution.assistant.id])
        const captured = await client.query<{ value: unknown }>(
          'SELECT read_private_session_display($1,$2,$3,$4,$5,$6) AS value',
          [command.workspaceId, command.sessionId, command.claims.sessionId, command.claims.authVersion,
            command.afterSequence, command.limit])
        const parsed = page.parse(captured.rows[0]?.value)
        if (parsed.sessionId !== command.sessionId || parsed.workspaceId !== command.workspaceId) {
          throw new Error('display_history_identity_mismatch')
        }
        const rows = parsed.rows.map(({ content, available, ...row }) => {
          const text = available ? privateHistoryText(content, row.role) : null
          return { ...row, available: text !== null, text }
        })
        // SQL brackets its source read with native authority checks. This
        // original host lease also fences changes during the awaited read.
        await execution.security.authority.assertCurrent()
        await client.query('COMMIT')
        return { ...parsed, rows }
      } catch (error) {
        await client.query('ROLLBACK')
        throw error
      } finally { client.release() }
    })
    // COMMIT is the display-read linearization point: SQL source and policy
    // locks cover the captured text through the final host lease check above.
    return result
  } catch (error) {
    if ((error as { code?: string }).code === '42501' || error instanceof DerivedScopeError || isAuthorityChangedError(error)) {
      throw new WorkspaceAccessError('display_history_unavailable', 404)
    }
    throw error
  }
}
