/** Genuine pre-8269 history is seeded by conversation-publication-upgrade's before phase.
 * Execute on its upgraded disposable clone after the authenticated successor is installed.
 * This suite never installs SQL or adapts a permission decision. [COMP:api/native-turn-frame]
 */
import { createHash } from 'node:crypto'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import { captureCrmErasure } from '../../crm-operations/erasure-journal.js'
import { getAppPool, getPool } from '../../db/client.js'
import { readAdmittedSessionQuery, publishNativeSessionMessageBatch } from '../../db/conversation-store.js'
import { resolveSessionTitleAuthority } from '../../routes/session-title-authority.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
const statePath = process.env.BRIAN_CONVERSATION_CONVERSION_STATE
type Saved = { workspaceId: string; users: string[]; claims: { userId: string; sessionId: string; authVersion: number }; sessionId: string; assistantId: string; private: boolean; firstReply: string }
const compiler = createHash('sha256').update(await readFile(new URL('../../../scripts/conversation-store/conversion.sql', import.meta.url))).digest('hex')
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([key, child]) => JSON.stringify(key) + ':' + canonical(child)).join(',') + '}'
  const encoded = JSON.stringify(value)
  if (encoded === undefined) throw new Error('Non-JSON source value')
  return encoded
}
function cohort(value: object) { return boundScopeSources(value).map(canonical).sort() }
afterAll(async () => { await getAppPool().end(); await getPool().end() })

