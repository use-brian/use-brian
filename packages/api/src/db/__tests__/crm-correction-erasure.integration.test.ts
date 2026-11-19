import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { hardPurge } from '@use-brian/core/corrections/soft-delete.js'
import { getPool } from '../client.js'
import { createSoftDeleteStore } from '../soft-delete-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), repo = createSoftDeleteStore()
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), contactId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Erasure fixture',$2)`, [workspaceId,userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId,userId])
  await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source)
    VALUES($1,$2,'person','Fictional person','person@example.com',$3,'manual')`, [contactId,workspaceId,userId])
  const erase = () => hardPurge({ primitive: 'contact',workspaceId,rowId: contactId,actorUserId: userId,
    reason: 'Request from person@example.com',ticketReference: 'person@example.com' }, { repo })
  return { workspaceId,userId,contactId,erase }
}
async function history(workspaceId: string, rowId: string, primitive = 'entity') {
  return (await pool.query(`INSERT INTO correction_audit(workspace_id,action,primitive,row_id,reason,ticket_reference,row_snapshot,detail)
    VALUES($1,'soft_delete',$3,$2,'person@example.com','person@example.com',
      '{"email":"person@example.com"}','{"note":"Private fictional history"}') RETURNING id`, [workspaceId,rowId,primitive])).rows[0].id as string
}
const readHistory = async (workspaceId: string) => (await pool.query('SELECT * FROM correction_audit WHERE workspace_id=$1 ORDER BY id', [workspaceId])).rows

describe('[COMP:crm/operations-privacy] Correction history in actual person erasure', () => {
  afterAll(async () => { await pool.end() })

  it('minimizes all matching histories and the new receipt, preserving unrelated workspace, subject and primitive records', async () => {
    const f = await fixture(), other = await fixture(), anotherId = randomUUID()
    const ids: string[] = []
    for (let i=0;i<105;i++) ids.push(await history(f.workspaceId,f.contactId,['entity','contact','company','deal'][i%4]!))
    const unrelatedIds = [await history(f.workspaceId,anotherId),await history(f.workspaceId,f.contactId,'task')]
    await history(other.workspaceId,f.contactId)
    const otherBefore = await readHistory(other.workspaceId)
    const untouched = (await readHistory(f.workspaceId)).filter((row) => unrelatedIds.includes(row.id))
    await f.erase()
    expect((await pool.query('SELECT id FROM entities WHERE id=$1', [f.contactId])).rowCount).toBe(0)
    const after = await readHistory(f.workspaceId), erased = after.filter((row) => ids.includes(row.id))
    expect(erased).toHaveLength(105)
    for (const row of erased) expect(row).toMatchObject({ reason: 'Personal data erased',ticket_reference: null,
      row_snapshot: { erased: true },detail: { erased: true } })
    const receipt = after.filter((row) => row.action==='purge')
    expect(receipt).toHaveLength(1)
    expect(receipt[0]).toMatchObject({ row_id: f.contactId,actor_user_id: f.userId,reason: 'Personal data erased',
      ticket_reference: null,row_snapshot: { erased: true },detail: null })
    expect(JSON.stringify([...erased,...receipt])).not.toContain('person@example.com')
    expect(after.filter((row) => unrelatedIds.includes(row.id))).toEqual(untouched)
    expect(await readHistory(other.workspaceId)).toEqual(otherBefore)
  })

  it('erases every CRM sidecar alias without capturing new history or changing other primitives and workspaces', async () => {
    const f = await fixture(), other = await fixture()
    await pool.query(`INSERT INTO brain_row_versions(workspace_id,primitive,row_id,version_no,before_image,valid_from,valid_to,mutation_actor,mutation_reason)
      SELECT CASE WHEN n%2=0 THEN NULL ELSE $1::uuid END,(ARRAY['entity','contact','company','deal'])[1+n%4],$2,n,
        '{"private":"Historical private detail"}',now()-interval '1 minute',now(),'human_edit','Private history reason'
      FROM generate_series(1,108) n`,[f.workspaceId,f.contactId])
    await pool.query(`INSERT INTO brain_row_versions(workspace_id,primitive,row_id,version_no,before_image,valid_from,valid_to,mutation_actor,mutation_reason)
      VALUES($1,'memory',$2,1,'{"unrelated":"Different primitive"}',now()-interval '1 minute',now(),'human_edit','Unrelated reason'),
        ($3,'entity',$4,1,'{"unrelated":"Different workspace"}',now()-interval '1 minute',now(),'human_edit','Unrelated reason')`,
      [f.workspaceId,f.contactId,other.workspaceId,other.contactId])
    const preserved=(await pool.query("SELECT * FROM brain_row_versions WHERE row_id=$1 OR (row_id=$2 AND primitive='memory') ORDER BY id",[other.contactId,f.contactId])).rows
    const ids=(await pool.query("SELECT id FROM brain_row_versions WHERE row_id=$1 AND primitive<>'memory' ORDER BY id",[f.contactId])).rows.map(r=>r.id)
    await f.erase()
    const erased=(await pool.query('SELECT * FROM brain_row_versions WHERE id=ANY($1::uuid[]) ORDER BY id',[ids])).rows
    expect(erased).toHaveLength(108)
    expect(erased.map(r=>r.id)).toEqual(ids)
    for(const row of erased) {
      expect(row).toMatchObject({workspace_id:f.workspaceId,before_image:null,mutation_reason:'Personal data erased'})
      expect(row.erased_at).toBeInstanceOf(Date)
    }
    expect(JSON.stringify(erased)).not.toContain('Historical private detail')
    expect(JSON.stringify(erased)).not.toContain('Private history reason')
    expect((await pool.query("SELECT * FROM brain_row_versions WHERE row_id=$1 OR (row_id=$2 AND primitive='memory') ORDER BY id",[other.contactId,f.contactId])).rows).toEqual(preserved)
    expect((await pool.query('SELECT id FROM brain_row_versions WHERE row_id=ANY($1::uuid[])',[ [f.contactId,other.contactId] ])).rowCount).toBe(110)
  })

  it('rolls history and the purge receipt back if the final entity deletion fails', async () => {
    const f = await fixture(); await history(f.workspaceId,f.contactId)
    await pool.query(`INSERT INTO brain_row_versions(primitive,row_id,version_no,before_image,valid_from,valid_to,mutation_actor,mutation_reason)
      VALUES('entity',$1,1,'{"private":"Preserve on rollback"}',now()-interval '1 minute',now(),'human_edit','Private reason')`,[f.contactId])
    const sidecarBefore=(await pool.query('SELECT * FROM brain_row_versions WHERE row_id=$1',[f.contactId])).rows
    const before = await readHistory(f.workspaceId)
    await pool.query('CREATE TABLE fixture_crm_erasure_guard(contact_id uuid REFERENCES entities(id))')
    try {
      await pool.query('INSERT INTO fixture_crm_erasure_guard VALUES($1)', [f.contactId])
      await expect(f.erase()).rejects.toMatchObject({ code: '23503' })
      expect(await readHistory(f.workspaceId)).toEqual(before)
      expect((await pool.query('SELECT * FROM brain_row_versions WHERE row_id=$1',[f.contactId])).rows).toEqual(sidecarBefore)
      expect((await pool.query('SELECT id FROM entities WHERE id=$1', [f.contactId])).rowCount).toBe(1)
    } finally { await pool.query('DROP TABLE fixture_crm_erasure_guard') }
    await f.erase()
    expect((await readHistory(f.workspaceId)).filter((row) => row.action==='purge')).toHaveLength(1)
  })

  it.each(['purge','soft_delete'] as const)('preserves %s atomicity during a competing person deletion without resurrecting audit content', async (action) => {
    const f = await fixture(), snapshot = await repo.readForSoftDelete('contact',f.workspaceId,f.contactId)
    const blocker = await pool.connect()
    let deleting: Promise<void> | undefined
    try {
      await blocker.query('BEGIN')
      await blocker.query('SELECT id FROM entities WHERE id=$1 FOR UPDATE', [f.contactId])
      const common = { primitive: 'contact' as const,workspaceId: f.workspaceId,rowId: f.contactId,
        actorUserId: f.userId,reason: 'person@example.com',now: new Date() }
      deleting = action === 'purge' ? repo.applyHardPurge({ ...common,ticketReference: null,snapshot: snapshot! })
        : repo.applySoftDelete(common)
      // Observe the actual row-lock wait before deleting; no timing assumption.
      let waiting = false
      const until = Date.now()+3000
      while (!waiting && Date.now()<until) {
        waiting = (await pool.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid()
          AND wait_event_type='Lock' AND (query LIKE '%AS "isPerson"%FOR UPDATE%'
            OR query LIKE 'UPDATE entities SET valid_to%')`)).rowCount! > 0
        if (!waiting) await new Promise((resolve) => setTimeout(resolve,10))
      }
      expect(waiting).toBe(true)
      if (action === 'purge') {
        // The purge already holds exclusive privacy admission while it waits for this row.
        await expect(blocker.query('DELETE FROM entities WHERE id=$1', [f.contactId]))
          .rejects.toMatchObject({ code: '55P03', message: 'crm_privacy_operation_busy' })
        await blocker.query('ROLLBACK'); await deleting
        const receipts = await readHistory(f.workspaceId)
        expect(receipts).toHaveLength(1)
        expect(receipts[0]).toMatchObject({ action: 'purge', reason: 'Personal data erased',
          ticket_reference: null, row_snapshot: { erased: true }, detail: null })
        expect(JSON.stringify(receipts)).not.toContain('person@example.com')
      } else {
        await blocker.query('DELETE FROM entities WHERE id=$1', [f.contactId])
        const rejected = expect(deleting).rejects.toMatchObject({ code: 'row_not_found' })
        await blocker.query('COMMIT'); await rejected
        expect(await readHistory(f.workspaceId)).toEqual([])
      }
      expect((await pool.query('SELECT id FROM entities WHERE id=$1', [f.contactId])).rowCount).toBe(0)
    } finally {
      await blocker.query('ROLLBACK'); blocker.release()
      await deleting?.catch(() => {})
    }
  })

  it('preserves ordinary non-person correction receipt semantics', async () => {
    const f = await fixture(), fileId = randomUUID()
    await pool.query(`INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id)
      VALUES($1,$2,'/fixture.txt','fixture.txt','fixture://erasure-file',$3)`, [fileId,f.workspaceId,f.userId])
    const snapshot = await repo.readForSoftDelete('workspace_file',f.workspaceId,fileId)
    await repo.applyHardPurge({ primitive: 'workspace_file',workspaceId: f.workspaceId,rowId: fileId,actorUserId: f.userId,
      reason: 'Remove fixture file',ticketReference: 'fixture-reference',snapshot: snapshot!,now: new Date() })
    const rows = await readHistory(f.workspaceId)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ primitive: 'workspace_file',reason: 'Remove fixture file',ticket_reference: 'fixture-reference',
      row_snapshot: JSON.parse(JSON.stringify(snapshot)) })
  })
})
