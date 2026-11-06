import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { officeTemplateRoutes, type OfficeTemplatesRouteDeps } from '../office-templates.js'
import { documentFixture, spreadsheetFixture } from '../../../../office-model/src/__tests__/fixtures.js'
import { inferOfficeTemplateRouting } from '@use-brian/core'

// Transport fixtures only; real transaction/RLS proof lives in office-library-scope.integration.
vi.mock('../../db/office-read-projection.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../db/office-read-projection.js')>(),
  readOfficeProjection: async (_user: string, read: () => Promise<import('../../db/office-read-projection.js').OfficeMetadataReply>) => ({...await read(), validForMs: 30_000}),
}))

describe('[COMP:api/office-routes] DOCX/XLSX routing endpoints', () => {
  it.each([['document','draft'],['document','admitted'],['spreadsheet','draft'],['spreadsheet','admitted']] as const)('allows %s %s field review and rejects stale bindings and empty contracts', async (family,lifecycleState) => {
    const snapshot = family === 'document' ? documentFixture() : spreadsheetFixture()
    if (snapshot.family === 'document') {
      const node = snapshot.sections[0]!.nodes[0]!
      if (node.kind === 'paragraph') node.runs[0]!.text = '{{NAME}}'
    } else {
      snapshot.worksheets[0]!.cells[0]!.value = '{{NAME}}'
      snapshot.worksheets[0]!.cells[0]!.valueType = 'string'
      snapshot.worksheets[0]!.cells[0]!.locked = false
    }
    const save = vi.fn(async () => true)
    const deps = {
      getTemplate: vi.fn(async () => ({ id: snapshot.templateVersionId!, workspaceId: snapshot.workspaceId, family, lifecycleState, draftArtifactId: snapshot.artifactId })),
      getArtifact: vi.fn(async () => ({id:snapshot.artifactId,workspaceId:snapshot.workspaceId,family,mode:'template',lifecycleState:'active'})),
      getSnapshot: vi.fn(async () => ({ snapshot, baseVersion: 0, seq: 0 })),
      getDraftRouting: vi.fn(async () => null),
      saveDraftRouting: save,
    } as unknown as OfficeTemplatesRouteDeps
    const server = express()
    server.use(express.json())
    server.use((req, _res, next) => { (req as { userId?: string }).userId = snapshot.workspaceId; next() })
    server.use('/api/office', officeTemplateRoutes(deps))
    const path = `/api/office/templates/${snapshot.templateVersionId}/routing`
    const get = await request(server).get(path).expect(200)
    expect(save).not.toHaveBeenCalled()
    const routing = get.body.routing
    expect(routing.fields).toHaveLength(1)
    expect(routing.fields[0]).toMatchObject({ name: 'NAME', required: false, type: 'plainText', maxLength: 100_000 })
    routing.fields[0] = { ...routing.fields[0], required: true, type: 'number', maxLength: 24, aiInstruction: 'Use supplied amount', label: 'Amount' }
    await request(server).put(path).send({ routing }).expect(200)
    expect(save).toHaveBeenLastCalledWith(expect.objectContaining({ routing }))
    await request(server).put(path).send({ routing: { ...routing, fields: [] } }).expect(400)
    const invalid = structuredClone(routing)
    invalid.fields[0].targetIds = [snapshot.workspaceId]
    await request(server).put(path).send({ routing: invalid }).expect(400)
    routing.fields[0].locked = true
    await request(server).put(path).send({ routing }).expect(400)
  })
  it.each(['deprecated','trash','retained','purged','unknown','missing','held','archived','wrong-workspace','wrong-family','wrong-mode'])('withholds routing for %s sources',async state=>{
    const snapshot=documentFixture(),getRouting=vi.fn(),save=vi.fn(),getSnapshot=vi.fn()
    const deps={
      getTemplate:vi.fn(async()=>state==='missing'?null:({id:snapshot.templateVersionId,workspaceId:snapshot.workspaceId,family:'document',lifecycleState:['held','archived','wrong-workspace','wrong-family','wrong-mode'].includes(state)?'admitted':state,draftArtifactId:snapshot.artifactId})),
      getArtifact:vi.fn(async()=>state==='held'?null:({id:snapshot.artifactId,workspaceId:state==='wrong-workspace'?snapshot.artifactId:snapshot.workspaceId,family:state==='wrong-family'?'spreadsheet':'document',mode:state==='wrong-mode'?'artifact':'template',lifecycleState:state==='archived'?'archived':'active'})),
      getSnapshot,getDraftRouting:getRouting,saveDraftRouting:save,
    } as unknown as OfficeTemplatesRouteDeps
    const server=express();server.use(express.json());server.use((req,_res,next)=>{(req as {userId?:string}).userId=snapshot.workspaceId;next()})
    server.use('/api/office',officeTemplateRoutes(deps))
    const path=`/api/office/templates/${snapshot.templateVersionId}/routing`
    await request(server).get(path).expect(404)
    await request(server).put(path).send({routing:{source:'scratch',fields:[],slideRecipes:[]}}).expect(404)
    expect(getSnapshot).not.toHaveBeenCalled();expect(getRouting).not.toHaveBeenCalled();expect(save).not.toHaveBeenCalled()
  })
  it('returns all reviewed admitted routing fields and saves future edits without replacing the admitted contract',async()=>{
    const snapshot=documentFixture(),node=snapshot.sections[0]!.nodes[0]!
    if(node.kind!=='paragraph')throw new Error('Expected paragraph fixture')
    node.runs[0]!.text=Array.from({length:18},(_,index)=>`{{FIELD_${index}}}`).join(' ')
    const routing=inferOfficeTemplateRouting(snapshot,'upload')
    routing.fields[0]!.label='Reviewed amount';routing.fields[0]!.aiInstruction='Use supplied amount exactly'
    const admittedFields=structuredClone(routing.fields),save=vi.fn(async()=>true)
    const deps={getTemplate:async()=>({workspaceId:snapshot.workspaceId,family:'document',lifecycleState:'admitted',draftArtifactId:snapshot.artifactId}),
      getArtifact:async()=>({workspaceId:snapshot.workspaceId,family:'document',mode:'template',lifecycleState:'active'}),
      getSnapshot:async()=>({snapshot}),getDraftRouting:async()=>routing,saveDraftRouting:save} as unknown as OfficeTemplatesRouteDeps
    const server=express();server.use(express.json());server.use((req,_res,next)=>{(req as {userId?:string}).userId=snapshot.workspaceId;next()});server.use('/api/office',officeTemplateRoutes(deps))
    const path=`/api/office/templates/${snapshot.templateVersionId}/routing`,get=await request(server).get(path).expect(200)
    expect(get.body.routing).toEqual(routing);expect(get.body.routing.fields).toHaveLength(18)
    const changed=structuredClone(routing);changed.fields[0]!.label='Next version amount'
    await request(server).put(path).send({routing:changed}).expect(200)
    expect(save).toHaveBeenCalledWith(expect.objectContaining({routing:changed}))
    expect(routing.fields).toEqual(admittedFields)
  })
})
