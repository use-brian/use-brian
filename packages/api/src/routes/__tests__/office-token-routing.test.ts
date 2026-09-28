import express from 'express'
import request from 'supertest'
import { describe, expect, it, vi } from 'vitest'
import { officeTemplateRoutes, type OfficeTemplatesRouteDeps } from '../office-templates.js'
import { documentFixture, spreadsheetFixture } from '../../../../office-model/src/__tests__/fixtures.js'

// Transport fixtures only; real transaction/RLS proof lives in office-library-scope.integration.
vi.mock('../../db/office-read-projection.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../db/office-read-projection.js')>(),
  readOfficeProjection: async (_user: string, read: () => Promise<import('../../db/office-read-projection.js').OfficeMetadataReply>) => ({...await read(), validForMs: 30_000}),
}))

describe('[COMP:api/office-routes] DOCX/XLSX routing endpoints', () => {
  it.each(['document', 'spreadsheet'] as const)('allows %s field review and rejects stale bindings and empty contracts', async (family) => {
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
      getTemplate: vi.fn(async () => ({ id: snapshot.templateVersionId!, workspaceId: snapshot.workspaceId, family, lifecycleState: 'draft', draftArtifactId: snapshot.artifactId })),
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
})
