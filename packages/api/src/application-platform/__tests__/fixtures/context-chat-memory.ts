/** Shared synthetic corpus for the mounted context-aware Chat benchmarks. */
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { createTokens } from '../../../auth/jwt.js'
import { withTableTriggersSuspended } from '../../../__tests__/fixtures/bootstrap-role.js'
import { authSessionStore } from '../../../db/auth-session-store.js'
import { createMemory } from '../../../db/memories.js'
import { createPersonalWebSession } from '../../../db/sessions.js'
import type { persistentContextFixture } from './persistent-context.js'

type Fixture = Awaited<ReturnType<typeof persistentContextFixture>>

export async function openContextChatSession({ ownerId, assistantId, workspaceId }: Fixture, secret: string, actor: string = ownerId) {
  const device = await authSessionStore.create(actor, {
    deviceLabel: 'Fictional budget fixture', userAgent: null, ipAddress: null,
  })
  if (!device) throw new Error('Could not create fixture session')
  const session = await createPersonalWebSession({ assistantId, userId: actor, workspaceId,
    channelType: 'web', channelId: randomUUID(), appOrigin: 'chat' },
    { actorUserId: actor, authSessionId: device.id, authVersion: device.authVersion })
  return { session, deviceId: device.id, token: createTokens(actor, secret, device).accessToken }
}

export async function seedSharedMemoryAncestry(f: Fixture) {
  const facts = ['Fictional primary label is violet.', 'Fictional secondary label is orange.']
  const roots = await Promise.all(facts.map(fact => f.memory(fact, f.ownerId)))
  const ancestor = await f.memory('Fictional retired source Memory', f.ownerId)
  const { rows: files } = await f.pool.query<{ id: string; version: string }>(`
    INSERT INTO workspace_files(workspace_id,path,name,storage_uri,created_by_user_id,source,sensitivity)
    SELECT $1,'/fictional/shared-source-'||n,'Fictional shared source','fixture://shared-source-'||n,$2,'user','internal'
    FROM generate_series(1,8) n RETURNING id,scope_version::text AS version`, [f.workspaceId, f.ownerId])
  const client = await f.pool.connect()
  try {
    await client.query('BEGIN')
    // Model a previously captured Memory graph. Only the two current Memory
    // roots are selected, but their protected source closure overlaps.
    await withTableTriggersSuspended(client, ['memories', 'scope_derivations', 'scope_derivation_sources'], async () => {
      await client.query('UPDATE memories SET valid_to=now() WHERE id=$1', [ancestor.id])
      await client.query(`WITH parents AS (
        INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,
          sensitivity,compartments,project_ids,source_policy_revision)
        SELECT workspace_id,'memory',id,scope_version::text,'fixture:shared-memory-ancestry',user_id,assistant_id,
          sensitivity,compartments,project_ids,1 FROM memories WHERE id=ANY($1::uuid[])
        RETURNING workspace_id,id,resource_id
      ) INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
        SELECT p.workspace_id,p.id,'memory',m.id,m.scope_version::text
        FROM parents p CROSS JOIN memories m WHERE p.resource_id<>$2 AND m.id=$2
        UNION ALL
        SELECT p.workspace_id,p.id,'workspace_file',file.id,file.version
        FROM parents p CROSS JOIN unnest($3::uuid[],$4::text[]) AS file(id,version) WHERE p.resource_id=$2`,
      [[...roots.map(root=>root.id),ancestor.id],ancestor.id,files.map(file=>file.id),files.map(file=>file.version)])
    })
    const { rows } = await client.query<{ current: boolean }>('SELECT public.native_turn_contract_witness_refresh() AS current')
    expect(rows[0].current).toBe(true)
    await client.query('COMMIT')
  } catch (error) {
    await client.query('ROLLBACK')
    throw error
  } finally {
    client.release()
  }
  return { roots, facts, ancestor, sourceFile: files[0] }
}

