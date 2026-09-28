import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import {
  OfficeArtifactSnapshotSchema,
  PdfSnapshotSchema,
  appendOfficeCommand,
  applyOfficeCommand,
  applyOfficeUpdate,
  canEnablePdfEditingSession,
  collectArtifactText,
  createOfficeUndoManager,
  encodeOfficeState,
  officeSnapshotPreconditionHash,
  pdfEditingCapabilityManifest,
  snapshotToYDoc,
  yDocToSnapshot,
  type OfficeCommand,
  type PdfEditingCapabilityAvailability,
  type PdfSnapshot,
} from '../index.js'

const id = (ordinal: number) => `00000000-0000-4000-8000-${ordinal.toString().padStart(12, '0')}`
const userId = id(900)
const assistantId = id(901)
const pageOneId = id(10)
const pageTwoId = id(20)
const signatureResourceId = id(30)

function pdfFixture(): PdfSnapshot {
  return PdfSnapshotSchema.parse({
    schemaVersion: 1,
    capabilityVersion: 1,
    artifactId: id(1),
    workspaceId: id(2),
    locale: 'en-US',
    defaultLanguage: 'en-US',
    templateVersionId: null,
    rootId: id(3),
    title: 'Private agreement',
    resources: [{
      id: signatureResourceId,
      kind: 'image',
      hash: 'b'.repeat(64),
      mime: 'image/png',
      sensitivity: 'confidential',
    }],
    accessibility: { title: 'Private agreement' },
    family: 'pdf',
    source: {
      fileId: id(4),
      sha256: 'a'.repeat(64),
      byteLength: 2_048,
      originalFileName: 'agreement.example.pdf',
      pageCount: 2,
    },
    pages: [
      {
        id: pageOneId,
        sourcePageIndex: 0,
        mediaBox: { x: 0, y: 0, width: 612, height: 792 },
        cropBox: { x: 0, y: 0, width: 612, height: 792 },
        rotation: 0,
        fields: [
          {
            id: id(100),
            originalName: 'full_name',
            label: 'Full name',
            kind: 'text',
            readOnly: false,
            required: true,
            value: 'Initial value',
            widgets: [{ id: id(101), pageId: pageOneId, rect: { x: 72, y: 650, width: 220, height: 24 } }],
          },
          {
            id: id(102),
            originalName: 'accepted',
            label: 'Accepted',
            kind: 'checkbox',
            readOnly: false,
            required: false,
            value: false,
            widgets: [{ id: id(103), pageId: pageOneId, rect: { x: 72, y: 610, width: 16, height: 16 } }],
          },
          {
            id: id(104),
            originalName: 'plan',
            label: 'Plan',
            kind: 'radio',
            readOnly: false,
            required: true,
            value: 'standard',
            allowedOptions: ['standard', 'pro'],
            widgets: [
              { id: id(105), pageId: pageOneId, rect: { x: 72, y: 570, width: 16, height: 16 } },
              { id: id(106), pageId: pageTwoId, rect: { x: 72, y: 700, width: 16, height: 16 } },
            ],
          },
          {
            id: id(107),
            originalName: 'region',
            label: 'Region',
            kind: 'dropdown',
            readOnly: false,
            required: false,
            value: null,
            allowedOptions: ['north', 'south'],
            widgets: [{ id: id(108), pageId: pageOneId, rect: { x: 72, y: 530, width: 140, height: 22 } }],
          },
          {
            id: id(109),
            originalName: 'topics',
            label: 'Topics',
            kind: 'option-list',
            readOnly: false,
            required: false,
            value: ['one'],
            allowedOptions: ['one', 'two', 'three'],
            widgets: [{ id: id(110), pageId: pageOneId, rect: { x: 72, y: 450, width: 140, height: 60 } }],
          },
        ],
        overlays: [{
          id: id(200),
          pageId: pageOneId,
          kind: 'text',
          rect: { x: 100, y: 300, width: 180, height: 30 },
          rotation: 0,
          zOrder: 0,
          creator: { type: 'user', id: userId },
          text: 'Current annotation',
          appearance: { fontSizePt: 12, color: '#111111', alignment: 'start' },
        }],
        placementTargets: [],
      },
      {
        id: pageTwoId,
        sourcePageIndex: 1,
        mediaBox: { x: 0, y: 0, width: 612, height: 792 },
        cropBox: { x: 0, y: 0, width: 612, height: 792 },
        rotation: 90,
        fields: [{
          id: id(111),
          originalName: 'signature',
          label: 'Signature',
          kind: 'signature',
          readOnly: false,
          required: false,
          value: null,
          widgets: [{ id: id(112), pageId: pageTwoId, rect: { x: 300, y: 100, width: 180, height: 48 } }],
        }],
        overlays: [],
        placementTargets: [{
          id: id(300),
          purpose: 'signature',
          pageId: pageTwoId,
          rect: { x: 300, y: 100, width: 180, height: 48 },
          creatorUserId: userId,
          creationVersion: 0,
        }],
      },
    ],
  })
}

