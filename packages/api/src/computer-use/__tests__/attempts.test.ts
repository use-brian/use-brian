import { expect, it, vi } from 'vitest'
import { PGlite } from '@electric-sql/pglite'
import { readFile } from 'node:fs/promises'
vi.mock('../../db/client.js', () => ({ query: vi.fn() }))
import { query } from '../../db/client.js'
import { NativeComputerService, type NativeAttemptRecord } from '../service.js'

it('durably queries metadata-only attempts, enforces trusted binding and FK, retains revoked completions', async () => {
  const db = new PGlite()
  try {
    const id = '00000000-0000-4000-8000-000000000001'
    for (const table of ['users', 'workspaces', 'assistants', 'sessions', 'tasks', 'auth_sessions']) {
      await db.exec(`CREATE TABLE ${table}(id uuid PRIMARY KEY); INSERT INTO ${table} VALUES ('${id}')`)
    }
    await db.exec(await readFile(new URL('../../../migrations/620_native_computer_sessions.sql', import.meta.url), 'utf8'))
    await db.query(`INSERT INTO native_computer_sessions(id,user_id,workspace_id,assistant_id,conversation_id,task_id,device_id,deployment_id,challenge,expires_at,grant_id,revoked_at)
      VALUES ($1,$1,$1,$1,$1,$1,'device','deployment','challenge',now(),'grant',now())`, [id])
    vi.mocked(query).mockImplementation(((sql: string, params: unknown[]) => db.query(sql, params)) as typeof query)
    const service = new NativeComputerService({ relayUrl: 'http://relay', relaySecret: 'secret', jwtSecret: 'secret', deploymentId: 'deployment' })
    const record: NativeAttemptRecord = {
      sessionId: id, grantId: 'grant', scope: { userId: id, workspaceId: id, assistantId: id, conversationId: id, taskId: id },
      attempt: { attemptId: id, invocationState: 'settled', interrupted: false, operation: 'plan', stage: 'direct', perceptionPath: 'ax', fallbackReason: 'none', disposition: null, requestedModel: 'configured-alias', model: 'configured-model', providerKind: 'custom', lane: 'text', outcome: 'failed', durationMs: 42,
        usage: null, incurredCostUsd: null, estimatedBilledCostUsd: null, providerKeySource: 'user' },
    }
    await service.recordAttempt({ ...record, attempt: { ...record.attempt, goal: 'private goal', error: 'raw token', providerUrl: 'https://user:password@host' } } as NativeAttemptRecord)
    await service.recordAttempt({ ...record, attempt: { ...record.attempt, attemptId: '00000000-0000-4000-8000-000000000002', lane: 'vision', perceptionPath: 'vision', operation: 'ground', usage: { inputTokens: 12, outputTokens: 3 }, incurredCostUsd: 0.2, estimatedBilledCostUsd: 0 } })
    const rows = (await db.query('SELECT * FROM native_computer_inference_attempts ORDER BY id')).rows
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ operation: 'plan', stage: 'direct', perception_path: 'ax', fallback_reason: 'none', disposition: null, session_id: id, model: 'configured-model', provider_kind: 'custom', outcome: 'failed', duration_ms: 42, usage: null, incurred_cost_usd: null, billed_cost_usd: null, diagnostic_code: 'inference_failed' })
    expect(rows[1]).toMatchObject({ lane: 'vision', perception_path: 'vision', operation: 'ground', usage: { inputTokens: 12, outputTokens: 3 }, incurred_cost_usd: 0.2, estimated_billed_cost_usd: 0, billed_cost_usd: null, billing_state: 'not_required', provider_key_source: 'user' })
    expect(JSON.stringify(rows)).not.toMatch(/private goal|raw token|password|providerUrl/)
    await expect(service.recordAttempt({ ...record, grantId: 'forged' })).rejects.toThrow('scope denied')
    await expect(service.recordAttempt({ ...record, scope: { ...record.scope, userId: '00000000-0000-4000-8000-000000000002' } })).rejects.toThrow('scope denied')
    await expect(service.recordAttempt({ ...record, attempt: { ...record.attempt, model: 'https://user:password@host' } })).rejects.toThrow()
    await expect(db.query(`UPDATE native_computer_inference_attempts SET fallback_reason='raw exception'`)).rejects.toThrow()
    await expect(db.query(`UPDATE native_computer_inference_attempts SET stage='model supplied'`)).rejects.toThrow()
    await expect(db.query(`UPDATE native_computer_inference_attempts SET session_id='00000000-0000-4000-8000-000000000002'`)).rejects.toThrow()
    await db.query('DELETE FROM native_computer_sessions WHERE id=$1', [id])
    expect((await db.query('SELECT * FROM native_computer_inference_attempts')).rows).toEqual([])
  } finally {
    vi.mocked(query).mockReset()
    await db.close()
  }
}, 30_000)
