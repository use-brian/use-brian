import {beforeEach,describe,it,expect,vi} from 'vitest'
import {readOfficeGenerationRecovery,resumeOfficeGeneration} from '../generation-recovery.js'
import {officeGenerationInputQuestion,type OfficeGenerationJobRow} from '../../db/office-generation.js'

const f=vi.hoisted(()=>({
  user:'10000000-0000-4000-8000-000000000001',artifact:'10000000-0000-4000-8000-000000000002',
  jobId:'10000000-0000-4000-8000-000000000003',version:'10000000-0000-4000-8000-000000000004',
  workspace:'10000000-0000-4000-8000-000000000005',
  root:{} as Record<string,unknown>,job:{} as Record<string,unknown>,access:{} as Record<string,unknown>,
  rows:[] as unknown[],blocked:false,locked:true,policy:'legacy',writes:[] as string[],
  query:vi.fn(),release:vi.fn(),
}))
vi.mock('../../db/client.js',()=>({getAppPool:()=>({connect:async()=>({query:f.query,release:f.release})}),
  applyRLSGucs:vi.fn(),rollbackAndRelease:vi.fn()}))
vi.mock('../../db/office-artifacts.js',()=>({defaultOfficeDbQuery:async(_user:string,sql:string,params:unknown[])=>f.query(sql,params)}))
const input=()=>({artifactId:f.artifact,jobId:f.jobId,templateVersionId:f.version})
beforeEach(()=>{
  f.root={workspaceId:f.workspace,family:'spreadsheet',mode:'artifact',headVersion:0}
  f.job={id:f.jobId,workspaceId:f.workspace,artifactId:f.artifact,initiatedByUserId:f.user,jobKind:'create',
    status:'needs_input',errorCode:'template_ambiguous',templateVersionId:null,authorityProjection:{sensitivity:'internal',compartmentGrant:['finance'],projectGrant:[]},createdAt:new Date()}
  f.access={artifactId:f.artifact,workspaceId:f.workspace,creatorUserId:f.user,ownerUserId:f.user,mode:'artifact',expiresAt:null,
    sensitivity:'internal',visibilityUserIds:[],requiredCompartments:[],sourcesEligible:true,mutationScopeEligible:true,
    defaultWorkspaceRole:'view',lifecycleState:'active',memberRole:'member',memberClearance:'internal',memberCompartments:null,
    explicitRole:null,grantRevokedAt:null}
  f.rows=[{templateVersionId:f.version,name:'Quarterly worksheet',scopes:[{sensitivity:'internal',compartments:['finance'],projectIds:[]}]}]
  f.blocked=false;f.locked=true;f.policy='legacy';f.writes=[]
  f.query.mockReset().mockImplementation(async(sql:string)=>{
    if(sql.startsWith('SELECT workspace_id AS'))return {rows:[f.root]}
    if(sql.includes('AS "creatorUserId"'))return {rows:[f.access]}
    if(sql.includes('FROM office_generation_jobs WHERE id ='))return {rows:[f.job]}
    if(sql.includes('FROM office_templates t JOIN'))return {rows:f.rows}
    if(sql.includes('AS blocked'))return {rows:[{blocked:f.blocked}]}
    if(sql.includes(' AS locked'))return {rows:[{locked:f.locked}]}
    if(sql.includes('FROM workspace_access_policies'))return {rows:[{setup_state:f.policy,setupState:f.policy}]}
    if(sql.startsWith('UPDATE')||sql.includes('INSERT INTO'))f.writes.push(sql)
    return {rows:sql.includes('INSERT INTO office_generation_events')?[{id:'event'}]:[]}
  })
})
describe('[COMP:api/office-generation-recovery] template selection recovery',()=>{
  it('requeues only the same empty draft after locking the readable published source',async()=>{
    expect(await resumeOfficeGeneration(f.user,input())).toEqual({artifactId:f.artifact,jobId:f.jobId})
    expect(f.writes).toHaveLength(3)
    expect(f.query.mock.calls.findIndex(([sql])=>sql.includes(' AS locked'))).toBeLessThan(f.query.mock.calls.findIndex(([sql])=>sql.startsWith('UPDATE')))
  })
  it.each(['edited','noninitiator','read_only','newer_job','source_revoked','unpublished','ready'] as const)('refuses %s recovery without writes',async(reason)=>{
    if(reason==='edited')f.root.headVersion=1
    if(reason==='noninitiator')f.job.initiatedByUserId='other'
    if(reason==='read_only')f.access.mutationScopeEligible=false
    if(reason==='newer_job')f.blocked=true
    if(reason==='source_revoked')f.locked=false
    if(reason==='unpublished')f.rows=[]
    if(reason==='ready')f.policy='ready'
    await expect(resumeOfficeGeneration(f.user,input())).rejects.toBeTruthy()
    expect(f.writes).toEqual([])
  })
  it('returns an accepted identical selection without resetting a running or completed job',async()=>{
    for(const status of ['queued','running','completed']) {
      f.job.status=status;f.job.templateVersionId=f.version
      expect(await resumeOfficeGeneration(f.user,input())).toEqual({artifactId:f.artifact,jobId:f.jobId})
    }
    expect(f.writes).toEqual([])
    await expect(resumeOfficeGeneration(f.user,{...input(),templateVersionId:'10000000-0000-4000-8000-000000000006'})).rejects.toMatchObject({status:409})
  })
  it('filters template choices by both the pinned job scope and current assistant ceiling',async()=>{
    expect((await readOfficeGenerationRecovery(f.user,f.artifact,f.jobId)).templateChoices).toHaveLength(1)
    expect((await readOfficeGenerationRecovery(f.user,f.artifact,f.jobId,{compartmentGrant:[]})).templateChoices).toEqual([])
    f.rows=[{templateVersionId:f.version,name:'Private template',scopes:[{sensitivity:'confidential',compartments:[],projectIds:[]}]}]
    expect((await readOfficeGenerationRecovery(f.user,f.artifact,f.jobId)).templateChoices).toEqual([])
  })
  it('projects typed input questions and never arbitrary worker exceptions',()=>{
    const job=f.job as unknown as OfficeGenerationJobRow
    expect(officeGenerationInputQuestion({...job,errorDetail:'private exception'})).toBe('Which published template should I use?')
    expect(officeGenerationInputQuestion({...job,errorCode:'material_fact_missing',errorDetail:'Please provide the required fields: PAYMENT_TERMS'})).toContain('PAYMENT_TERMS')
    expect(officeGenerationInputQuestion({...job,errorCode:'worker_failed',errorDetail:'private exception'})).toBeUndefined()
  })
})
