import { describe, expect, it } from 'vitest'
import {
  OfficeArtifactSnapshotSchema,
  appendOfficeCommand,
  applyOfficeCommand,
  applyOfficeUpdate,
  encodeOfficeState,
  officeCapabilityManifest,
  preflightOfficeCandidate,
  snapshotToYDoc,
  yDocToSnapshot,
  type OfficeArtifactSnapshot,
  type OfficeCommand,
} from '@use-brian/office-model'
import { layoutOfficeArtifact, renderOfficePreviewSvg } from '@use-brian/office-renderer'
import { exportOfficeDocument, importOfficeDocument, reparseOfficeDocument } from '../docx/index.js'
import { exportOfficePresentation, importOfficePresentation, reparseOfficePresentation } from '../pptx/index.js'
import { exportOfficeSpreadsheet, importOfficeSpreadsheet, reparseOfficeSpreadsheet } from '../xlsx/index.js'
import { completeDocumentSnapshot, completePresentationSnapshot, completeSpreadsheetSnapshot, id, resolveFixtureResource } from './fixtures.js'

const actorId = id(98)
const editable = officeCapabilityManifest.capabilities.filter((capability) => capability.disposition === 'editable')
type EditableId = (typeof editable)[number]['id']

const commandBase = (snapshot: OfficeArtifactSnapshot, ordinal: number) => ({
  commandId: id(200 + ordinal),
  artifactId: snapshot.artifactId,
  baseVersion: 1,
  actor: { type: 'user' as const, id: actorId },
  origin: 'offline' as const,
})

