import { describe, expect, it, vi } from 'vitest'
import type { ToolContext, ScopeSource } from '@use-brian/core'
import type { OfficeArtifactRow } from '../../db/office-artifacts.js'
import { createOfficeService } from '../service.js'

const artifact: OfficeArtifactRow = {
  id: '10000000-0000-4000-8000-000000000001',
  workspaceId: '10000000-0000-4000-8000-000000000002',
  family: 'document',
  mode: 'artifact',
  title: 'Beacon plan',
  creatorUserId: '10000000-0000-4000-8000-000000000003',
  ownerUserId: '10000000-0000-4000-8000-000000000003',
  templateVersionId: null,
  headVersionId: null,
  headVersion: 1,
  capabilityVersion: 1,
  sensitivity: 'internal',
  compartments: ['team:sales'],
  projectIds: ['10000000-0000-4000-8000-000000000004'],
  defaultWorkspaceRole: 'view',
  lifecycleState: 'active',
  expiresAt: null,
  updatedAt: new Date(0),
}

const access = {
  role: 'edit',
  canComment: true,
} as never

function service() {
  const createJob = vi.fn()
  const deps = {
    generationAvailable: vi.fn(() => true),
    createShell: vi.fn(),
    deleteEmptyShell: vi.fn(),
    getArtifact: vi.fn(async () => artifact),
    raiseScope: vi.fn(async () => true),
    resolveAccess: vi.fn(async () => access),
    createJob,
    latestJob: vi.fn(async () => null),
    getSnapshot: vi.fn(async () => null),
  }
  return { port: createOfficeService(deps as never), createJob }
}

describe('[COMP:brain/context-projection] Office turn-scope projection', () => {
  it('returns the admitted classification for local export without exposing an out-of-scope root', async () => {
    const { port } = service()
    expect(await port.get({userId:artifact.ownerUserId,artifactId:artifact.id,clearance:'confidential',compartmentGrant:artifact.compartments,projectGrant:artifact.projectIds})).toMatchObject({sensitivity:'internal'})
  })
  it('makes an out-of-Project id indistinguishable from an unknown artifact', async () => {
    const { port } = service()
    await expect(port.get({
      userId: artifact.ownerUserId,
      artifactId: artifact.id,
      clearance: 'confidential',
      compartmentGrant: ['team:sales'],
      projectGrant: ['10000000-0000-4000-8000-000000000099'],
    })).resolves.toBeNull()
  })

  it('requires every Team compartment and sensitivity tier before returning metadata', async () => {
    const { port } = service()
    await expect(port.get({
      userId: artifact.ownerUserId,
      artifactId: artifact.id,
      clearance: 'public',
      compartmentGrant: [],
      projectGrant: artifact.projectIds,
    })).resolves.toBeNull()
  })

  it('does not queue a revision when the active Project excludes the artifact', async () => {
    const { port, createJob } = service()
    await expect(port.revise({
      userId: artifact.ownerUserId,
      assistantId: '10000000-0000-4000-8000-000000000005',
      artifactId: artifact.id,
      instruction: 'Revise',
      targetIds: ['10000000-0000-4000-8000-000000000006'],
      expectedVersion: 1,
      idempotencyKey: 'revision-12345678',
      sensitivity: 'internal',
      compartments: artifact.compartments,
      projectIds: artifact.projectIds,
      clearance: 'confidential',
      compartmentGrant: artifact.compartments,
      projectGrant: [],
    })).resolves.toBeNull()
    expect(createJob).not.toHaveBeenCalled()
  })
})


describe('[COMP:office/tools] native review read authority',()=>{
  it.each(['resolve', 'assign'] as const)('requires current comment authority and matching context for %s', async kind => {
    const source: ScopeSource = { resourceKind: 'office_observation', resourceId: '10000000-0000-4000-8000-000000000007', version: '1',
      workspaceId: artifact.workspaceId, userId: null, assistantId: null, sensitivity: 'internal', compartments: artifact.compartments, projectIds: artifact.projectIds }
    const resolveComment = vi.fn(async () => true)
    const resolveAccess = vi.fn(async () => access)
    const port = createOfficeService({ generationAvailable: () => true, createShell: vi.fn(), deleteEmptyShell: vi.fn(), getArtifact: async () => artifact,
      resolveAccess, raiseScope: vi.fn(), createJob: vi.fn(), latestJob: vi.fn(), getSnapshot: vi.fn(), captureObservation: async () => source, resolveComment, updateCommentThread: resolveComment })
    const context = { userId: artifact.ownerUserId, assistantId: '10000000-0000-4000-8000-000000000008', workspaceId: artifact.workspaceId,
      clearance: 'internal', compartments: artifact.compartments, projectIds: artifact.projectIds } as ToolContext
    const input = { artifactId: artifact.id, threadId: '10000000-0000-4000-8000-000000000009', ...(kind === 'resolve' ? { resolved: true } : { assignedUserId: null, assignedToBrian: true, dueAt: null }) }
    const change = (kind === 'resolve' ? port.resolveComment : port.assignComment)! as (context: ToolContext, input: unknown) => Promise<unknown>
    expect(await change({ ...context, projectIds: [] }, input)).toBeNull()
    expect(await change({ ...context, workspaceId: input.threadId }, input)).toBeNull()
    resolveAccess.mockResolvedValueOnce({ ...access as object, canComment: false } as never)
    expect(await change(context, input)).toBeNull()
    expect(resolveComment).not.toHaveBeenCalled()
    expect(await change(context, input)).toMatchObject({ scopeEvidence: { sources: [source] } })
    expect(resolveComment).toHaveBeenCalledWith(expect.objectContaining({ ...input, actorAssistantId: context.assistantId, admissionObservationId: source.resourceId }))
  })
  it('withholds review payload when the canonical observation changes during the read',async()=>{
    const source:ScopeSource={resourceKind:'office_observation',resourceId:'10000000-0000-4000-8000-000000000007',version:'1',
      workspaceId:artifact.workspaceId,userId:null,assistantId:null,sensitivity:'internal',compartments:artifact.compartments,projectIds:artifact.projectIds}
    const read=vi.fn(async()=>Array.from({length:200},(_,i)=>({id:String(i)})))
    const capture=vi.fn(async()=>source)
    const port=createOfficeService({generationAvailable:()=>true,createShell:vi.fn(),deleteEmptyShell:vi.fn(),getArtifact:async()=>artifact,
      resolveAccess:async()=>access,raiseScope:vi.fn(),createJob:vi.fn(),latestJob:vi.fn(),getSnapshot:vi.fn(),captureObservation:capture,
      listVersions:read,listThreads:read,listSuggestions:read})
    const context={userId:artifact.ownerUserId,workspaceId:artifact.workspaceId,clearance:'internal',compartments:artifact.compartments,projectIds:artifact.projectIds} as ToolContext
    expect(await port.inspectReview!(context,{artifactId:artifact.id,kind:'history',offset:1,limit:2})).toMatchObject({items:[{id:'1'},{id:'2'}],nextOffset:3,windowLimitReached:true})
    capture.mockResolvedValueOnce(source).mockResolvedValueOnce({...source,version:'2'})
    expect(await port.inspectReview!(context,{artifactId:artifact.id,kind:'comments',offset:0,limit:2})).toBeNull()
    read.mockClear()
    expect(await port.inspectReview!({...context,projectIds:[]},{artifactId:artifact.id,kind:'suggestions',offset:0,limit:2})).toBeNull()
    expect(read).not.toHaveBeenCalled()
  })
})

