import { createHash } from 'node:crypto'
import { applyOfficeCommand, type OfficeCommand, type PdfSnapshot } from '@use-brian/office-model'
import { OPS, getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { describe, expect, it } from 'vitest'
import { createPdfWriterPort, parsePdfSession, validateRenderedPdf } from '../pdf/index.js'
import { createFictionalSignaturePng, createSupportedPdfFixture } from './fixtures/pdf/index.js'

const id = (ordinal: number) => `00000000-0000-4000-8000-${ordinal.toString().padStart(12, '0')}`
const userId = id(3)

function base(ordinal: number) {
  return {
    commandId: id(ordinal),
    artifactId: id(1),
    baseVersion: 0,
    actor: { type: 'user' as const, id: userId },
    origin: 'manual' as const,
  }
}

function apply(snapshot: PdfSnapshot, command: OfficeCommand): PdfSnapshot {
  return applyOfficeCommand(snapshot, command) as PdfSnapshot
}

describe('[COMP:office/pdf-engine] PDF writer round trip', () => {
  it('applies every supported field, page, overlay, and signature operation to a flattened vector PDF', async () => {
    const sourceBytes = await createSupportedPdfFixture()
    const immutableCopy = new Uint8Array(sourceBytes)
    let snapshot = await parsePdfSession({
      bytes: sourceBytes,
      artifactId: id(1),
      workspaceId: id(2),
      ownerUserId: userId,
      fileId: id(4),
      originalFileName: 'fictional-form.example.pdf',
      title: 'Fictional PDF form',
      locale: 'ja-JP',
      defaultLanguage: 'ja-JP',
    })
    const pageOneId = snapshot.pages[0].id
    const pageTwoId = snapshot.pages[1].id
    const fields = snapshot.pages.flatMap((page) => page.fields)
    const field = (kind: typeof fields[number]['kind']) => {
      const found = fields.find((candidate) => candidate.kind === kind)
      if (!found) throw new Error(`Missing fixture field ${kind}`)
      return found
    }

    const updates: OfficeCommand[] = [
      { ...base(101), kind: 'setPdfFieldValue', fieldId: field('text').id, value: 'Latin café 日本語 简体中文' },
      { ...base(102), kind: 'setPdfFieldValue', fieldId: field('checkbox').id, value: true },
      { ...base(103), kind: 'setPdfFieldValue', fieldId: field('radio').id, value: '0' },
      { ...base(104), kind: 'setPdfFieldValue', fieldId: field('dropdown').id, value: 'south' },
      { ...base(105), kind: 'setPdfFieldValue', fieldId: field('option-list').id, value: ['two', 'three'] },
      {
        ...base(106),
        kind: 'addPdfOverlay',
        pageId: pageOneId,
        overlay: {
          id: id(206),
          pageId: pageOneId,
          kind: 'text',
          rect: { x: 250, y: 300, width: 220, height: 30 },
          rotation: 0,
          zOrder: 0,
          creator: { type: 'user', id: userId },
          text: 'Overlay 日本語 简体中文',
          appearance: { fontSizePt: 12, color: '#153E75', alignment: 'start' },
        },
      },
      {
        ...base(107),
        kind: 'addPdfOverlay',
        pageId: pageOneId,
        overlay: {
          id: id(207),
          pageId: pageOneId,
          kind: 'date',
          rect: { x: 250, y: 260, width: 120, height: 24 },
          rotation: 0,
          zOrder: 1,
          creator: { type: 'user', id: userId },
          date: '2026-09-29',
          appearance: { fontSizePt: 10, color: '#111111', alignment: 'start' },
        },
      },
      {
        ...base(108),
        kind: 'addPdfOverlay',
        pageId: pageOneId,
        overlay: {
          id: id(208),
          pageId: pageOneId,
          kind: 'checkmark',
          rect: { x: 250, y: 220, width: 22, height: 22 },
          rotation: 0,
          zOrder: 2,
          creator: { type: 'user', id: userId },
          mark: 'check',
          color: '#16794D',
          strokeWidthPt: 2,
        },
      },
      { ...base(109), kind: 'rotatePdfPage', pageId: pageOneId, rotation: 180 },
      { ...base(110), kind: 'reorderPdfPage', pageId: pageTwoId, toIndex: 0 },
    ]
    for (const command of updates) snapshot = apply(snapshot, command)

    const signatureBytes = await createFictionalSignaturePng()
    const signatureResourceId = id(300)
    const signatureHash = createHash('sha256').update(signatureBytes).digest('hex')
    snapshot = apply(snapshot, {
      ...base(111),
      kind: 'attachResource',
      resource: {
        id: signatureResourceId,
        kind: 'image',
        hash: signatureHash,
        mime: 'image/png',
        sensitivity: 'confidential',
      },
    })
    const signatureTarget = snapshot.pages.flatMap((page) => page.placementTargets)[0]
    expect(signatureTarget).toBeDefined()
    snapshot = apply(snapshot, {
      ...base(112),
      kind: 'placePdfSignature',
      targetId: signatureTarget.id,
      signatureResourceId,
    })

    const writer = createPdfWriterPort({
      resolveResource: async (resourceId) => resourceId === signatureResourceId
        ? { bytes: signatureBytes, mime: 'image/png', sha256: signatureHash }
        : null,
    })
    const rendered = await writer.render(sourceBytes, snapshot)
    const validated = await validateRenderedPdf(snapshot, rendered)

    expect(sourceBytes).toEqual(immutableCopy)
    expect(validated.sha256).toBe(rendered.sha256)
    expect(validated.pageCount).toBe(2)
    expect(validated.textByPage[0]).toContain('VECTOR PAGE TWO')
    expect(validated.textByPage[1]).toContain('VECTOR PAGE ONE')
    expect(validated.textByPage.join('').replace(/\s+/g, '')).toContain('日本語')
    expect(validated.textByPage.join('').replace(/\s+/g, '')).toContain('简体中文')
    expect(rendered.pages.map((page) => page.rotation)).toEqual([90, 180])
    expect(rendered.renders.filter((receipt) => receipt.kind === 'field')).toHaveLength(7)
    expect(rendered.renders.some((receipt) => receipt.objectId === id(112) && receipt.kind === 'overlay')).toBe(true)

    const loadingTask = getDocument({ data: new Uint8Array(rendered.bytes), isEvalSupported: false, useSystemFonts: false })
    const document = await loadingTask.promise
    expect(await document.getFieldObjects()).toEqual(null)
    const vectorPage = await document.getPage(1)
    const operators = await vectorPage.getOperatorList()
    expect(operators.fnArray).toContain(OPS.constructPath)
    expect(operators.fnArray).not.toContain(OPS.paintImageXObject)
    expect(operators.fnArray).not.toContain(OPS.paintInlineImageXObject)
    await loadingTask.destroy()
  })

  it('fails before rendering tofu when no bundled Unicode shard covers a glyph', async () => {
    const sourceBytes = await createSupportedPdfFixture()
    let snapshot = await parsePdfSession({
      bytes: sourceBytes,
      artifactId: id(1),
      workspaceId: id(2),
      ownerUserId: userId,
      fileId: id(4),
      originalFileName: 'fictional-form.example.pdf',
      title: 'Fictional PDF form',
    })
    const textField = snapshot.pages.flatMap((page) => page.fields).find((field) => field.kind === 'text')
    if (!textField) throw new Error('Missing fixture text field')
    snapshot = apply(snapshot, { ...base(150), kind: 'setPdfFieldValue', fieldId: textField.id, value: '\u0378' })
    await expect(createPdfWriterPort().render(sourceBytes, snapshot)).rejects.toMatchObject({ code: 'pdf_text_glyph_unsupported' })
  })
})