function commandFor(capabilityId: EditableId, snapshot: OfficeArtifactSnapshot, ordinal: number): OfficeCommand {
  const base = commandBase(snapshot, ordinal)
  if (snapshot.family === 'document') {
    const section = snapshot.sections[0]
    const paragraph = section.nodes.find((node) => node.id === id(9))!
    if (paragraph.kind !== 'paragraph') throw new Error('Document fixture paragraph missing')
    const commands: Partial<Record<EditableId, OfficeCommand>> = {
      richText: { ...base, kind: 'updateText', targetId: paragraph.id, runs: paragraph.runs.map((run) => ({ ...run, style: { ...run.style, bold: true } })) },
      hyperlink: { ...base, kind: 'updateText', targetId: paragraph.id, runs: paragraph.runs.map((run) => ({ ...run, href: 'https://example.com/updated' })) },
      table: { ...base, kind: 'setObjectProperty', targetId: id(11), path: ['headerRows'], value: 1 },
      image: { ...base, kind: 'setObjectProperty', targetId: id(27), path: ['altText'], value: 'Updated company mark' },
      chart: { ...base, kind: 'setObjectProperty', targetId: id(28), path: ['title'], value: 'Updated revenue' },
      video: { ...base, kind: 'setObjectProperty', targetId: id(43), path: ['altText'], value: 'Updated product demo' },
      namedStyles: { ...base, kind: 'setObjectProperty', targetId: paragraph.id, path: ['styleName'], value: 'Callout' },
      heading: { ...base, kind: 'setObjectProperty', targetId: id(7), path: ['level'], value: 2 },
      nestedList: { ...base, kind: 'setObjectProperty', targetId: id(24), path: ['ordered'], value: false },
      pageSetup: { ...base, kind: 'setObjectProperty', targetId: section.id, path: ['page', 'marginLeftPt'], value: 64 },
      pageBreak: { ...base, kind: 'insertDocumentNode', sectionId: section.id, index: section.nodes.length, node: { id: id(300), kind: 'pageBreak' } },
      sectionBreak: { ...base, kind: 'insertDocumentNode', sectionId: section.id, index: section.nodes.length, node: { id: id(301), kind: 'sectionBreak' } },
      headerFooter: { ...base, kind: 'setObjectProperty', targetId: section.id, path: ['header'], value: section.footer },
      pageNumber: { ...base, kind: 'setObjectProperty', targetId: section.id, path: ['showPageNumber'], value: false },
    }
    const command = commands[capabilityId]
    if (command) return command
  } else if (snapshot.family === 'presentation') {
    const slide = snapshot.slides[0]
    const commands: Partial<Record<EditableId, OfficeCommand>> = {
      richText: { ...base, kind: 'updateText', targetId: id(34), runs: [{ id: id(35), text: 'Updated pitch', style: { fontFamily: 'Arial', fontSizePt: 28, bold: true, italic: false, underline: false, strike: false, color: '#111111' } }] },
      hyperlink: { ...base, kind: 'updateText', targetId: id(34), runs: [{ id: id(35), text: 'Updated pitch', href: 'https://example.com/updated', style: { fontFamily: 'Arial', fontSizePt: 28, bold: true, italic: false, underline: false, strike: false, color: '#111111' } }] },
      table: { ...base, kind: 'setObjectProperty', targetId: id(47), path: ['headerRows'], value: 1 },
      image: { ...base, kind: 'setObjectProperty', targetId: id(39), path: ['altText'], value: 'Updated company mark' },
      chart: { ...base, kind: 'setObjectProperty', targetId: id(46), path: ['title'], value: 'Updated growth' },
      video: { ...base, kind: 'setObjectProperty', targetId: id(51), path: ['altText'], value: 'Updated product demo' },
      theme: { ...base, kind: 'setObjectProperty', targetId: snapshot.rootId, path: ['themeId'], value: id(92) },
      master: { ...base, kind: 'setObjectProperty', targetId: id(30), path: ['name'], value: 'Updated master' },
      layout: { ...base, kind: 'setObjectProperty', targetId: id(31), path: ['name'], value: 'Updated layout' },
      placeholder: { ...base, kind: 'setObjectProperty', targetId: id(31), path: ['placeholderIds'], value: [id(34)] },
      textBox: { ...base, kind: 'setObjectProperty', targetId: id(34), path: ['alignment'], value: 'center' },
      basicShape: { ...base, kind: 'setObjectProperty', targetId: id(36), path: ['fill'], value: '#FFFFFF' },
      connector: { ...base, kind: 'setObjectProperty', targetId: id(38), path: ['stroke'], value: '#111111' },
      zOrder: { ...base, kind: 'setObjectProperty', targetId: slide.id, path: ['readingOrder'], value: [...slide.readingOrder].reverse() },
      speakerNotes: { ...base, kind: 'setObjectProperty', targetId: slide.id, path: ['notes'], value: [{ id: id(33), text: 'Updated notes', style: { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' } }] },
      slideReorder: { ...base, kind: 'reorderSlide', slideId: id(52), index: 0 },
    }
    const command = commands[capabilityId]
    if (command) return command
  } else if (snapshot.family === 'spreadsheet') {
    const sheet = snapshot.worksheets[0]
    const commands: Partial<Record<EditableId, OfficeCommand>> = {
      worksheet: { ...base, kind: 'renameWorksheet', sheetId: sheet.id, name: 'Invoice updated' },
      cellValue: { ...base, kind: 'setSpreadsheetCell', sheetId: sheet.id, cellId: id(74), address: 'A2', valueType: 'number', value: 4 },
      cellFormula: { ...base, kind: 'setSpreadsheetCell', sheetId: sheet.id, cellId: id(76), address: 'C2', valueType: 'number', value: null, formula: 'ROUND(A2*B2,2)' },
      cellStyle: { ...base, kind: 'setObjectProperty', targetId: id(74), path: ['style', 'fill'], value: '#ECFDF5' },
      mergedCell: { ...base, kind: 'setObjectProperty', targetId: sheet.id, path: ['merges'], value: ['A1:C1'] },
      rowColumnDimensions: { ...base, kind: 'setObjectProperty', targetId: sheet.id, path: ['columnDimensions'], value: [{ index: 1, widthChars: 26, hidden: false }] },
      freezePane: { ...base, kind: 'setObjectProperty', targetId: sheet.id, path: ['freeze'], value: { rows: 1, columns: 1 } },
      dataValidation: { ...base, kind: 'setObjectProperty', targetId: sheet.id, path: ['validations'], value: sheet.validations },
      conditionalFormatting: { ...base, kind: 'setObjectProperty', targetId: sheet.id, path: ['conditionalFormats'], value: sheet.conditionalFormats },
      worksheetImage: { ...base, kind: 'setObjectProperty', targetId: id(77), path: ['altText'], value: 'Updated company logo' },
      spreadsheetPrintSetup: { ...base, kind: 'setObjectProperty', targetId: sheet.id, path: ['print', 'horizontalCentered'], value: false },
      spreadsheetPdf: { ...base, kind: 'setObjectProperty', targetId: sheet.id, path: ['print', 'printArea'], value: 'A1:C20' },
    }
    const command = commands[capabilityId]
    if (command) return command
  }
  throw new Error(`No conformance command for ${capabilityId} in ${snapshot.family}`)
}

describe('[COMP:office/capabilities] Matrix-driven Office capability conformance', () => {
  it('maps every editable manifest row to a concrete command fixture', () => {
    expect(editable).toHaveLength(36)
    for (const [ordinal, capability] of editable.entries()) {
      const snapshot = capability.family === 'presentation' ? completePresentationSnapshot() : capability.family === 'spreadsheet' ? completeSpreadsheetSnapshot() : completeDocumentSnapshot()
      expect(() => commandFor(capability.id, snapshot, ordinal)).not.toThrow()
    }
  })

  it.each(editable)('$id covers model, command, collaboration, render, accessibility, and offline replay', (capability) => {
    const source = capability.family === 'presentation' ? completePresentationSnapshot() : capability.family === 'spreadsheet' ? completeSpreadsheetSnapshot() : completeDocumentSnapshot()
    const snapshot = OfficeArtifactSnapshotSchema.parse(source)
    expect(preflightOfficeCandidate(snapshot).ok).toBe(true)
    if (!capability.implementation) throw new Error(`Editable capability ${capability.id} has no implementation map`)
    expect(Object.values(capability.implementation).every(Boolean)).toBe(true)

    const command = commandFor(capability.id, snapshot, editable.indexOf(capability))
    expect(command.origin).toBe('offline')
    const applied = applyOfficeCommand(snapshot, command)
    expect(preflightOfficeCandidate(applied).diagnostics.filter((diagnostic) => diagnostic.severity === 'error')).toEqual([])

    const writer = snapshotToYDoc(snapshot)
    const reader = snapshotToYDoc(snapshot)
    appendOfficeCommand(writer, command)
    applyOfficeUpdate(reader, encodeOfficeState(writer))
    expect(yDocToSnapshot(writer)).toEqual(applied)
    expect(yDocToSnapshot(reader)).toEqual(applied)

    const layout = layoutOfficeArtifact(applied)
    expect(layout.pages.length).toBeGreaterThan(0)
    expect(renderOfficePreviewSvg(layout.pages[0])).toContain('role="img"')
  })

  it('round-trips the complete Document, Presentation, and Spreadsheet fixtures through export, import, and reparse', async () => {
    const document = completeDocumentSnapshot()
    const docx = await exportOfficeDocument(document, resolveFixtureResource)
    const importedDocument = await importOfficeDocument(docx.bytes, { artifactId: document.artifactId, workspaceId: document.workspaceId, templateVersionId: document.templateVersionId, locale: document.locale, defaultLanguage: document.defaultLanguage, title: document.title })
    expect(importedDocument.snapshot).toEqual(document)
    expect((await reparseOfficeDocument(docx.bytes)).snapshot).toEqual(document)

    const presentation = completePresentationSnapshot()
    const pptx = await exportOfficePresentation(presentation, resolveFixtureResource)
    const importedPresentation = await importOfficePresentation(pptx.bytes, { artifactId: presentation.artifactId, workspaceId: presentation.workspaceId, templateVersionId: presentation.templateVersionId, locale: presentation.locale, defaultLanguage: presentation.defaultLanguage, title: presentation.title })
    expect(importedPresentation.snapshot).toEqual(presentation)
    expect((await reparseOfficePresentation(pptx.bytes)).snapshot).toEqual(presentation)

    const spreadsheet = completeSpreadsheetSnapshot()
    const xlsx = await exportOfficeSpreadsheet(spreadsheet, resolveFixtureResource)
    const importedSpreadsheet = await importOfficeSpreadsheet(xlsx.bytes, { artifactId: spreadsheet.artifactId, workspaceId: spreadsheet.workspaceId, templateVersionId: spreadsheet.templateVersionId, locale: spreadsheet.locale, defaultLanguage: spreadsheet.defaultLanguage, title: spreadsheet.title })
    expect(importedSpreadsheet.snapshot).toEqual(spreadsheet)
    expect((await reparseOfficeSpreadsheet(xlsx.bytes)).snapshot).toEqual(spreadsheet)
  })

  it('lays out 100-page and 100-slide fixtures within a bounded test budget', () => {
    const document = completeDocumentSnapshot()
    document.sections[0].nodes = Array.from({ length: 100 }, (_, index) => ({ id: id(400 + index), kind: 'pageBreak' as const }))
    const presentation = completePresentationSnapshot()
    presentation.slides = Array.from({ length: 100 }, (_, index) => ({ ...presentation.slides[1], id: id(600 + index), title: `Slide ${index + 1}` }))
    const started = performance.now()
    expect(layoutOfficeArtifact(document).pages).toHaveLength(101)
    expect(layoutOfficeArtifact(presentation).pages).toHaveLength(100)
    expect(performance.now() - started).toBeLessThan(5_000)
  })

  it('rejects prototype-polluting property commands before mutation', () => {
    const snapshot = completeDocumentSnapshot()
    const command = { ...commandBase(snapshot, 99), kind: 'setObjectProperty' as const, targetId: snapshot.rootId, path: ['constructor'], value: { polluted: true } }
    expect(() => applyOfficeCommand(snapshot, command)).toThrow('Unsafe property path')
    expect(({} as { polluted?: boolean }).polluted).toBeUndefined()
  })
})
