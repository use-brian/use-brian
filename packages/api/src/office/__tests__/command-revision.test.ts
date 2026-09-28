import { describe, expect, it, vi } from 'vitest'
import type { Message } from '@use-brian/core'
import { applyOfficeCommand, PdfSnapshotSchema, type DocumentSnapshot, type PdfSnapshot, type PresentationSnapshot, type SpreadsheetSnapshot } from '@use-brian/office-model'
import { generateAssistantOfficeCommands, officeRevisionFitRepairScope } from '../command-revision.js'

const uid = (n: number) => `38000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const style = { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' }

function provider(payload: unknown, requests: Array<{ systemPrompt?: string; messages?: Message[] }> = []) {
  return {
    requests,
    async *stream(request: { systemPrompt?: string; messages?: Message[] }) {
      requests.push(request)
      yield { type: 'message_start' as const, model: 'test' }
      yield { type: 'text_delta' as const, text: JSON.stringify(payload) }
      yield { type: 'message_end' as const, stopReason: 'end_turn' as const, usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
}

const common = { schemaVersion: 1 as const, capabilityVersion: 1 as const, workspaceId: uid(2), locale: 'en-US', defaultLanguage: 'en-US', templateVersionId: null, resources: [], accessibility: { title: 'Fixture' } }

function document(): DocumentSnapshot {
  return { ...common, artifactId: uid(1), family: 'document', rootId: uid(3), title: 'Fixture', sections: [{ id: uid(10), page: { widthPt: 612, heightPt: 792, marginTopPt: 72, marginRightPt: 72, marginBottomPt: 72, marginLeftPt: 72, orientation: 'portrait' }, header: [], footer: [], showPageNumber: true, nodes: [{ id: uid(11), kind: 'paragraph', styleName: 'Body', alignment: 'start', runs: [{ id: uid(12), text: 'Original', style }] }] }] }
}

function presentation(): PresentationSnapshot {
  return { ...common, artifactId: uid(20), family: 'presentation', rootId: uid(21), title: 'Fixture', slideSize: { widthPt: 960, heightPt: 540 }, themeId: uid(22), masters: [{ id: uid(23), name: 'Master', lockedObjectIds: [uid(27)] }], layouts: [{ id: uid(24), masterId: uid(23), name: 'Layout', placeholderIds: [] }], slides: [{ id: uid(25), title: 'Slide', masterId: uid(23), layoutId: uid(24), notes: [], readingOrder: [uid(26), uid(27)], objects: [{ id: uid(26), kind: 'text', geometry: { xPt: 10, yPt: 10, widthPt: 200, heightPt: 50, rotationDeg: 0 }, locked: false, alignment: 'start', verticalAlignment: 'top', runs: [{ id: uid(28), text: 'Original', style }] }, { id: uid(27), kind: 'shape', geometry: { xPt: 10, yPt: 100, widthPt: 200, heightPt: 50, rotationDeg: 0 }, locked: true, shape: 'rectangle', fill: '#111111', strokeWidthPt: 0, text: [], altText: 'Locked brand bar' }] }] }
}

function spreadsheet(): SpreadsheetSnapshot {
  return { ...common, artifactId: uid(40), family: 'spreadsheet', rootId: uid(41), title: 'Fixture', activeSheetId: uid(42), calculationMode: 'automatic', worksheets: [{ id: uid(42), name: 'Sheet1', visibility: 'visible', cells: [{ id: uid(43), address: 'A1', valueType: 'number', value: 2, style: {}, locked: false }, { id: uid(44), address: 'B1', valueType: 'number', value: null, formula: 'A1*2', calculatedValue: 4, style: {}, locked: false }], merges: [], rowDimensions: [], columnDimensions: [], freeze: { rows: 0, columns: 0 }, images: [], validations: [], conditionalFormats: [], print: { paperSize: 'A4', orientation: 'portrait', fitToWidth: 1, fitToHeight: 1, margins: { leftIn: 0.7, rightIn: 0.7, topIn: 0.75, bottomIn: 0.75, headerIn: 0.3, footerIn: 0.3 }, horizontalCentered: false, verticalCentered: false, showGridLines: false, showHeadings: false } }] }
}

function pdf(): PdfSnapshot {
  return PdfSnapshotSchema.parse({
    ...common,
    artifactId: uid(60),
    family: 'pdf',
    rootId: uid(61),
    title: 'Private agreement',
    resources: [{ id: uid(62), kind: 'image', hash: 'c'.repeat(64), mime: 'image/png', sensitivity: 'confidential' }],
    accessibility: { title: 'Private agreement' },
    source: { fileId: uid(63), sha256: 'b'.repeat(64), byteLength: 2_048, originalFileName: 'private-source.example.pdf', pageCount: 1 },
    pages: [{
      id: uid(64), sourcePageIndex: 0,
      mediaBox: { x: 0, y: 0, width: 612, height: 792 },
      cropBox: { x: 12, y: 18, width: 588, height: 756 }, rotation: 0,
      fields: [{ id: uid(65), originalName: 'full_name', label: 'Full name', kind: 'text', readOnly: false, required: true, value: 'Before', widgets: [{ id: uid(66), pageId: uid(64), rect: { x: 72, y: 650, width: 220, height: 24 } }] }],
      overlays: [
        { id: uid(67), pageId: uid(64), kind: 'text', rect: { x: 90, y: 300, width: 180, height: 30 }, rotation: 0, zOrder: 0, creator: { type: 'user', id: uid(80) }, text: 'Annotation', appearance: { fontSizePt: 12, color: '#111111', alignment: 'start' } },
        { id: uid(68), pageId: uid(64), kind: 'signature', rect: { x: 300, y: 100, width: 180, height: 48 }, rotation: 0, zOrder: 1, creator: { type: 'user', id: uid(80) }, resourceId: uid(62), authorizingUserId: uid(80) },
      ],
      placementTargets: [{ id: uid(69), purpose: 'signature', pageId: uid(64), rect: { x: 300, y: 100, width: 180, height: 48 }, creatorUserId: uid(80), creationVersion: 0 }],
    }],
  })
}

describe('[COMP:office/pdf-tools] target-native PDF command planning', () => {
  it('plans only bounded non-signature commands and exposes no backing bytes, filename, or signature resource', async () => {
    const snapshot = pdf()
    const model = provider({ commands: [
      { kind: 'setPdfFieldValue', fieldId: uid(65), value: 'After' },
      { kind: 'transformPdfOverlay', overlayId: uid(67), rect: { x: 100, y: 310, width: 180, height: 30 }, rotation: 0 },
      { kind: 'rotatePdfPage', pageId: uid(64), rotation: 90 },
    ] })
    const commands = await generateAssistantOfficeCommands({
      provider: model as never, model: 'test', snapshot, baseVersion: 0,
      assistantId: uid(90), targetIds: [uid(64), uid(65), uid(67)], instruction: 'Update these exact targets',
    })
    expect(commands.map((command) => command.kind)).toEqual(['setPdfFieldValue', 'transformPdfOverlay', 'rotatePdfPage'])
    const prompt = String(model.requests[0]?.messages?.[0]?.content)
    expect(prompt).toContain(`"sourceHash":"${'b'.repeat(64)}"`)
    expect(prompt).toContain('Full name')
    expect(prompt).toContain('Annotation')
    expect(prompt).not.toContain('private-source.example.pdf')
    expect(prompt).not.toContain(uid(63))
    expect(prompt).not.toContain(uid(62))
    expect(prompt).not.toContain('appearance streams')
  })

  it('rejects signature overlays as targets and as generic add-overlay commands', async () => {
    const snapshot = pdf()
    await expect(generateAssistantOfficeCommands({
      provider: provider({ commands: [{ kind: 'removePdfOverlay', overlayId: uid(68) }] }) as never,
      model: 'test', snapshot, baseVersion: 0, assistantId: uid(90), targetIds: [uid(68)], instruction: 'Remove this',
    })).rejects.toThrow('signature overlays are not revision targets')
    const signature = provider({ commands: [{
      kind: 'addPdfOverlay', pageId: uid(64),
      overlay: { kind: 'signature', rect: { x: 1, y: 2, width: 100, height: 30 }, rotation: 0, resourceId: uid(62) },
    }] })
    await expect(generateAssistantOfficeCommands({
      provider: signature as never, model: 'test', snapshot, baseVersion: 0,
      assistantId: uid(90), targetIds: [uid(64)], instruction: 'Sign here',
    })).rejects.toThrow()
    expect(signature.requests).toHaveLength(3)
  })

  it('projects bounded PDF targets and refuses no-target or comment-only revisions', async () => {
    const { createOfficeService } = await import('../service.js')
    const snapshot = pdf()
    const createJob = vi.fn(async () => ({ id: uid(95), artifactId: snapshot.artifactId } as never))
    const raiseScope = vi.fn(async () => true)
    let access: { role: 'edit' | 'comment'; canEdit: boolean; canComment: boolean } = { role: 'edit', canEdit: true, canComment: true }
    const service = createOfficeService({
      generationAvailable: () => true,
      createShell: vi.fn(), deleteEmptyShell: vi.fn(),
      getArtifact: async () => ({
        id: snapshot.artifactId, workspaceId: snapshot.workspaceId, family: 'pdf', mode: 'session',
        title: snapshot.title, headVersion: 0, lifecycleState: 'active', sensitivity: 'confidential',
        compartments: [], projectIds: [], expiresAt: new Date('2026-10-01T00:00:00.000Z'),
      } as never),
      resolveAccess: async () => access as never,
      raiseScope, createJob, latestJob: async () => null,
      getSnapshot: async () => ({ snapshot }),
    })
    const projection = await service.get({ userId: uid(80), artifactId: snapshot.artifactId })
    expect(projection).toMatchObject({ family: 'pdf', mode: 'session', sourceHash: 'b'.repeat(64), role: 'edit' })
    expect(projection?.targets).toContainEqual(expect.objectContaining({ id: uid(64), kind: 'pdfPage', pageNumber: 1, rect: snapshot.pages[0]!.cropBox }))
    expect(projection?.targets).toContainEqual(expect.objectContaining({ id: uid(65), kind: 'pdfField:text', value: 'Before' }))
    expect(projection?.targets).toContainEqual(expect.objectContaining({ id: uid(67), kind: 'pdfOverlay:text', rect: snapshot.pages[0]!.overlays[0]!.rect }))
    expect(projection?.targets).toContainEqual(expect.objectContaining({ id: uid(69), kind: 'pdfSignatureTarget' }))
    expect(projection?.targets?.some((target) => target.id === uid(68))).toBe(false)

    const params = {
      userId: uid(80), assistantId: uid(90), artifactId: snapshot.artifactId,
      instruction: 'Update the selected field', expectedVersion: 0,
      idempotencyKey: 'pdf-revision-1', sensitivity: 'internal' as const,
      compartments: [], projectIds: [], compartmentGrant: null, projectGrant: null,
    }
    await expect(service.revise({ ...params, targetIds: [] })).resolves.toBeNull()
    expect(createJob).not.toHaveBeenCalled()
    access = { role: 'comment' as const, canEdit: false, canComment: true }
    await expect(service.revise({ ...params, targetIds: [uid(65)] })).resolves.toBeNull()
    expect(createJob).not.toHaveBeenCalled()
    access = { role: 'edit' as const, canEdit: true, canComment: true }
    await expect(service.revise({ ...params, targetIds: [uid(65)] })).resolves.toEqual({ jobId: uid(95), mode: 'direct' })
    expect(raiseScope).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/office-generation] Brian-native Office command planning', () => {
  it('supplies exact operation payload keys and canonical rich-text guidance', async () => {
    const snapshot = document()
    const model = provider({ commands: [{ kind: 'updateText', targetId: uid(11), runs: [{ id: uid(12), text: 'Revised', style }] }] })
    await generateAssistantOfficeCommands({ provider: model as never, model: 'test', snapshot, baseVersion: 1, assistantId: uid(90), targetIds: [uid(10)], instruction: 'Revise the paragraph' })
    const prompt = model.requests[0]?.systemPrompt ?? ''
    expect(model.requests[0]).toMatchObject({ responseFormat: 'json', maxTokens: 12000 })
    const userMessage = String(model.requests[0]?.messages?.[0]?.content)
    expect(userMessage).toContain(`Existing editable text-container IDs for updateText.targetId:\n["${uid(11)}"]`)
    expect(userMessage).toContain('never a run ID or paragraphStart ID')
    expect(prompt).toContain('Individual header/footer run IDs are not updateText or deleteObject targets')
    const catalogLine = prompt.split('\n').find((line) => line.startsWith('[{"kind":'))
    const catalog = JSON.parse(catalogLine ?? '[]')
    expect(catalog).toHaveLength(24)
    expect(catalog).toContainEqual({ kind: 'appendSpreadsheetRecords', required: ['sheetId', 'tableId', 'records'], optional: ['prototypeRow'] })
    expect(catalog).toContainEqual({ kind: 'updateText', required: ['targetId', 'runs'], optional: [] })
    expect(catalog).toContainEqual({ kind: 'deleteObject', required: ['targetId'], optional: [] })
    expect(catalog).toContainEqual({ kind: 'insertDocumentNode', required: ['sectionId', 'node'], optional: ['index', 'beforeNodeId', 'afterNodeId'] })
    expect(prompt).toContain('Prefer beforeNodeId/afterNodeId')
    expect(catalog).toContainEqual({ kind: 'setSpreadsheetCell', required: ['sheetId', 'cellId', 'address', 'valueType', 'value'], optional: ['formula'] })
    expect(catalog).toContainEqual({ kind: 'setPdfFieldValue', required: ['fieldId', 'value'], optional: [] })
    expect(catalog).toContainEqual({ kind: 'addPdfOverlay', required: ['pageId', 'overlay'], optional: [] })
    expect(prompt).toContain('targetId, never id')
    expect(prompt).toContain('id, text, and style copied from the context')
    expect(prompt).toContain('Never put a bare text field on an operation')
    expect(prompt).toContain('This is a document. Use only updateText, insertDocumentNode, deleteObject, and setObjectProperty.')
    expect(prompt).toContain('Delete a document table row with deleteObject targeting the row ID')
  })

  it('rejects node-shaped edits instead of guessing operation payloads', async () => {
    const model = provider({ commands: [{ kind: 'updateText', id: uid(11), text: 'Revised' }] })
    await expect(generateAssistantOfficeCommands({ provider: model as never, model: 'test', snapshot: document(), baseVersion: 1, assistantId: uid(90), targetIds: [uid(10)], instruction: 'Revise the paragraph' })).rejects.toThrow()
  })

  it('allows a body revision with an untouched small footer but rejects changed small text', async () => {
    const snapshot = document()
    snapshot.sections[0].footer = [{ id: uid(15), text: 'BRAND', style: { ...style, fontSizePt: 7.5 } }]
    const valid = provider({ commands: [{ kind: 'updateText', targetId: uid(11), runs: [{ id: uid(12), text: 'Revised', style }] }] })
    const params = { model: 'test', snapshot, baseVersion: 1, assistantId: uid(90), targetIds: [uid(10)], instruction: 'Revise the paragraph' }
    await expect(generateAssistantOfficeCommands({ ...params, provider: valid as never })).resolves.toHaveLength(1)
    const invalid = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(10), path: ['footer'], value: [{ ...snapshot.sections[0].footer[0], text: 'New tiny text' }] }] })
    await expect(generateAssistantOfficeCommands({ ...params, provider: invalid as never })).rejects.toThrow('readability floor')
  })

  it('hydrates server-owned command authority for document structure', async () => {
    const snapshot = document()
    const model = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(10), path: ['showPageNumber'], value: false }, { kind: 'insertDocumentNode', sectionId: uid(10), index: 1, node: { id: uid(99), kind: 'pageBreak' } }] })
    const commands = await generateAssistantOfficeCommands({ provider: model as never, model: 'test', snapshot, baseVersion: 3, assistantId: uid(90), targetIds: [uid(10)], instruction: '@Brian hide page numbers and insert a page break' })
    expect(commands).toHaveLength(2)
    expect(commands.every((command) => command.actor.type === 'assistant' && command.actor.id === uid(90) && command.origin === 'ai' && command.baseVersion === 3)).toBe(true)
    expect(commands[1]).toMatchObject({ kind: 'insertDocumentNode', sectionId: uid(10), node: { kind: 'pageBreak' } })
    expect(commands[1] && 'node' in commands[1] ? commands[1].node.id : null).not.toBe(uid(99))
    expect(model.requests[0]?.messages?.[0]?.content).not.toContain('@Brian')
  })

  it('requires an explicit section target for page-level document settings', async () => {
    const snapshot = document()
    const paragraphEdit = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(11), path: ['alignment'], value: 'center' }] })
    await expect(generateAssistantOfficeCommands({ provider: paragraphEdit as never, model: 'test', snapshot, baseVersion: 1, assistantId: uid(90), targetIds: [uid(11)], instruction: 'Center this paragraph' })).resolves.toMatchObject([{ kind: 'setObjectProperty', targetId: uid(11) }])

    const pageEscape = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(10), path: ['page', 'marginTopPt'], value: 36 }] })
    await expect(generateAssistantOfficeCommands({ provider: pageEscape as never, model: 'test', snapshot, baseVersion: 1, assistantId: uid(90), targetIds: [uid(11)], instruction: 'Center this paragraph' })).rejects.toThrow('selected target boundary')
  })

  it.each(['beforeNodeId', 'afterNodeId'] as const)('resolves %s against the current section after earlier deletion and insertion', async (location) => {
    const snapshot = document()
    snapshot.sections[0].nodes.push({ id: uid(13), kind: 'heading', level: 1, styleName: 'Heading1', alignment: 'start', runs: [{ id: uid(14), text: 'Signatures', style }] })
    const model = provider({ commands: [
      { kind: 'deleteObject', targetId: uid(11) },
      { kind: 'insertDocumentNode', sectionId: uid(10), beforeNodeId: uid(13), node: { id: uid(97), kind: 'paragraph', alignment: 'start', runs: [{ id: uid(98), text: 'Introduction', style }] } },
      { kind: 'insertDocumentNode', sectionId: uid(10), [location]: uid(13), node: { id: uid(99), kind: 'pageBreak' } },
    ] })
    const commands = await generateAssistantOfficeCommands({ provider: model as never, model: 'test', snapshot, baseVersion: 1, assistantId: uid(90), targetIds: [uid(10)], instruction: 'Place the break next to Signatures after replacing the introduction' })
    expect(commands[2]).toMatchObject({ kind: 'insertDocumentNode', index: location === 'beforeNodeId' ? 1 : 2 })
    expect(commands[2]).not.toHaveProperty(location)
    const result = commands.reduce((state, command) => applyOfficeCommand(state, command) as DocumentSnapshot, snapshot)
    expect(result.sections[0].nodes.map((node) => node.kind)).toEqual(location === 'beforeNodeId' ? ['paragraph', 'pageBreak', 'heading'] : ['paragraph', 'heading', 'pageBreak'])
  })

  it('retries anchored sequential insertions from the original context after render rejection', async () => {
    const snapshot = document()
    const original = structuredClone(snapshot)
    snapshot.sections[0].nodes.push({ id: uid(13), kind: 'heading', level: 1, styleName: 'Heading1', alignment: 'start', runs: [{ id: uid(14), text: 'Signatures', style }] })
    const model = provider({ commands: [
      { kind: 'deleteObject', targetId: uid(11) },
      { kind: 'insertDocumentNode', sectionId: uid(10), beforeNodeId: uid(13), node: { id: uid(97), kind: 'paragraph', alignment: 'start', runs: [{ id: uid(98), text: 'Introduction', style }] } },
      { kind: 'insertDocumentNode', sectionId: uid(10), afterNodeId: uid(13), node: { id: uid(99), kind: 'pageBreak' } },
    ] })
    let renders = 0
    const commands = await generateAssistantOfficeCommands({ ...planParams(snapshot, [uid(10)]), provider: model as never, validateCandidate: async candidate => {
      expect(candidate.family === 'document' && candidate.sections[0].nodes.map(node => node.kind)).toEqual(['paragraph', 'heading', 'pageBreak'])
      if (++renders === 1) throw Error('Rendered candidate rejected')
    } })
    expect(renders).toBe(2)
    expect(model.requests).toHaveLength(2)
    expect(commands[2]).toMatchObject({ kind: 'insertDocumentNode', index: 2 })
    for (const request of model.requests) {
      expect(request).toMatchObject({ responseFormat: 'json' })
      expect(request.systemPrompt).toContain('Prefer beforeNodeId/afterNodeId')
      expect(String(request.messages?.[0]?.content)).toContain('nodePositions')
    }
    expect(String(model.requests[1].messages?.[1]?.content)).toContain('ORIGINAL context')
    expect(snapshot.sections[0].nodes[0]).toEqual(original.sections[0].nodes[0])
    expect(snapshot.sections[0].nodes).toHaveLength(2)
  })

  it('keeps true section indices in a filtered selection context', async () => {
    const snapshot = document()
    snapshot.sections[0].nodes.push({ id: uid(13), kind: 'heading', level: 1, styleName: 'Heading1', alignment: 'start', runs: [{ id: uid(14), text: 'Signatures', style }] })
    const model = provider({ commands: [{ kind: 'insertDocumentNode', sectionId: uid(10), beforeNodeId: uid(13), node: { id: uid(99), kind: 'pageBreak' } }] })
    const commands = await generateAssistantOfficeCommands({ provider: model as never, model: 'test', snapshot, baseVersion: 1, assistantId: uid(90), targetIds: [uid(13)], instruction: 'Insert a page break before Signatures' })
    const context = JSON.parse(String(model.requests[0]?.messages?.[0]?.content).split('Canonical editable context:\n')[1]!)
    expect(context.sections[0].nodePositions).toEqual([{ id: uid(13), index: 1 }])
    expect(context.sections[0].nodes).toHaveLength(1)
    expect(commands[0]).toMatchObject({ index: 1 })
  })

  it.each([
    {},
    { index: 0, beforeNodeId: uid(11) },
    { beforeNodeId: uid(11), afterNodeId: uid(11) },
    { beforeNodeId: uid(12) },
    { beforeNodeId: uid(999) },
    { index: 2 },
  ])('rejects invalid insertion locations without modifying the source: %j', async (location) => {
    const snapshot = document()
    const original = structuredClone(snapshot)
    const model = provider({ commands: [{ kind: 'insertDocumentNode', sectionId: uid(10), ...location, node: { id: uid(99), kind: 'pageBreak' } }] })
    await expect(generateAssistantOfficeCommands({ provider: model as never, model: 'test', snapshot, baseVersion: 1, assistantId: uid(90), targetIds: [uid(10)], instruction: 'Insert a break' })).rejects.toThrow('Office insertion')
    expect(snapshot).toEqual(original)
  })

  it('rejects an anchor deleted by an earlier operation atomically', async () => {
    const snapshot = document()
    const model = provider({ commands: [{ kind: 'deleteObject', targetId: uid(11) }, { kind: 'insertDocumentNode', sectionId: uid(10), beforeNodeId: uid(11), node: { id: uid(99), kind: 'pageBreak' } }] })
    await expect(generateAssistantOfficeCommands({ provider: model as never, model: 'test', snapshot, baseVersion: 1, assistantId: uid(90), targetIds: [uid(10)], instruction: 'Insert a break' })).rejects.toThrow('anchor is not a current flow node')
    expect(snapshot.sections[0].nodes[0].id).toBe(uid(11))
  })

  it('rejects an anchor from another section', async () => {
    const snapshot = document()
    snapshot.sections.push({ ...structuredClone(snapshot.sections[0]), id: uid(20), nodes: [{ id: uid(21), kind: 'paragraph', styleName: 'Body', alignment: 'start', runs: [{ id: uid(22), text: 'Other section', style }] }] })
    const model = provider({ commands: [{ kind: 'insertDocumentNode', sectionId: uid(10), beforeNodeId: uid(21), node: { id: uid(99), kind: 'pageBreak' } }] })
    await expect(generateAssistantOfficeCommands({ provider: model as never, model: 'test', snapshot, baseVersion: 1, assistantId: uid(90), targetIds: [uid(10)], instruction: 'Insert a break' })).rejects.toThrow('anchor is not a current flow node')
  })

  it('allows formatting on a selected presentation object and rejects a locked sibling', async () => {
    const snapshot = presentation()
    const valid = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(26), path: ['geometry', 'xPt'], value: 72 }] })
    await expect(generateAssistantOfficeCommands({ provider: valid as never, model: 'test', snapshot, baseVersion: 1, assistantId: uid(90), targetIds: [uid(26)], instruction: 'Move this right' })).resolves.toMatchObject([{ kind: 'setObjectProperty', targetId: uid(26) }])
    const escaped = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(27), path: ['fill'], value: '#FFFFFF' }] })
    await expect(generateAssistantOfficeCommands({ provider: escaped as never, model: 'test', snapshot, baseVersion: 1, assistantId: uid(90), targetIds: [uid(26)], instruction: 'Make this white' })).rejects.toThrow('locked')
  })

  it('requires explicit theme, master, and layout targets instead of inheriting shared authority from a slide', async () => {
    const snapshot = presentation()
    const theme = provider({ commands: [{ kind: 'setObjectProperty', targetId: snapshot.rootId, path: ['themeId'], value: uid(29) }] })
    await expect(generateAssistantOfficeCommands({ provider: theme as never, model: 'test', snapshot, baseVersion: 1, assistantId: uid(90), targetIds: [snapshot.rootId], instruction: 'Use this theme' })).resolves.toMatchObject([{ kind: 'setObjectProperty', targetId: snapshot.rootId }])
    const master = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(23), path: ['name'], value: 'Updated master' }] })
    await expect(generateAssistantOfficeCommands({ provider: master as never, model: 'test', snapshot, baseVersion: 1, assistantId: uid(90), targetIds: [uid(23)], instruction: 'Rename this master' })).resolves.toMatchObject([{ kind: 'setObjectProperty', targetId: uid(23) }])
    const escaped = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(23), path: ['name'], value: 'Unscoped master edit' }] })
    await expect(generateAssistantOfficeCommands({ provider: escaped as never, model: 'test', snapshot, baseVersion: 1, assistantId: uid(90), targetIds: [uid(25)], instruction: 'Update this slide' })).rejects.toThrow('selected target boundary')
  })

  it('makes formula and formatting edits native while keeping unselected cells bounded', async () => {
    const snapshot = spreadsheet()
    const valid = provider({ commands: [{ kind: 'setSpreadsheetCell', sheetId: uid(42), cellId: uid(44), address: 'B1', valueType: 'number', value: null, formula: 'A1*3' }, { kind: 'setObjectProperty', targetId: uid(44), path: ['style', 'fill'], value: '#ECFDF5' }] })
    const commands = await generateAssistantOfficeCommands({ provider: valid as never, model: 'test', snapshot, baseVersion: 2, assistantId: uid(90), targetIds: [uid(44)], instruction: 'Triple A1 and highlight the result' })
    expect(commands.map((command) => command.kind)).toEqual(['setSpreadsheetCell', 'setObjectProperty'])
    const escaped = provider({ commands: [{ kind: 'setSpreadsheetCell', sheetId: uid(42), cellId: uid(43), address: 'A1', valueType: 'number', value: 9 }] })
    await expect(generateAssistantOfficeCommands({ provider: escaped as never, model: 'test', snapshot, baseVersion: 2, assistantId: uid(90), targetIds: [uid(44)], instruction: 'Change the formula result' })).rejects.toThrow('selected target boundary')
    const bypass = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(44), path: ['formula'], value: 'A1*4' }] })
    await expect(generateAssistantOfficeCommands({ provider: bypass as never, model: 'test', snapshot, baseVersion: 2, assistantId: uid(90), targetIds: [uid(44)], instruction: 'Quadruple A1' })).rejects.toThrow('require setSpreadsheetCell')
  })

  it('rejects protected identity fields and unattached-resource mutations', async () => {
    const snapshot = document()
    const protectedPlan = provider({ commands: [{ kind: 'setObjectProperty', targetId: snapshot.rootId, path: ['workspaceId'], value: uid(99) }] })
    await expect(generateAssistantOfficeCommands({ provider: protectedPlan as never, model: 'test', snapshot, baseVersion: 1, assistantId: uid(90), targetIds: [uid(10)], instruction: 'Move this document' })).rejects.toThrow('protected canonical state')
  })
})

function tableSpreadsheet() {
  const snapshot = spreadsheet(), sheet = snapshot.worksheets[0]!
  sheet.cells[0]!.address = 'A2'
  sheet.cells[1]!.address = 'B2'; sheet.cells[1]!.formula = 'A2*2'
  sheet.tables = [{ id: uid(45), name: 'Records', ref: 'A1:B2', autoFilter: true, columns: [{ id: 1, name: 'Amount' }, { id: 2, name: 'Total' }], style: { name: '', showFirstColumn: false, showLastColumn: false, showRowStripes: true, showColumnStripes: false } }]
  return snapshot
}
const planParams = (snapshot: ReturnType<typeof document> | ReturnType<typeof spreadsheet> | ReturnType<typeof presentation>, targetIds: string[]) => ({ snapshot, baseVersion: 1, assistantId: uid(90), targetIds, instruction: 'Apply requested edit', model: 'test' })

describe('[COMP:office/spreadsheet-tables] revision authority and shared repair budget', () => {
  it('discovers table prototype context and permits only selected table or worksheet append', async () => {
    const snapshot = tableSpreadsheet()
    const append = { kind: 'appendSpreadsheetRecords', sheetId: uid(42), tableId: uid(45), records: [{ '1': { valueType: 'number', value: 3 } }] }
    for (const target of [uid(45), uid(42)]) {
      const model = provider({ commands: [append] })
      const commands = await generateAssistantOfficeCommands({ ...planParams(snapshot, [target]), provider: model as never, validateCandidate: async candidate => {
        expect(candidate.family === 'spreadsheet' && candidate.worksheets[0]!.tables![0]!.ref).toBe('A1:B3')
      } })
      expect(commands[0]?.kind).toBe('appendSpreadsheetRecords')
      expect(JSON.stringify(model.requests[0])).toContain('prototypeCells')
      expect(JSON.stringify(model.requests[0])).toContain('Amount')
    }
    const denied = provider({ commands: [append] })
    await expect(generateAssistantOfficeCommands({ ...planParams(snapshot, [uid(43)]), provider: denied as never })).rejects.toThrow('selected table')
    expect(denied.requests).toHaveLength(3)
    expect(snapshot.worksheets[0]!.tables![0]!.ref).toBe('A1:B2')
  })

  it('rejects identity/address aliases and generic table/header/collection bypasses', async () => {
    const snapshot = tableSpreadsheet()
    for (const op of [
      { kind: 'setSpreadsheetCell', sheetId: uid(42), cellId: uid(43), address: 'B2', valueType: 'number', value: 7 },
      { kind: 'setSpreadsheetCell', sheetId: uid(42), cellId: uid(99), address: 'A1', valueType: 'string', value: 'Different header' },
      { kind: 'setObjectProperty', targetId: uid(45), path: ['ref'], value: 'A1:B3' },
      { kind: 'setObjectProperty', targetId: uid(42), path: ['tables'], value: [] },
      { kind: 'setObjectProperty', targetId: uid(42), path: ['merges'], value: ['A1:B3'] },
    ]) await expect(generateAssistantOfficeCommands({ ...planParams(snapshot, [uid(42)]), provider: provider({ commands: [op] }) as never })).rejects.toThrow()
  })

  it('retries malformed plans, and rejects failed rendered candidates before returning commands', async () => {
    const snapshot = document()
    const broken = provider({ commands: [{ kind: 'notACommand' }] })
    await expect(generateAssistantOfficeCommands({ ...planParams(snapshot, [uid(11)]), provider: broken as never })).rejects.toThrow()
    expect(broken.requests).toHaveLength(3)
    const model = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(11), path: ['alignment'], value: 'center' }] })
    let renders = 0
    await expect(generateAssistantOfficeCommands({ ...planParams(snapshot, [uid(11)]), provider: model as never, validateCandidate: async () => { renders++; throw Error('conversion unavailable') } })).rejects.toThrow('conversion unavailable')
    expect(renders).toBe(3)
    expect(snapshot.sections[0]!.nodes[0]).toMatchObject({ alignment: 'start' })
  })

  it('[COMP:office/fit-repair] emits bounded font repairs as replayable commands within the same three candidates', async () => {
    const snapshot = presentation()
    snapshot.slides[0]!.objects[0]!.geometry.heightPt = 13
    const text = snapshot.slides[0]!.objects[0]!
    if (text.kind !== 'text') throw Error()
    text.runs[0]!.style = { ...text.runs[0]!.style, fontSizePt: 12 }
    const model = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(26), path: ['geometry', 'xPt'], value: 20 }] })
    const { applyOfficeCommand } = await import('@use-brian/office-model')
    const commands = await generateAssistantOfficeCommands({ ...planParams(snapshot, [uid(26)]), provider: model as never, fitRepair: { eligibleTargetIds: [uid(26)], minimumFontSizePt: 8 }, validateCandidate: async candidate => {
      expect(candidate.family === 'presentation' && candidate.slides[0]!.objects[0]).toMatchObject({ runs: [{ text: 'Original', style: { fontSizePt: 11 } }] })
    } })
    expect(model.requests).toHaveLength(1)
    expect(commands).toContainEqual(expect.objectContaining({ kind: 'setObjectProperty', targetId: uid(28), path: ['style', 'fontSizePt'], value: 11 }))
    const replay = commands.reduce((s, c) => applyOfficeCommand(s, c), snapshot as import('@use-brian/office-model').OfficeArtifactSnapshot)
    expect(replay.family).toBe('presentation')
    expect(snapshot.slides[0]!.objects[0]).toMatchObject({ runs: [{ style: { fontSizePt: 12 } }] })
  })
})

it('[COMP:office/fit-repair] exhausts repair candidates without multiplying LLM retries', async () => {
  const snapshot = presentation()
  snapshot.slides[0]!.objects[0]!.geometry.heightPt = 1
  const model = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(26), path: ['geometry', 'xPt'], value: 20 }] })
  let rendered = false
  await expect(generateAssistantOfficeCommands({ ...planParams(snapshot, [uid(26)]), provider: model as never, fitRepair: { eligibleTargetIds: [uid(26)], minimumFontSizePt: 8 }, validateCandidate: async () => { rendered = true } })).rejects.toThrow('failed fit')
  expect(model.requests).toHaveLength(1)
  expect(rendered).toBe(false)
})

it('[COMP:api/office-generation] exposes native tables as semantic getOfficeArtifact targets', async () => {
  const { createOfficeService } = await import('../service.js')
  const snapshot = tableSpreadsheet()
  const service = createOfficeService({
    getArtifact: async () => ({ id: snapshot.artifactId, family: 'spreadsheet', title: snapshot.title, headVersion: 1, lifecycleState: 'active', sensitivity: 'internal', compartments: [], projectIds: [] }),
    resolveAccess: async () => ({ role: 'edit' }), latestJob: async () => null, getSnapshot: async () => ({ snapshot }),
  } as never)
  const result = await service.get({ userId: uid(90), artifactId: snapshot.artifactId })
  expect(result?.targets).toContainEqual(expect.objectContaining({ id: uid(45), kind: 'spreadsheetTable', parentId: uid(42), label: 'Records A1:B2; columns 1:Amount, 2:Total' }))
})


describe('default selection-scoped fit repair', () => {
  it.each(['object', 'slide'] as const)('repairs a selected %s without an instruction prefix or explicit repair option', async selected => {
    const snapshot = presentation()
    const object = snapshot.slides[0].objects[0]
    if (object.kind !== 'text') throw Error('fixture')
    object.geometry.heightPt = 13
    object.runs[0].style = { ...style, fontSizePt: 12 }
    const other = structuredClone(snapshot.slides[0])
    other.id = uid(201); other.readingOrder = [uid(202)]
    other.objects = [{ ...structuredClone(object), id: uid(202), geometry: { ...object.geometry, heightPt: 50 }, runs: [{ ...structuredClone(object.runs[0]), id: uid(203) }] }]
    snapshot.slides.push(other)
    const model = provider({ commands: [{ kind: 'setObjectProperty', targetId: object.id, path: ['geometry', 'xPt'], value: 20 }] })
    const commands = await generateAssistantOfficeCommands({ ...planParams(snapshot, [selected === 'slide' ? uid(25) : object.id]), instruction: 'Move this right and keep it readable', provider: model as never })
    expect(commands).toContainEqual(expect.objectContaining({ targetId: uid(28), path: ['style', 'fontSizePt'], value: 11 }))
    expect(commands.some(command => 'targetId' in command && [uid(202), uid(203), uid(27)].includes(command.targetId))).toBe(false)
    expect(model.requests).toHaveLength(1)
  })

  it('carries inherited small-font readability through repair and a render-gate retry within the shared budget', async () => {
    const snapshot = presentation()
    const object = snapshot.slides[0].objects[0]
    if (object.kind !== 'text') throw Error('fixture')
    object.geometry.heightPt = 13
    object.runs[0].style = { ...style, fontSizePt: 12 }
    snapshot.slides[0].objects.push({ ...structuredClone(object), id: uid(401), geometry: { ...object.geometry, yPt: 200, heightPt: 50 }, runs: [{ id: uid(402), text: 'Inherited brand', style: { ...style, fontSizePt: 7.5 } }] })
    snapshot.slides[0].readingOrder.push(uid(401))
    // First LLM candidate requires one repair (candidate 2); the render gate
    // rejects it. The final LLM plan must fit without another repair attempt.
    const first = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(26), path: ['geometry', 'xPt'], value: 20 }] })
    const last = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(26), path: ['geometry', 'heightPt'], value: 50 }] })
    let calls = 0
    const model = { stream: (request: Parameters<typeof first.stream>[0]) => (++calls === 1 ? first : last).stream(request) }
    let renders = 0
    const commands = await generateAssistantOfficeCommands({ ...planParams(snapshot, [uid(26)]), provider: model as never, validateCandidate: async candidate => {
      expect(candidate.family === 'presentation' && candidate.slides[0].objects[2]).toMatchObject({ runs: [{ text: 'Inherited brand', style: { fontSizePt: 7.5 } }] })
      if (++renders === 1) {
        expect(candidate.family === 'presentation' && candidate.slides[0].objects[0]).toMatchObject({ runs: [{ style: { fontSizePt: 11 } }] })
        throw Error('Render rejected')
      }
    } })
    expect(calls).toBe(2)
    expect(renders).toBe(2)
    expect(String(last.requests[0].messages?.[1]?.content)).toContain('2/3 attempts used')
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({ targetId: uid(26), path: ['geometry', 'heightPt'], value: 50 })
    expect(object.runs[0].style.fontSizePt).toBe(12)
  })

  it('expands a selected section only to its text and excludes other sections', () => {
    const snapshot = document()
    snapshot.sections.push({ ...structuredClone(snapshot.sections[0]), id: uid(301), nodes: [{ ...structuredClone(snapshot.sections[0].nodes[0]), id: uid(302) }] })
    const second = snapshot.sections[1].nodes[0]
    if (second.kind !== 'paragraph') throw Error('fixture')
    second.runs[0].id = uid(303)
    expect(officeRevisionFitRepairScope(snapshot, [uid(10)]).eligibleTargetIds).toEqual([uid(12)])
  })

  it('does not grant global repair authority for a root selection or master-locked text', () => {
    const snapshot = presentation()
    expect(officeRevisionFitRepairScope(snapshot, [snapshot.rootId]).eligibleTargetIds).toEqual([])
    snapshot.masters[0].lockedObjectIds.push(uid(26))
    const scope = officeRevisionFitRepairScope(snapshot, [uid(25)])
    expect(scope.eligibleTargetIds).not.toContain(uid(28))
    expect(scope.lockedTargetIds).toContain(uid(28))
  })

  it('honors immutable template ancestor locks during section-scoped repair', async () => {
    const snapshot = document()
    const scope = officeRevisionFitRepairScope(snapshot, [uid(10)], [uid(11)])
    expect(scope.eligibleTargetIds).toEqual([])
    expect(scope.lockedTargetIds).toContain(uid(12))
    const model = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(12), path: ['style', 'fontSizePt'], value: 9 }] })
    await expect(generateAssistantOfficeCommands({ ...planParams(snapshot, [uid(10)]), lockedTargetIds: [uid(11)], provider: model as never })).rejects.toThrow('locked')
  })

  it('cannot replace a selected owner to bypass an immutable child-run lock', async () => {
    const snapshot = document()
    const model = provider({ commands: [{ kind: 'updateText', targetId: uid(11), runs: [{ id: uid(12), text: 'Changed locked copy', style: { ...style, fontSizePt: 9 } }] }] })
    await expect(generateAssistantOfficeCommands({ ...planParams(snapshot, [uid(10)]), lockedTargetIds: [uid(12)], provider: model as never })).rejects.toThrow('locked content')
  })

  it('retains an explicitly requested smaller readable font without enlarging it', async () => {
    const snapshot = presentation()
    const model = provider({ commands: [{ kind: 'setObjectProperty', targetId: uid(28), path: ['style', 'fontSizePt'], value: 9 }] })
    const commands = await generateAssistantOfficeCommands({ ...planParams(snapshot, [uid(26)]), instruction: 'Make this text 9pt', provider: model as never })
    expect(commands).toHaveLength(1)
    expect(commands[0]).toMatchObject({ targetId: uid(28), value: 9 })
  })
})
