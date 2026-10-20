import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { boundScopeSources, type ScopeSource } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { addSessionMessage, getSessionMessages, toStampedMessages } from '../../db/sessions.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] actual transcript persistence and replay', () => {
  let fixture: Awaited<ReturnType<typeof persistentContextFixture>> | undefined
  afterEach(async () => { await fixture?.cleanup(); fixture = undefined })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  it('preserves shared nullable axes across persisted message reads and formatting', async () => {
    fixture = await persistentContextFixture()
    const rows = await fixture.history()
    expect(rows).toHaveLength(3)
    for (const [index, message] of toStampedMessages(rows, 'UTC').entries()) {
      expect(boundScopeSources(message)).toEqual(boundScopeSources(rows[index]))
      expect(boundScopeSources(message)).toMatchObject([{
        workspaceId: fixture.workspaceId, userId: null, assistantId: null,
        resourceKind: 'session_message', resourceId: rows[index].id, sensitivity: 'internal',
      }])
    }
  })

  it('keeps every source edge through tool-result JSON flush and transitive replay holding', async () => {
    fixture = await persistentContextFixture('confidential')
    const f = fixture, first = await f.memory('Fictional first source'), second = await f.memory('Fictional second source', null, 'confidential')
    const sources = (await f.pool.query<{ source: ScopeSource }>(
      "SELECT read_scope_source($1,'memory',roots.id) AS source FROM unnest($2::uuid[]) AS roots(id)", [f.workspaceId, [first.id, second.id]],
    )).rows.map(row => row.source)
    const tool = await addSessionMessage({ sessionId: f.session.id, role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'fixture-read', name: 'getMemory', content: 'Fictional mixed-source result' }],
      derivation: { producer: 'fixture:tool-flush', sources } })
    const answer = await addSessionMessage({ sessionId: f.session.id, role: 'assistant', content: 'Fictional derived answer',
      derivation: { producer: 'fixture:answer-flush', sources: boundScopeSources(tool) } })
    const edges = async () => (await f.pool.query(`SELECT d.resource_id,s.source_kind,s.source_id,s.source_version
      FROM scope_derivations d JOIN scope_derivation_sources s ON s.derivation_id=d.id AND s.workspace_id=d.workspace_id
      WHERE d.workspace_id=$1 AND d.resource_id=ANY($2::uuid[]) ORDER BY d.resource_id,s.source_id`,
    [f.workspaceId, [tool.id, answer.id]])).rows
    const before = await edges()
    expect(before.filter(row => row.resource_id === tool.id).map(row => row.source_id).sort()).toEqual([first.id, second.id].sort())
    expect(before.filter(row => row.resource_id === answer.id).map(row => row.source_id)).toEqual([tool.id])
    const replay = await getSessionMessages(f.session.id, { excludeHeld: true })
    expect(replay).toHaveLength(2)
    expect(replay.flatMap(boundScopeSources).every(source => source.sensitivity === 'confidential')).toBe(true)
    await f.pool.query("UPDATE memories SET summary='Fictional source changed' WHERE id=$1", [second.id])
    expect(await getSessionMessages(f.session.id, { excludeHeld: true })).toEqual([])
    expect(await edges()).toEqual(before)
  })
})