describe('[COMP:office/tools] exact selected content', () => {
  const nodeId='10000000-0000-4000-8000-000000000020', runId='10000000-0000-4000-8000-000000000021'
  const source:ScopeSource={resourceKind:'office_observation',resourceId:'10000000-0000-4000-8000-000000000007',version:'1',
    workspaceId:artifact.workspaceId,userId:null,assistantId:null,sensitivity:'internal',compartments:artifact.compartments,projectIds:artifact.projectIds}
  const context={userId:artifact.ownerUserId,workspaceId:artifact.workspaceId,clearance:'internal',compartments:artifact.compartments,projectIds:artifact.projectIds} as ToolContext
  const node={id:nodeId,kind:'paragraph',runs:[{id:runId,text:'Exact full text',style:{fontFamily:'Arial',fontSizePt:12,bold:true}}]}
  function setup(snapshot:unknown={family:'document',sections:[{id:'section',nodes:[node]}]}) {
    const capture=vi.fn(async()=>source)
    const port=createOfficeService({generationAvailable:()=>true,createShell:vi.fn(),deleteEmptyShell:vi.fn(),getArtifact:async()=>artifact,
      resolveAccess:async()=>access,raiseScope:vi.fn(),createJob:vi.fn(),latestJob:vi.fn(),
      getSnapshot:async()=>({snapshot,canonicalHash:'hash'}) as never,captureObservation:capture})
    return {port,capture}
  }
  it('preserves exact rich text and reports missing targets without including backing resource data',async()=>{
    const {port}=setup({family:'document',resources:[{id:'secret',storageKey:'private-storage'}],sections:[{id:'section',nodes:[node]}]})
    const result=await port.get({context,userId:context.userId,artifactId:artifact.id,targetIds:[nodeId,runId,artifact.id]})
    expect(result?.selection).toEqual({targets:[{id:nodeId,content:node},{id:runId,content:node.runs[0]}],missingTargetIds:[artifact.id],oversizedTargetIds:[]})
    expect(JSON.stringify(result)).not.toContain('private-storage')
    expect(result).not.toHaveProperty('targets')
  })
  it('reports oversized content without truncating canonical records',async()=>{
    const {port}=setup({family:'document',sections:[{id:'section',nodes:[{...node,runs:[{...node.runs[0],text:'x'.repeat(32*1024)}]}]}]})
    expect((await port.get({context,userId:context.userId,artifactId:artifact.id,targetIds:[nodeId]}))?.selection)
      .toEqual({targets:[],missingTargetIds:[],oversizedTargetIds:[nodeId]})
  })
  it('refuses cross-workspace or concurrently changed selected content',async()=>{
    const {port,capture}=setup()
    expect(await port.get({context:{...context,workspaceId:runId},userId:context.userId,artifactId:artifact.id,targetIds:[nodeId]})).toBeNull()
    expect(capture).not.toHaveBeenCalled()
    capture.mockResolvedValueOnce(source).mockResolvedValueOnce({...source,version:'2'})
    expect(await port.get({context,userId:context.userId,artifactId:artifact.id,targetIds:[nodeId]})).toBeNull()
  })
  it('excludes signature fields and overlays even when selecting their containing PDF page',async()=>{
    const page={id:nodeId,fields:[{id:runId,kind:'signature',value:'private-signature'}],overlays:[{id:artifact.id,kind:'signature',resourceId:'signature-resource'}],placementTargets:[]}
    const {port}=setup({family:'pdf',source:{sha256:'hash'},pages:[page]})
    const result=await port.get({context,userId:context.userId,artifactId:artifact.id,targetIds:[nodeId,runId]})
    expect(result?.selection).toEqual({targets:[{id:nodeId,content:{...page,fields:[],overlays:[]}}],missingTargetIds:[runId],oversizedTargetIds:[]})
    expect(JSON.stringify(result)).not.toContain('signature-resource')
  })
})
