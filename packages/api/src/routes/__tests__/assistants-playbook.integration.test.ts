import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { getAppPool, getPool } from '../../db/client.js'
import { loadDecisionPlaybookContext } from '../../decision-learning/playbook-context.js'
import { assistantRoutes } from '../assistants.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
afterAll(async () => { await getAppPool().end(); await pool.end() })

function asMember(userId: string) {
  const app = express().use(express.json())
  app.use((req, _res, next) => {
    req.userId = userId
    next()
  })
  app.use('/api/assistants', assistantRoutes({ capabilityStore: {} as never }))
  return request(app)
}

describe('[COMP:routes/assistant-playbook] [COMP:api/assistant-playbook] existing assistant-wide playbook rules', () => {
  it('lets the owner review and retire one previously auto-added rule while other rules keep applying', async () => {
    const [owner, member, workspace, assistant, retired, retained, authored, suggested] = Array.from({ length: 8 }, () => randomUUID())
    for (const userId of [owner, member]) {
      await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
    }
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Playbook fixture',$2)", [workspace, owner])
    await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance)
      VALUES($1,$2,'owner','internal'),($1,$3,'member','internal')`, [workspace, owner, member])
    await pool.query(`INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,charter)
      VALUES($1,$2,$3,'Example assistant','primary','{"success":"Give clear updates"}')`, [assistant, workspace, owner])
    await pool.query(`INSERT INTO assistant_playbook_rules(id,assistant_id,rule,status,created_by,decided_by_user_id,provenance)
      VALUES($1,$5,'Always include an appendix.','active','reflection',NULL,'{"windowDays":7}'),
            ($2,$5,'Lead with the due date.','active','reflection',NULL,'{"windowDays":7}'),
            ($3,$5,'Name the next owner.','active','owner',$6,'{}'),
            ($4,$5,'List the open questions.','suggested','reflection',NULL,'{"windowDays":7}')`,
    [retired, retained, authored, suggested, assistant, owner])

    const url = `/api/assistants/${assistant}/playbook`
    const readPromptRules = async () => (await loadDecisionPlaybookContext({
      workspaceId: workspace,
      assistantId: assistant,
      actorUserId: member,
      externalPrincipal: false,
      operationKind: 'chat_turn',
      operationId: randomUUID(),
      logLabel: 'playbook-fixture',
    })).playbookRules

    const before = await asMember(owner).get(url).expect(200)
    expect(before.body.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: retired, status: 'active', createdBy: 'reflection', decidedByUserId: null }),
      expect.objectContaining({ id: suggested, status: 'suggested' }),
    ]))
    expect((await readPromptRules()).sort()).toEqual([
      'Always include an appendix.', 'Lead with the due date.', 'Name the next owner.',
    ])

    await asMember(member).post(`${url}/${retired}/decision`).send({ decision: 'retire' }).expect(403)
    await asMember(owner).post(`${url}/${retired}/decision`).send({ decision: 'retire' }).expect(200)
    await asMember(owner).post(`${url}/${suggested}/decision`).send({ decision: 'approve' }).expect(200)

    const after = await asMember(owner).get(url).expect(200)
    expect(after.body.rules).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: retired, status: 'retired', decidedByUserId: owner, provenance: { windowDays: 7 } }),
      expect.objectContaining({ id: retained, status: 'active', decidedByUserId: null }),
      expect.objectContaining({ id: suggested, status: 'active', decidedByUserId: owner }),
    ]))
    expect((await readPromptRules()).sort()).toEqual([
      'Lead with the due date.', 'List the open questions.', 'Name the next owner.',
    ])
    const journal = await pool.query(`SELECT de.payload, dd.relation FROM decision_events de
      JOIN decision_derivations dd ON dd.decision_event_id=de.id
      WHERE de.source_kind='assistant_playbook_rule' AND de.source_id=$1`, [retired])
    expect(journal.rows).toEqual([{ payload: { ruleId: retired, decision: 'retire' }, relation: 'invalidates' }])
  })
})
