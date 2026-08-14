import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import {
  appendOfficeCommand,
  applyDocumentCommand,
  applyOfficeUpdate,
  createOfficeUndoManager,
  documentSuggestionWasApplied,
  documentRangePreimageHash,
  encodeOfficeState,
  ensureDocumentFragment,
  getDocumentFragment,
  snapshotToYDoc,
  yDocToSnapshot,
} from '../collab.js'
import { documentFixture, id } from './fixtures.js'

const mark = (runId: string) => ({ officeRun: { id: runId, style: { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' } } })

function paragraphText(doc: Y.Doc): Y.XmlText {
  const section = getDocumentFragment(doc).get(0)
  if (!(section instanceof Y.XmlElement)) throw new Error('section required')
  const body = section.get(1)
  if (!(body instanceof Y.XmlElement)) throw new Error('body required')
  const paragraph = body.get(0)
  if (!(paragraph instanceof Y.XmlElement)) throw new Error('paragraph required')
  const text = paragraph.get(0)
  if (!(text instanceof Y.XmlText)) throw new Error('text required')
  return text
}

function cloneDoc(source: Y.Doc): Y.Doc {
  const target = new Y.Doc()
  Y.applyUpdate(target, Y.encodeStateAsUpdate(source))
  return target
}

function exchangeBothWays(left: Y.Doc, right: Y.Doc): void {
  const leftUpdate = Y.encodeStateAsUpdate(left, Y.encodeStateVector(right))
  const rightUpdate = Y.encodeStateAsUpdate(right, Y.encodeStateVector(left))
  Y.applyUpdate(left, rightUpdate)
  Y.applyUpdate(right, leftUpdate)
}

describe('[COMP:office/document-collab] Document fragment collaboration', () => {
  it('converges concurrent inserts into the same rich run under either update order', () => {
    const first = snapshotToYDoc(documentFixture())
    const second = cloneDoc(first)
    first.transact(() => paragraphText(first).insert(2, 'LEFT', mark(id(110))), 'manual')
    second.transact(() => paragraphText(second).insert(2, 'RIGHT', mark(id(111))), 'manual')
    const firstUpdate = encodeOfficeState(first)
    const secondUpdate = encodeOfficeState(second)
    const leftFirst = cloneDoc(first)
    const rightFirst = cloneDoc(second)
    applyOfficeUpdate(leftFirst, secondUpdate)
    applyOfficeUpdate(rightFirst, firstUpdate)
    exchangeBothWays(leftFirst, rightFirst)
    expect(yDocToSnapshot(leftFirst)).toEqual(yDocToSnapshot(rightFirst))
    const text = paragraphText(leftFirst).toString()
    expect(text).toContain('LEFT')
    expect(text).toContain('RIGHT')
  })

  it('converges an overlapping insertion and deletion without whole-run replacement', () => {
    const first = snapshotToYDoc(documentFixture())
    const second = cloneDoc(first)
    first.transact(() => paragraphText(first).insert(3, 'new ', mark(id(112))), 'manual')
    second.transact(() => paragraphText(second).delete(2, 4), 'manual')
    exchangeBothWays(first, second)
    expect(yDocToSnapshot(first)).toEqual(yDocToSnapshot(second))
    expect(paragraphText(first).toString()).toContain('new ')
  })

  it('converges text and formatting transactions on the same paragraph', () => {
    const first = snapshotToYDoc(documentFixture())
    const second = cloneDoc(first)
    first.transact(() => paragraphText(first).format(0, 1, { officeRun: { ...mark(id(113)).officeRun, style: { ...mark(id(113)).officeRun.style, bold: true } } }), 'manual')
    second.transact(() => paragraphText(second).insert(1, '!', mark(id(114))), 'manual')
    exchangeBothWays(first, second)
    expect(yDocToSnapshot(first)).toEqual(yDocToSnapshot(second))
    const snapshot = yDocToSnapshot(first)
    if (snapshot.family !== 'document') throw new Error('document required')
    const paragraph = snapshot.sections[0].nodes[0]
    expect(paragraph.kind === 'paragraph' && paragraph.runs.some((run) => run.style.bold)).toBe(true)
    expect(paragraphText(first).toString()).toContain('!')
  })

  it('keeps a remote interleaving when local fragment history is undone and redone', () => {
    const local = snapshotToYDoc(documentFixture())
    const remote = cloneDoc(local)
    const history = createOfficeUndoManager(local)
    local.transact(() => paragraphText(local).insert(0, 'Local ', mark(id(115))), 'manual')
    remote.transact(() => paragraphText(remote).insert(paragraphText(remote).length, ' Remote', mark(id(116))), 'manual')
    exchangeBothWays(local, remote)
    history.undo()
    expect(paragraphText(local).toString()).not.toContain('Local ')
    expect(paragraphText(local).toString()).toContain(' Remote')
    history.redo()
    expect(paragraphText(local).toString()).toContain('Local ')
    expect(paragraphText(local).toString()).toContain(' Remote')
    history.destroy()
  })

  it('tracks offline fragment edits with the same local-only history', () => {
    const doc = snapshotToYDoc(documentFixture())
    const history = createOfficeUndoManager(doc)
    doc.transact(() => paragraphText(doc).insert(0, 'Offline ', mark(id(117))), 'offline')
    history.undo()
    expect(paragraphText(doc).toString()).not.toContain('Offline ')
    history.destroy()
  })

  it('upgrades a legacy base plus command log once and compacts the absorbed log', () => {
    const snapshot = documentFixture()
    const legacy = new Y.Doc()
    legacy.getMap<string>('office').set('baseSnapshot', JSON.stringify(snapshot))
    const command = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user' as const, id: id(40) }, origin: 'manual' as const, commandId: id(118), kind: 'setObjectProperty' as const, targetId: id(6), path: ['alignment'], value: 'center' }
    legacy.getMap<string>('commands').set(command.commandId, JSON.stringify(command))
    legacy.getArray<string>('commandOrder').push([command.commandId])

    const fragment = ensureDocumentFragment(legacy)
    const firstState = Y.encodeStateAsUpdate(legacy)
    expect(fragment.length).toBe(1)
    expect(legacy.getMap('commands').size).toBe(0)
    expect(legacy.getArray('commandOrder').length).toBe(0)
    const materialized = yDocToSnapshot(legacy)
    expect(materialized.family === 'document' && materialized.sections[0].nodes[0]).toMatchObject({ alignment: 'center' })
    ensureDocumentFragment(legacy)
    expect(Y.encodeStateAsUpdate(legacy)).toEqual(firstState)
  })

  it('applies a generated batch atomically and suggestion IDs only once', () => {
    const snapshot = documentFixture()
    const doc = snapshotToYDoc(snapshot)
    const common = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'assistant' as const, id: id(40) }, origin: 'ai' as const }
    const batch = { ...common, commandId: id(119), kind: 'batch' as const, commands: [
      { ...common, commandId: id(120), kind: 'setObjectProperty' as const, targetId: id(6), path: ['alignment'], value: 'center' },
      { ...common, commandId: id(121), kind: 'setObjectProperty' as const, targetId: id(6), path: ['styleName'], value: 'Callout' },
    ] }
    applyDocumentCommand(doc, batch, 'suggestion', id(122))
    const once = encodeOfficeState(doc)
    applyDocumentCommand(doc, batch, 'suggestion', id(122))
    expect(encodeOfficeState(doc)).toEqual(once)
    expect(documentSuggestionWasApplied(doc, id(122))).toBe(true)
    const edited = yDocToSnapshot(doc)
    expect(edited.family === 'document' && edited.sections[0].nodes[0]).toMatchObject({ alignment: 'center', styleName: 'Callout' })
  })

  it('uses real SHA-256 preimages and conflicts before mutating a stale range', () => {
    expect(documentRangePreimageHash('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad')
    const snapshot = documentFixture()
    const doc = snapshotToYDoc(snapshot)
    const command = { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'user' as const, id: id(40) }, origin: 'manual' as const, commandId: id(125), kind: 'replaceTextRange' as const, targetId: id(6), from: 2, to: 10, preimageHash: documentRangePreimageHash('grounded'), runs: [{ id: id(126), text: 'verified', style: { fontFamily: 'Arial', fontSizePt: 11, bold: true, italic: false, underline: false, strike: false, color: '#111111' } }] }
    applyDocumentCommand(doc, command)
    const edited = yDocToSnapshot(doc)
    expect(edited.family === 'document' && edited.sections[0].nodes[0].kind === 'paragraph' && edited.sections[0].nodes[0].runs.map((run) => run.text).join('')).toBe('A verified update.')
    expect(() => applyDocumentCommand(snapshotToYDoc(snapshot), { ...command, preimageHash: '0'.repeat(64) })).toThrow(/preimage changed/)
  })

  it('keeps legacy updateText as generated compatibility without storing a Document command', () => {
    const snapshot = documentFixture()
    const doc = snapshotToYDoc(snapshot)
    appendOfficeCommand(doc, { artifactId: snapshot.artifactId, baseVersion: 0, actor: { type: 'assistant', id: id(40) }, origin: 'ai', commandId: id(123), kind: 'updateText', targetId: id(6), runs: [{ id: id(124), text: 'Generated', style: { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' } }] })
    expect(doc.getMap('commands').size).toBe(0)
    const edited = yDocToSnapshot(doc)
    expect(edited.family === 'document' && edited.sections[0].nodes[0].kind === 'paragraph' && edited.sections[0].nodes[0].runs.map((run) => run.text).join('')).toBe('Generated')
  })
})