describe.skipIf(!statePath).sequential('[COMP:api/native-turn-frame] original historical conversion boundary', () => {
  it('keeps genuine shared V1/private originals and their admitted history usable after resumed conversion', async () => {
    await assertLocalFixture()
    const pool = getPool()
    const role = (await pool.query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
    expect((await pool.query("SELECT to_regprocedure('native_conversation_conversion_page(uuid,integer,integer)') AS installed")).rows[0].installed).not.toBeNull()
    const saved = JSON.parse(await readFile(statePath!, 'utf8')) as Saved[]
    expect(saved.map(row => row.private).sort()).toEqual([false, true])
    for (const row of saved) {
      const before = (await pool.query(`SELECT f.id,f.format,r.payload_sha256,c.content
        FROM native_turn_frames f JOIN session_context_scope_revisions r ON r.workspace_id=f.workspace_id AND r.id=f.id
        JOIN session_context_revision_contents c ON c.workspace_id=f.workspace_id AND c.revision_id=f.id
        WHERE f.workspace_id=$1 ORDER BY f.id`, [row.workspaceId])).rows
      if (!row.private) {
        expect(before.length).toBeGreaterThan(0)
        expect(before.some(frame => frame.format === 1)).toBe(true)
      }
      // Genuine older private dialogue predates native frames; it remains its
      // own transcript source rather than acquiring invented historical facts.
      const authority = await resolveSessionTitleAuthority({ claims: row.claims, sessionId: row.sessionId, readOnly: false })
      const throughSequence = Number((await pool.query('SELECT coalesce(max(sequence_num),0) high FROM session_messages WHERE session_id=$1', [row.sessionId])).rows[0].high)
      const history = await readAdmittedSessionQuery({ sessionId: row.sessionId, throughSequence, authority })
      const start = async () => (await pool.query('SELECT native_conversation_conversion_start($1,$2) id', [row.workspaceId, compiler])).rows[0].id as string
      await expect(pool.query("SELECT native_conversation_conversion_start($1,repeat('b',64))", [row.workspaceId])).rejects.toThrow('conversion_invalid_compiler_digest')
      const run = await start()
      // Separate committed calls model process death after receipt, before next request.
      await pool.query('SELECT native_conversation_conversion_page($1,1,16777216)', [run])
      expect(await start()).toBe(run)
      let reachedBarrier = false
      for (let page = 0; page < 200; page++) {
        const value = (await pool.query('SELECT native_conversation_conversion_page($1,2,16777216) value', [run])).rows[0].value
        if (value.state === 'await_barrier') { reachedBarrier = true; break }
      }
      expect(reachedBarrier).toBe(true)
      expect((await pool.query('SELECT native_conversation_conversion_reconcile($1) value', [run])).rows[0].value.state).toBe('reconciled')
      expect((await pool.query(`SELECT f.id,f.format,r.payload_sha256,c.content
        FROM native_turn_frames f JOIN session_context_scope_revisions r ON r.workspace_id=f.workspace_id AND r.id=f.id
        JOIN session_context_revision_contents c ON c.workspace_id=f.workspace_id AND c.revision_id=f.id
        WHERE f.workspace_id=$1 ORDER BY f.id`, [row.workspaceId])).rows).toEqual(before)
      for (const frame of before) {
        const pair = (await pool.query('SELECT native_turn_frame_pair($1,$2) original,native_conversation_compiled_frame_pair($1,$2) compiled', [row.workspaceId, frame.id])).rows[0]
        expect(pair.original).toBe(true)
        expect(pair.compiled).toBe(pair.original)
      }
      const after = await readAdmittedSessionQuery({ sessionId: row.sessionId, throughSequence, authority })
      expect(after.history).toEqual(history.history)
      expect(after.annotations).toEqual(history.annotations)
      expect(after.assemble(authority)).toEqual(history.assemble(authority))
      expect(after.privateTranscript(authority)).toEqual(history.privateTranscript(authority))
      const current = await after.current(authority)
      expect(current.history).toEqual(after.history)
      expect(current.annotations).toEqual(after.annotations)
      expect(cohort(current)).toEqual(cohort(after))
      expect(cohort(after)).toEqual(cohort(history))
      for (let index = 0; index < history.history.length; index++) expect(cohort(after.history[index]!)).toEqual(cohort(history.history[index]!))
      for (let index = 0; index < history.annotations.length; index++) expect(cohort(after.annotations[index]!)).toEqual(cohort(history.annotations[index]!))
      const client = await pool.connect()
      try {
        await client.query('BEGIN')
        if (before.length) {
          await client.query('UPDATE session_context_scope_revisions SET scope_held=true WHERE id=$1', [before[0].id])
          expect((await client.query('SELECT native_turn_frame_pair($1,$2) original,native_conversation_compiled_frame_pair($1,$2) compiled', [row.workspaceId, before[0].id])).rows[0]).toEqual({ original: false, compiled: false })
        }
      } finally { await client.query('ROLLBACK'); client.release() }
      const replies = await publishNativeSessionMessageBatch({ sessionId: row.sessionId, authority,
        derivationTarget: { workspaceId: row.workspaceId, userId: row.private ? row.claims.userId : null,
          assistantId: null, sensitivity: 'internal', compartments: [], projectIds: [] },
        derivation: { producer: 'fixture:historical-conversion', sources: boundScopeSources(after) },
        messages: [{ role: 'assistant', senderAssistantId: row.assistantId, content: [{ type: 'text', text: 'The fictional notebook remains amber.' }] }],
      })
      expect(replies).toHaveLength(1)
      const received = await readAdmittedSessionQuery({ sessionId: row.sessionId, throughSequence: replies[0]!.sequenceNum, authority })
      expect(received.history.some(message => message.id === replies[0]!.id)).toBe(true)
      const fresh = (await pool.query('SELECT id,format FROM native_turn_frames WHERE workspace_id=$1 AND NOT(id=ANY($2::uuid[]))', [row.workspaceId, before.map(frame => frame.id)])).rows
      expect(fresh).toHaveLength(1)
      expect(fresh[0].format).toBe(2)
      reachedBarrier = false
      for (let page = 0; page < 200; page++) {
        const value = (await pool.query('SELECT native_conversation_conversion_page($1,2,16777216) value', [run])).rows[0].value
        if (value.state === 'await_barrier') { reachedBarrier = true; break }
      }
      expect(reachedBarrier).toBe(true)
      expect((await pool.query('SELECT native_conversation_conversion_reconcile($1) value', [run])).rows[0].value.state).toBe('reconciled')
      expect((await pool.query('SELECT native_conversation_compiled_frame_pair($1,$2) value', [row.workspaceId, fresh[0].id])).rows[0].value).toBe(true)
      const erasure = await pool.connect()
      try {
        const beforeSequence = (await erasure.query('SELECT coalesce(max(sequence),0)::text high FROM crm_erasure_journal')).rows[0].high
        await erasure.query('BEGIN')
        await captureCrmErasure(erasure)
        expect((await erasure.query("SELECT current_setting('session_replication_role') mode")).rows[0].mode).toBe('origin')
        await erasure.query('DELETE FROM workspaces WHERE id=$1', [row.workspaceId])
        await erasure.query('COMMIT')
        const effects = (await erasure.query("SELECT table_name,operation,row_key,effect FROM crm_erasure_journal WHERE sequence>$1 AND table_name LIKE 'native_conversation_%' ORDER BY sequence", [beforeSequence])).rows
        expect(effects.map(effect => effect.table_name)).toEqual(expect.arrayContaining(['native_conversation_frame_requirements', 'native_conversation_conversion_runs', 'native_conversation_conversion_inputs', 'native_conversation_conversion_pages']))
        expect(effects.every(effect => effect.operation === 'delete' && effect.effect === null)).toBe(true)
        expect((await erasure.query('SELECT native_turn_helpers_current() source,native_conversation_conversion_contract() conversion')).rows[0]).toEqual({ source: true, conversion: true })
      } catch (error) { await erasure.query('ROLLBACK'); throw error } finally { erasure.release() }
      expect((await pool.query('SELECT count(*)::int count FROM native_conversation_frame_requirements WHERE workspace_id=$1', [row.workspaceId])).rows[0].count).toBe(0)
      expect((await pool.query('SELECT native_conversation_conversion_page($1,1,16777216) value', [run])).rows[0].value).toEqual({ state: 'absent' })
      await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [row.users])
    }
  }, 120_000)
})
