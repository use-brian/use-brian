/** Import jobs are read through their raw source's department floor. */
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import type { CrmOperationsContext, FilesApi } from '@use-brian/core'
import { createCrmProductionImportService } from '../../crm-operations/import-service.js'
import { getPool } from '../client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const imports = createCrmProductionImportService({ pool, filesApi: {} as FilesApi })

async function fixture() {
  const workspaceId = randomUUID(), custodian = randomUUID(), cedarMember = randomUUID(), harborMember = randomUUID()
  const cedar = randomUUID(), harbor = randomUUID(), fileId = randomUUID(), jobId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text),($2::uuid,$2::text),($3::uuid,$3::text)', [custodian, cedarMember, harborMember])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional import workspace',$2)", [workspaceId, custodian])
  await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1', [workspaceId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member')", [workspaceId, custodian, cedarMember, harborMember])
  for (const [id, name, member] of [[cedar, 'Cedar', cedarMember], [harbor, 'Harbor', harborMember]]) {
    await pool.query(`INSERT INTO workspace_groups(id,workspace_id,kind,name,created_by,compartment_key,key)
      VALUES($1::uuid,$2,'team',$3,$4,$5,$1::text)`, [id, workspaceId, name, custodian, `team:${id}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,$3,'team',$4)", [workspaceId, `team:${id}`, name, id])
    await pool.query(`INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin)
      VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING`, [workspaceId, id, member])
  }
  // The raw CSV is a Cedar Confidential file; its import job and error rows inherit that floor.
  await pool.query(`INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id,sensitivity,compartments)
    VALUES($1,$2,$3,'fictional.csv','fixture://local',$4,'confidential',$5)`, [fileId, workspaceId, `/fixture/${fileId}.csv`, custodian, [`team:${cedar}`]])
  await pool.query(`INSERT INTO crm_import_jobs(id,workspace_id,staged_file_id,entity_kind,status,mapping,mapping_hash,source_hash,total_rows,created_by_user_id,confirmed_by_user_id)
    VALUES($1,$2,$3,'contact','ready','{"columns":{}}'::jsonb,repeat('a',64),repeat('b',64),1,$4,$4)`, [jobId, workspaceId, fileId, custodian])
  await pool.query(`INSERT INTO crm_import_errors(workspace_id,job_id,row_number,error_code,field_key,message,row_snapshot)
    VALUES($1,$2,1,'invalid_email','email','Fictional failure','{"name":"Fictional Cedar Person"}'::jsonb)`, [workspaceId, jobId])
  const context = (userId: string): CrmOperationsContext => ({ workspaceId, actor: { kind: 'user', userId },
    authority: { role: 'member', canWrite: true, canConfigure: false, trustedIdentitySources: [] } })
  return { workspaceId, jobId, cedar: context(cedarMember), harbor: context(harborMember) }
}

describe('[COMP:crm/production-import] Departmental import job reads', () => {
  afterAll(async () => { await Promise.all([pool.end(), getPool().end()]) })

  it('withholds another department\'s job, raw error values and cancellation, and admits its own department', async () => {
    const f = await fixture()
    expect((await imports.list(f.harbor)).jobs).toEqual([])
    expect(await imports.get(f.harbor, f.jobId)).toBeNull()
    expect(await imports.errorsCsv(f.harbor, f.jobId)).toBeNull()
    expect(await imports.resultsCsv(f.harbor, f.jobId)).toBeNull()
    await expect(imports.cancel(f.harbor, f.jobId)).rejects.toMatchObject({ code: 'not_found' })
    expect((await pool.query('SELECT status FROM crm_import_jobs WHERE id=$1', [f.jobId])).rows[0].status).toBe('ready')

    expect((await imports.list(f.cedar)).jobs.map(job => job.id)).toEqual([f.jobId])
    expect(await imports.errorsCsv(f.cedar, f.jobId)).toContain('Fictional Cedar Person')
  })
})
