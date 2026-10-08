import { describe, it, expect, vi } from 'vitest'
import { createTemplateImportRecovery } from '../template-import-recovery.js'
import { officeImportDiagnostics } from '../../db/office-generation.js'

function fixture() {
  const input = { userId:'member',workspaceId:'workspace',artifactId:'draft',failedJobId:'failed-job',clearance:'confidential' as const,compartmentGrant:['finance'],projectGrant:[] }
  const scope = { sensitivity:'confidential' as const,compartments:['finance'],projectIds:[] }
  const deps = {
    getJob: vi.fn(async()=>({id:'failed-job',workspaceId:'workspace',artifactId:'draft',initiatedByUserId:'member',status:'failed',jobKind:'template_compile',brief:{source:{kind:'upload',fileId:'source'}}} as never)),
    getArtifact:vi.fn(async()=>({id:'draft',workspaceId:'workspace',mode:'template',...scope} as never)),
    canEdit:vi.fn(async()=>true),readSource:vi.fn(async()=>({binding:{fileId:'source',workspaceId:'workspace',scopeVersion:'1',mime:'xlsx',hash:'hash',...scope}})),
    retry:vi.fn(async()=>({id:'recovered-job'} as never)),wake:vi.fn(),
  }
  return {input,deps,run:createTemplateImportRecovery(deps)}
}
describe('[COMP:api/office-generation] failed template import recovery',()=>{
  it('reuses the selected source and draft and queues only the guarded backend operation',async()=>{
    const f=fixture()
    expect(await f.run(f.input)).toEqual({jobId:'recovered-job'})
    expect(f.deps.readSource).toHaveBeenCalledWith({userId:'member',workspaceId:'workspace',fileId:'source'})
    expect(f.deps.retry).toHaveBeenCalledWith(f.input)
    expect(f.deps.wake).toHaveBeenCalledWith('member')
  })
  it('checks a replacement source and refuses a narrower assistant grant',async()=>{
    const f=fixture()
    expect(await f.run({...f.input,fileId:'replacement',compartmentGrant:[]})).toBeNull()
    expect(f.deps.readSource).toHaveBeenCalledWith(expect.objectContaining({fileId:'replacement'}))
    expect(f.deps.retry).not.toHaveBeenCalled()
  })
  it.each(['access','source','stale'] as const)('never wakes a job when %s is denied',async(kind)=>{
    const f=fixture()
    if(kind==='access')f.deps.canEdit.mockResolvedValue(false)
    if(kind==='source')f.deps.readSource.mockResolvedValue(null as never)
    if(kind==='stale')f.deps.retry.mockResolvedValue(null as never)
    expect(await f.run(f.input)).toBeNull()
    expect(f.deps.wake).not.toHaveBeenCalled()
  })
  it('projects only typed diagnostics and rejects arbitrary exception metadata',()=>{
    expect(officeImportDiagnostics({importDiagnostics:[{reason:'conditional_format',part:'xl/worksheets/sheet2.xml'}]})).toEqual([{reason:'conditional_format',part:'xl/worksheets/sheet2.xml'}])
    expect(officeImportDiagnostics({errorDetail:'private exception',importDiagnostics:[{reason:'invalid_file',message:'private exception'}]})).toEqual([])
  })
})
