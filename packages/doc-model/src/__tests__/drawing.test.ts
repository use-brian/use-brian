import { describe, expect, it } from 'vitest'
import { blockSchema, pageSchema, type Block } from '@use-brian/core/views/blocks.js'
import { applyOps } from '@use-brian/core/doc/ops.js'
import { opsSchema } from '@use-brian/core/doc/page-schemas.js'
import { pageToYDocUpdate, snapshotFromUpdate, pageToYDoc, yDocToSnapshot } from '../encode.js'
import { applyOpsToYDoc } from '../apply-ops.js'

const block: Block = { kind: 'drawing', id: 'drawing-1', scene: {
  version: 1, elements: [{ id: 'image-1', type: 'image', x: 1, y: 2, width: 40, height: 30, fileId: 'f', seed: 9 }],
  appState: { viewBackgroundColor: '#fff' },
  files: { f: { id: 'f', mimeType: 'image/png', dataURL: 'data:image/png;base64,YQ==', created: 1 } },
} }

describe('[COMP:doc-model/drawing] canonical persistence', () => {
  it('roundtrips a PNG through API/Yjs and removes it on both Brian scene edit paths', async () => {
    const preview = { mimeType: 'image/png' as const, width: 1, height: 1,
      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
      sceneDigest: 'a'.repeat(64) }
    const page = pageSchema.parse({ blocks: [{ ...block, preview }] })
    expect(snapshotFromUpdate(pageToYDocUpdate(page, '')).page).toEqual(page)
    const rename = opsSchema.parse([{ op: 'edit', blockId: block.id, patch: { title: '  Architecture sketch  ' } }])
    const named = { ...block, preview, title: 'Architecture sketch' }
    expect(applyOps(page, rename).page.blocks[0]).toEqual(named)
    const renamedDoc = pageToYDoc(page, '')
    applyOpsToYDoc(renamedDoc, [{ op: 'edit', blockId: block.id, patch: { title: '  Architecture sketch  ' } }])
    expect(yDocToSnapshot(renamedDoc).page.blocks[0]).toEqual(named)
    const invalidRename = { op: 'edit' as const, blockId: block.id, patch: { title: 'x'.repeat(201) } }
    expect(() => applyOps(page, [invalidRename])).toThrow()
    expect(applyOpsToYDoc(renamedDoc, [invalidRename]).skipped).toHaveLength(1)
    expect(yDocToSnapshot(renamedDoc).page.blocks[0]).toEqual(named)
    expect(snapshotFromUpdate(pageToYDocUpdate({ blocks: [named] }, '')).page.blocks[0]).toEqual(named)
    renamedDoc.destroy()
    const scene = { ...block.scene, appState: { viewBackgroundColor: '#123456' } }
    const ops = opsSchema.parse([{ op: 'edit', blockId: block.id, patch: { scene, preview } }])
    expect(applyOps(page, ops).page.blocks[0]).toEqual({ ...block, scene })
    const doc = pageToYDoc(page, '')
    applyOpsToYDoc(doc, [{ op: 'edit', blockId: block.id, patch: { scene, preview } }])
    expect(yDocToSnapshot(doc).page.blocks[0]).toEqual({ ...block, scene })
    doc.destroy()
  })
  it('survives API schema, embed mapping, Yjs binary reload, and snapshot validation without stripping images', () => {
    const page = pageSchema.parse({ blocks: [block] })
    expect(snapshotFromUpdate(pageToYDocUpdate(page, 'Sketch')).page).toEqual(page)
    expect(pageSchema.parse(snapshotFromUpdate(pageToYDocUpdate(page, 'Sketch')).page)).toEqual(page)
  })
  it('supports Brian add/edit/delete through the same Page and live Yjs operations', () => {
    const ops = opsSchema.parse([{ op: 'add', after: 'end', block }])
    const page = applyOps({ blocks: [] }, ops).page
    expect(blockSchema.parse(page.blocks[0])).toEqual(block)
    const doc = pageToYDoc(page, '')
    const scene = { ...block.scene, appState: { viewBackgroundColor: '#123456' } }
    applyOpsToYDoc(doc, [{ op: 'edit', blockId: block.id, patch: { scene } }])
    expect(yDocToSnapshot(doc).page.blocks[0]).toEqual({ ...block, scene })
    const invalid = applyOpsToYDoc(doc, [{ op: 'edit', blockId: block.id, patch: { scene: { ...scene, files: {} } } }])
    expect(invalid.skipped).toHaveLength(1)
    expect(yDocToSnapshot(doc).page.blocks[0]).toEqual({ ...block, scene })
    expect(() => applyOps(page, [{ op: 'edit', blockId: block.id, patch: { scene: { ...scene, files: {} } } }])).toThrow()
    applyOpsToYDoc(doc, [{ op: 'delete', blockId: block.id }])
    expect(yDocToSnapshot(doc).page.blocks).toEqual([])
    doc.destroy()
  })
})
