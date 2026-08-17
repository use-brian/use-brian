import * as Y from 'yjs'
import { describe, expect, it } from 'vitest'
import {
  documentEditorJsonFromFragment,
  documentSnapshotFromFragment,
  documentSnapshotToEditorJson,
  editorJsonToDocumentSnapshot,
  writeDocumentSnapshotToFragment,
} from '../document-editor-codec.js'
import { documentFixture, id } from './fixtures.js'

function completeDocumentFixture() {
  const snapshot = documentFixture()
  snapshot.resources = [
    { id: id(80), kind: 'image', hash: 'a'.repeat(64), mime: 'image/png', sensitivity: 'internal' },
    { id: id(81), kind: 'video', hash: 'b'.repeat(64), mime: 'video/mp4', sensitivity: 'confidential' },
    { id: id(82), kind: 'image', hash: 'c'.repeat(64), mime: 'image/png', sensitivity: 'internal' },
  ]
  snapshot.accessibility.description = 'A complete codec fixture.'
  snapshot.sections[0] = {
    ...snapshot.sections[0],
    header: [{ id: id(83), text: 'Header', style: { fontFamily: 'Inter', fontSizePt: 9, bold: true, italic: false, underline: false, strike: false, color: '#112233', language: 'en-US' }, href: 'https://example.com/header' }],
    footer: [{ id: id(84), text: '', style: { fontFamily: 'Arial', fontSizePt: 8, bold: false, italic: true, underline: false, strike: false, color: '#445566', highlight: '#FFFF00' } }],
    headerImage: { resourceId: id(80), altText: 'Fictional logo', decorative: false, widthPt: 90, heightPt: 24 },
    headerAlignment: 'center',
    footerAlignment: 'end',
    headerBorderBottom: { color: '#123456', widthPt: 1 },
    footerBorderTop: { color: '#654321', widthPt: 2 },
    nodes: [
      { id: id(85), kind: 'paragraph', styleName: 'Body', alignment: 'justify', spacingBeforePt: 3, spacingAfterPt: 7, lineSpacingPt: 15, runs: [
        { id: id(86), text: 'One ', style: { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: true, strike: false, color: '#111111' } },
        { id: id(87), text: 'link', style: { fontFamily: 'Arial', fontSizePt: 11, bold: true, italic: true, underline: false, strike: true, color: '#222222', highlight: '#EEEE00', language: 'ja-JP' }, href: 'mailto:writer@example.com' },
      ] },
      { id: id(88), kind: 'heading', level: 3, styleName: 'Heading 3', alignment: 'center', spacingBeforePt: 10, spacingAfterPt: 4, lineSpacingPt: 18, runs: [{ id: id(89), text: 'Heading', style: { fontFamily: 'Georgia', fontSizePt: 16, bold: true, italic: false, underline: false, strike: false, color: '#333333' } }] },
      { id: id(90), kind: 'list', ordered: true, level: 4, items: [
        { id: id(91), runs: [{ id: id(92), text: 'Nested one', style: { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' } }] },
        { id: id(93), runs: [{ id: id(94), text: 'Nested two', style: { fontFamily: 'Arial', fontSizePt: 11, bold: false, italic: false, underline: false, strike: false, color: '#111111' } }] },
      ] },
      { id: id(95), kind: 'table', headerRows: 1, columnWidthsPt: [120, 180], widthPt: 300, alignment: 'center', indentPt: 12, layout: 'fixed', margins: { topPt: 2, rightPt: 3, bottomPt: 4, leftPt: 5 }, borders: { insideHorizontal: { color: '#AAAAAA', widthPt: 0.5, style: 'dotted' } }, rows: [
        { id: id(96), minHeightPt: 22, cells: [
          { id: id(97), runs: [{ id: id(98), text: 'Header', style: { fontFamily: 'Arial', fontSizePt: 10, bold: true, italic: false, underline: false, strike: false, color: '#111111' } }], rowSpan: 2, colSpan: 1, fill: '#F0F0F0', alignment: 'center', verticalAlignment: 'middle', margins: { topPt: 1, rightPt: 1, bottomPt: 1, leftPt: 1 }, borders: { right: { color: '#000000', widthPt: 1, style: 'solid' } }, wrapText: false },
          { id: id(99), runs: [{ id: id(100), text: 'Value', style: { fontFamily: 'Arial', fontSizePt: 10, bold: false, italic: false, underline: false, strike: false, color: '#111111' } }], rowSpan: 1, colSpan: 1 },
        ] },
        { id: id(101), cells: [{ id: id(102), runs: [{ id: id(103), text: 'Second', style: { fontFamily: 'Arial', fontSizePt: 10, bold: false, italic: false, underline: false, strike: false, color: '#111111' } }], rowSpan: 1, colSpan: 1 }] },
      ] },
      { id: id(104), kind: 'image', resourceId: id(80), altText: 'A fictional chart screenshot', decorative: false, widthPt: 240, heightPt: 120, crop: { x: 0.1, y: 0.2, width: 0.8, height: 0.7 } },
      { id: id(105), kind: 'chart', chartType: 'bar', title: 'Fictional results', categories: ['A', 'B'], series: [{ name: 'Series', values: [1, 2] }], altText: 'Bar chart of fictional results' },
      { id: id(106), kind: 'video', resourceId: id(81), posterResourceId: id(82), altText: 'Fictional training clip', transcript: 'A safe transcript.', recipientAccessibleUrl: 'https://example.com/video' },
      { id: id(107), kind: 'pageBreak' },
      { id: id(108), kind: 'sectionBreak' },
    ],
  }
  return snapshot
}

describe('[COMP:office/document-editor-codec] Document editor codec', () => {
  it('round-trips every admitted canonical field exactly through editor JSON', () => {
    const snapshot = completeDocumentFixture()
    expect(editorJsonToDocumentSnapshot(documentSnapshotToEditorJson(snapshot))).toEqual(snapshot)
  })

  it('round-trips exactly through a y-prosemirror-compatible XmlFragment', () => {
    const snapshot = completeDocumentFixture()
    const ydoc = new Y.Doc()
    const fragment = ydoc.getXmlFragment('documentContent')
    writeDocumentSnapshotToFragment(fragment, snapshot)
    expect(documentSnapshotFromFragment(fragment)).toEqual(snapshot)
    expect(editorJsonToDocumentSnapshot(documentEditorJsonFromFragment(fragment))).toEqual(snapshot)
  })

  it('fails closed for unknown nodes and marks', () => {
    const editor = documentSnapshotToEditorJson(documentFixture())
    editor.content![0].content![1].content![0].type = 'unsupportedWidget'
    expect(() => editorJsonToDocumentSnapshot(editor)).toThrow()

    const marked = documentSnapshotToEditorJson(documentFixture())
    marked.content![0].content![1].content![0].content![0].marks![0].type = 'bold'
    expect(() => editorJsonToDocumentSnapshot(marked)).toThrow()
  })
})