export async function seedContextChatMemory(f: Fixture, dense: boolean, secret: string, colorFact: string) {
  const { workspaceId, assistantId, ownerId } = f
  const sourceSession = await openContextChatSession(f, secret)
  const linkedIds: string[] = []
  const fact = await f.memory(colorFact, ownerId)
  for (const summary of ['Unlinked fixture fact A', 'Unlinked fixture fact B', 'Unlinked fixture fact C']) {
    await f.memory(summary, ownerId)
  }
  const setup = await f.pool.connect()
  try {
    await setup.query('BEGIN')
    for (let linked = dense ? 0 : 200; linked < 204; linked++) {
      const memory = await createMemory({
        workspaceId, assistantId, userId: ownerId, createdByUserId: ownerId, sourceSessionId: sourceSession.session.id,
        summary: 'Synthetic memory from an unrelated personal conversation ' + linked, sensitivity: 'internal',
      }, undefined, setup)
      linkedIds.push(memory.id)
    }
    await setup.query('COMMIT')
  } catch (error) {
    await setup.query('ROLLBACK')
    throw error
  } finally {
    setup.release()
  }
  if (!dense) return fact.id
  {
    await f.pool.query(`WITH snapshots AS (
      INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,
        sensitivity,compartments,project_ids,source_policy_revision)
      SELECT workspace_id,'memory',id,scope_version::text,'fixture:synthetic-linked-memory',user_id,assistant_id,
        sensitivity,compartments,project_ids,1 FROM memories WHERE id=ANY($1::uuid[])
      RETURNING id,workspace_id,resource_id
    ) INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
      SELECT d.workspace_id,d.id,'memory',m.id,m.scope_version::text
      FROM snapshots d JOIN unnest($2::uuid[],$3::uuid[]) edge(target,source) ON edge.target=d.resource_id
      JOIN memories m ON m.id=edge.source`,
    [ [linkedIds[0], linkedIds[71], linkedIds[95], linkedIds[201]],
      [linkedIds[0], linkedIds[71], linkedIds[95], linkedIds[201], linkedIds[201]],
      [linkedIds[160], linkedIds[161], linkedIds[162], linkedIds[163], linkedIds[164]] ])
  }
  const supersessionStarts = linkedIds.slice(0, 114)
  await f.pool.query('UPDATE memories SET valid_to=now() WHERE id=ANY($1::uuid[])', [linkedIds.slice(0, 200)])
  const heads = (await f.pool.query<{ id: string }>(`SELECT id FROM memories WHERE workspace_id=$1
    AND valid_to IS NULL ORDER BY source_session_id NULLS LAST,id`, [workspaceId])).rows.map(row => row.id)
  expect(heads).toHaveLength(8)
  const connectedEnds = supersessionStarts.map((_, index) => {
    if (index < 30) return linkedIds[index + 1]
    if (index === 30) return heads[0]
    if (index < 71) return linkedIds[71 + index % 43]
    return heads[1 + index % 7]
  })
  await f.pool.query(`UPDATE memories m SET superseded_by=edges.successor
    FROM unnest($1::uuid[],$2::uuid[]) AS edges(predecessor,successor) WHERE m.id=edges.predecessor`,
  [supersessionStarts, connectedEnds])
  const supersessionShape = (await f.pool.query(`SELECT count(*)::int AS items,
    count(source_session_id)::int AS linked, count(superseded_by)::int AS superseded,
    count(*) FILTER (WHERE valid_to IS NULL)::int AS current FROM memories WHERE workspace_id=$1`, [workspaceId])).rows[0]
  expect(supersessionShape).toEqual({ items: 208, linked: 204, superseded: 114, current: 8 })
  {
    const bulk = await f.pool.connect()
    try {
      await bulk.query('BEGIN')
      await bulk.query("SET LOCAL statement_timeout='120s'")
      // Fixture-only unrelated roots shape table density and index pages. The
      // eight live Memory heads and their five reachable edges are genuine.
      await withTableTriggersSuspended(bulk, ['scope_derivations', 'scope_derivation_sources'], async () => {
        await bulk.query(`WITH roots AS (
          INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,
            sensitivity,compartments,project_ids,source_policy_revision)
          SELECT $1,'session_message',md5('fictional-unrelated-target:'||root)::uuid,'1',
            'fixture:unrelated-graph-density',$2,$3,'internal','{}','{}',1
          FROM generate_series(1,1030) root RETURNING workspace_id,id
        ) INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
          SELECT workspace_id,id,'session_message',md5('fictional-unrelated-source:'||edge)::uuid,'1'
          FROM roots CROSS JOIN generate_series(1,64) edge`, [workspaceId, ownerId, assistantId])
      })
      // Re-enabling the same triggers still changes their catalog tuple identities.
      const { rows: [witness] } = await bulk.query<{ current: boolean }>(
        'SELECT public.native_turn_contract_witness_refresh() AS current')
      expect(witness?.current, 'dense fixture catalog witness').toBe(true)
      await bulk.query('COMMIT')
    } catch (error) {
      await bulk.query('ROLLBACK')
      throw error
    } finally {
      bulk.release()
    }
    const density = (await f.pool.query(`SELECT count(*)::int AS edges,count(*) FILTER(WHERE source_kind='memory')::int AS memory_edges
      FROM scope_derivation_sources WHERE workspace_id=$1`, [workspaceId])).rows[0]
    expect(density).toEqual({ edges: 65925, memory_edges: 5 })
  }
  return fact.id
}
