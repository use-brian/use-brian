import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'
import type { DocumentSnapshot } from '@use-brian/office-model'
import { applyDocumentCommand, getDocumentFragment, yDocToSnapshot } from '@use-brian/office-model'
import { parseSyncDocumentName } from '../document-router.js'
import { loadOfficeUpdate, officeSnapshotUpdate, replaceLiveOfficeSnapshot, storeOfficeSnapshot } from '../office-collab.js'
import type { SysQuery } from '../persistence.js'

const id = (suffix: number): string => `00000000-0000-4000-8000-${suffix.toString().padStart(12, '0')}`
const snapshot: DocumentSnapshot = {
  schemaVersion: 1,
  capabilityVersion: 1,
  artifactId: id(1),
  workspaceId: id(2),
  family: 'document',
  locale: 'en-US',
  defaultLanguage: 'en-US',
  templateVersionId: id(3),
  rootId: id(4),
  title: 'Shared doc',
  resources: [],
  accessibility: { title: 'Shared doc' },
  sections: [{ id: id(5), page: { widthPt: 612, heightPt: 792, marginTopPt: 72, marginRightPt: 72, marginBottomPt: 72, marginLeftPt: 72, orientation: 'portrait' }, header: [], footer: [], showPageNumber: true, nodes: [] }],
}

describe('[COMP:doc-sync/office-collab] Generic Office collaboration routing', () => {
  it('keeps historical bare page names and recognizes explicit namespaces', () => {
    expect(parseSyncDocumentName('page-id')).toEqual({ kind: 'page', id: 'page-id', legacyBareName: true })
    expect(parseSyncDocumentName('page:page-id')).toEqual({ kind: 'page', id: 'page-id', legacyBareName: false })
    expect(parseSyncDocumentName(`office:${id(1)}`)).toEqual({ kind: 'office', id: id(1), legacyBareName: false })
    expect(() => parseSyncDocumentName('unknown:id')).toThrow(/unsupported/)
  })

  it('loads stored Office state as Yjs update bytes', async () => {
    const bytes = Buffer.from(officeSnapshotUpdate(snapshot))
    const query: SysQuery = async () => [{ ydoc: bytes }] as never[]
    expect(await loadOfficeUpdate({ artifactId: snapshot.artifactId, query })).toEqual(new Uint8Array(bytes))
  })

  it('persists one deterministic canonical hash and state vector', async () => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, officeSnapshotUpdate(snapshot))
    const calls: { sql: string; params: unknown[] }[] = []
    const query: SysQuery = async (sql, params) => {
      calls.push({ sql, params })
      return [{ baseVersion: 4 }] as never[]
    }
    const receipt = await storeOfficeSnapshot({ artifactId: snapshot.artifactId, ydoc: doc, query })
    expect(receipt.snapshot).toEqual(snapshot)
    expect(receipt.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(receipt.baseVersion).toBe(4)
    expect(calls).toHaveLength(1)
    expect(calls[0].sql).toContain('office_collab_documents.seq + 1')
    expect(calls[0].sql).toContain('a.head_version')
    expect(calls[0].params[2]).toBeInstanceOf(Buffer)
    expect(calls[0].params[3]).toBeInstanceOf(Buffer)
  })

  it('persists fragment edits as the exact canonical Document snapshot', async () => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, officeSnapshotUpdate(snapshot))
    const section = getDocumentFragment(doc).get(0)
    if (!(section instanceof Y.XmlElement)) throw new Error('section required')
    const body = section.get(1)
    if (!(body instanceof Y.XmlElement)) throw new Error('body required')
    const paragraph = new Y.XmlElement('paragraph')
    paragraph.setAttribute('id', id(8))
    paragraph.setAttribute('styleName', 'Body')
    paragraph.setAttribute('alignment', 'start')
    const text = new Y.XmlText()
    text.insert(0, 'Persisted characters', { officeRun: { id: id(9), style: { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' } } })
    paragraph.insert(0, [text])
    doc.transact(() => body.insert(0, [paragraph]), 'manual')
    const calls: { params: unknown[] }[] = []
    const query: SysQuery = async (_sql, params) => { calls.push({ params }); return [{ baseVersion: 5 }] as never[] }

    const stored = await storeOfficeSnapshot({ artifactId: snapshot.artifactId, ydoc: doc, query })

    expect(stored.snapshot).toEqual(yDocToSnapshot(doc))
    expect(stored.snapshot.family === 'document' && stored.snapshot.sections[0].nodes[0]).toMatchObject({ kind: 'paragraph' })
    expect(stored.hash).toMatch(/^[a-f0-9]{64}$/)
    expect(calls[0].params[2]).toEqual(Buffer.from(Y.encodeStateAsUpdate(doc)))
  })

  it('broadcasts an accepted generated batch to every connected state-vector peer', () => {
    const authoritative = new Y.Doc()
    Y.applyUpdate(authoritative, officeSnapshotUpdate(snapshot))
    const firstClient = new Y.Doc()
    const secondClient = new Y.Doc()
    Y.applyUpdate(firstClient, Y.encodeStateAsUpdate(authoritative))
    Y.applyUpdate(secondClient, Y.encodeStateAsUpdate(authoritative))
    applyDocumentCommand(authoritative, {
      artifactId: snapshot.artifactId,
      baseVersion: 0,
      actor: { type: 'assistant', id: id(20) },
      origin: 'ai',
      commandId: id(21),
      kind: 'insertDocumentNode',
      sectionId: id(5),
      index: 0,
      node: { id: id(22), kind: 'paragraph', styleName: 'Body', alignment: 'start', runs: [{ id: id(23), text: 'Accepted once', style: { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' } }] },
    }, 'suggestion', id(24))
    Y.applyUpdate(firstClient, Y.encodeStateAsUpdate(authoritative, Y.encodeStateVector(firstClient)))
    Y.applyUpdate(secondClient, Y.encodeStateAsUpdate(authoritative, Y.encodeStateVector(secondClient)))
    expect(yDocToSnapshot(firstClient)).toEqual(yDocToSnapshot(authoritative))
    expect(yDocToSnapshot(secondClient)).toEqual(yDocToSnapshot(authoritative))
  })

  it('rejects a snapshot whose canonical artifact id does not match the route', async () => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, officeSnapshotUpdate(snapshot))
    const query: SysQuery = async () => [] as never[]
    await expect(storeOfficeSnapshot({ artifactId: id(99), ydoc: doc, query })).rejects.toThrow(/artifact mismatch/)
  })

  it('replaces the authoritative live document without merging stale base content', () => {
    const doc = new Y.Doc()
    Y.applyUpdate(doc, officeSnapshotUpdate(snapshot))
    const revised = { ...snapshot, title: 'Revised live title' }
    expect(replaceLiveOfficeSnapshot(doc, revised)).toEqual(revised)
    expect(replaceLiveOfficeSnapshot(doc, revised)).toEqual(revised)
  })
})