const commandBase = (ordinal: number, actor: 'user' | 'assistant' = 'user') => ({
  commandId: id(500 + ordinal),
  artifactId: id(1),
  baseVersion: 0,
  actor: { type: actor, id: actor === 'user' ? userId : assistantId },
  origin: (actor === 'user' ? 'manual' : 'ai') as 'manual' | 'ai',
})

describe('[COMP:office/pdf-model] canonical PDF model and commands', () => {
  it('admits a strict session snapshot and hashes every source anchor', () => {
    const snapshot = pdfFixture()
    expect(OfficeArtifactSnapshotSchema.parse(snapshot).family).toBe('pdf')
    const changed = { ...snapshot, source: { ...snapshot.source, sha256: 'c'.repeat(64) } }
    expect(officeSnapshotPreconditionHash(changed)).not.toBe(officeSnapshotPreconditionHash(snapshot))
    expect(() => PdfSnapshotSchema.parse({ ...snapshot, unknown: true })).toThrow()
  })

  it('validates all supported field kinds and rejects an invalid batch atomically', () => {
    const snapshot = pdfFixture()
    const commands: OfficeCommand[] = [
      { ...commandBase(1), kind: 'setPdfFieldValue', fieldId: id(100), value: 'Updated name' },
      { ...commandBase(2), kind: 'setPdfFieldValue', fieldId: id(102), value: true },
      { ...commandBase(3), kind: 'setPdfFieldValue', fieldId: id(104), value: 'pro' },
      { ...commandBase(4), kind: 'setPdfFieldValue', fieldId: id(107), value: 'north' },
      { ...commandBase(5), kind: 'setPdfFieldValue', fieldId: id(109), value: ['two', 'three'] },
    ]
    const updated = commands.reduce((current, command) => applyOfficeCommand(current, command) as PdfSnapshot, snapshot)
    expect(updated.pages.flatMap((page) => page.fields).map((field) => field.value)).toEqual(['Updated name', true, 'pro', 'north', ['two', 'three'], null])

    const invalidBatch: OfficeCommand = {
      ...commandBase(6),
      kind: 'batch',
      commands: [
        { ...commandBase(7), kind: 'setPdfFieldValue', fieldId: id(100), value: 'Must not commit' },
        { ...commandBase(8), kind: 'setPdfFieldValue', fieldId: id(104), value: 'invented' },
      ],
    }
    expect(() => applyOfficeCommand(snapshot, invalidBatch)).toThrow('allowed option')
    expect(snapshot.pages[0].fields[0].value).toBe('Initial value')
  })

  it('keeps signatures out of generic overlays and consumes one exact target with approval', () => {
    const snapshot = pdfFixture()
    const genericSignature = {
      ...commandBase(10, 'assistant'),
      kind: 'addPdfOverlay' as const,
      pageId: pageTwoId,
      overlay: {
        id: id(510),
        pageId: pageTwoId,
        kind: 'signature' as const,
        rect: { x: 300, y: 100, width: 180, height: 48 },
        rotation: 0,
        zOrder: 0,
        creator: { type: 'assistant' as const, id: assistantId },
        resourceId: signatureResourceId,
        authorizingUserId: userId,
        approvalReceiptId: id(800),
      },
    }
    expect(() => applyOfficeCommand(snapshot, genericSignature)).toThrow('placePdfSignature')
    expect(() => applyOfficeCommand(snapshot, { ...commandBase(11, 'assistant'), kind: 'placePdfSignature', targetId: id(300), signatureResourceId })).toThrow('approval receipt')

    const signed = applyOfficeCommand(snapshot, {
      ...commandBase(12, 'assistant'),
      kind: 'placePdfSignature',
      targetId: id(300),
      signatureResourceId,
      approvalReceiptId: id(801),
    })
    if (signed.family !== 'pdf') throw new Error('fixture drift')
    expect(signed.pages[1].placementTargets).toEqual([])
    expect(signed.pages[1].overlays).toContainEqual(expect.objectContaining({
      kind: 'signature',
      authorizingUserId: userId,
      approvalReceiptId: id(801),
    }))
    const signatureId = signed.pages[1].overlays[0].id
    expect(() => applyOfficeCommand(signed, { ...commandBase(13, 'assistant'), kind: 'removePdfOverlay', overlayId: signatureId })).toThrow('cannot remove')
    expect(() => applyOfficeCommand(signed, { ...commandBase(14, 'assistant'), kind: 'transformPdfOverlay', overlayId: signatureId, rect: { x: 100, y: 100, width: 100, height: 40 }, rotation: 0 })).toThrow('cannot transform')
    expect(() => applyOfficeCommand(signed, { ...commandBase(15, 'assistant'), kind: 'placePdfSignature', targetId: id(300), signatureResourceId, approvalReceiptId: id(802) })).toThrow('was not found')
  })

  it('applies page operations, preserves at least one page, and rejects out-of-bounds geometry', () => {
    const snapshot = pdfFixture()
    const reordered = applyOfficeCommand(snapshot, { ...commandBase(20), kind: 'reorderPdfPage', pageId: pageTwoId, toIndex: 0 })
    const rotated = applyOfficeCommand(reordered, { ...commandBase(21), kind: 'rotatePdfPage', pageId: pageOneId, rotation: 270 })
    const deleted = applyOfficeCommand(rotated, { ...commandBase(22), kind: 'deletePdfPage', pageId: pageTwoId })
    if (deleted.family !== 'pdf') throw new Error('fixture drift')
    expect(deleted.pages).toHaveLength(1)
    expect(deleted.pages[0]).toMatchObject({ id: pageOneId, rotation: 270 })
    expect(() => applyOfficeCommand(deleted, { ...commandBase(23), kind: 'deletePdfPage', pageId: pageOneId })).toThrow('at least one page')
    expect(() => applyOfficeCommand(snapshot, {
      ...commandBase(24),
      kind: 'addPdfOverlay',
      pageId: pageOneId,
      overlay: {
        id: id(524),
        pageId: pageOneId,
        kind: 'checkmark',
        rect: { x: 600, y: 780, width: 20, height: 20 },
        rotation: 0,
        zOrder: 1,
        creator: { type: 'user', id: userId },
        mark: 'check',
        color: '#111111',
        strokeWidthPt: 2,
      },
    })).toThrow('CropBox')
  })

  it('uses the shared collaboration codec and local Undo for PDF commands', () => {
    const snapshot = pdfFixture()
    const command: OfficeCommand = { ...commandBase(30), kind: 'setPdfFieldValue', fieldId: id(100), value: 'Collaborative value' }
    const writer = snapshotToYDoc(snapshot)
    const history = createOfficeUndoManager(writer)
    appendOfficeCommand(writer, command)
    expect((yDocToSnapshot(writer) as PdfSnapshot).pages[0].fields[0].value).toBe('Collaborative value')
    const reader = new Y.Doc()
    applyOfficeUpdate(reader, encodeOfficeState(writer))
    expect(yDocToSnapshot(reader)).toEqual(yDocToSnapshot(writer))
    history.undo()
    expect(yDocToSnapshot(writer)).toEqual(snapshot)
  })

  it('projects only entered field and text/date overlay content', () => {
    const snapshot = pdfFixture()
    snapshot.pages[0].overlays.push({
      id: id(201),
      pageId: pageOneId,
      kind: 'date',
      rect: { x: 100, y: 250, width: 120, height: 24 },
      rotation: 0,
      zOrder: 1,
      creator: { type: 'user', id: userId },
      date: '2026-09-29',
      appearance: { fontSizePt: 11, color: '#111111', alignment: 'start' },
    })
    const text = collectArtifactText(snapshot).map((fragment) => fragment.text)
    expect(text).toEqual(expect.arrayContaining(['Initial value', 'false', 'standard', 'one', 'Current annotation', '2026-09-29']))
    expect(text).not.toContain(snapshot.title)
    expect(text.join(' ')).not.toContain('Signature')
    expect(text.join(' ')).not.toContain(snapshot.source.sha256)
  })
})

describe('[COMP:office/pdf-model] PDF capability barrier', () => {
  it('declares independent direct and Brian paths without admitting partial builds', () => {
    expect(pdfEditingCapabilityManifest.operations.find((operation) => operation.id === 'pdfSignature')).toMatchObject({
      browserAuthoring: 'manual',
      assistantAuthoring: 'action-only',
    })
    expect(canEnablePdfEditingSession({ canonicalModel: true })).toBe(false)
    const complete = Object.fromEntries([
      'canonicalModel', 'pdfParser', 'browserRenderer', 'serverWriter', 'reopenValidator',
      'sessionStorage', 'expiryCleanup', 'release', 'saveToFiles', 'targetPlanner',
      'signatureApproval', 'editor', 'approvalPreview',
    ].map((slice) => [slice, true])) as PdfEditingCapabilityAvailability
    expect(canEnablePdfEditingSession(complete)).toBe(true)
  })
})
