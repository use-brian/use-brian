import { describe, expect, it } from 'vitest'
import type { Message } from '@use-brian/core'
import type { DocumentSnapshot, PresentationSnapshot, SpreadsheetSnapshot } from '@use-brian/office-model'
import { generateAssistantOfficeCommands } from '../command-revision.js'

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

describe('[COMP:api/office-generation] Brian-native Office command planning', () => {
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
