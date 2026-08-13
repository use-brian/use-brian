import * as Y from 'yjs'
import { z } from 'zod'
import {
  DocumentFlowNodeSchema,
  DocumentSectionSchema,
  DocumentSnapshotSchema,
  OfficeRichTextRunSchema,
  type DocumentSnapshot,
  type OfficeRichTextRun,
} from './model.js'

/** The one y-prosemirror-compatible fragment used by Office Document. */
export const OFFICE_DOCUMENT_FRAGMENT = 'documentContent'
export const OFFICE_DOCUMENT_FRAGMENT_VERSION = 1
export const OFFICE_DOCUMENT_FRAGMENT_VERSION_KEY = 'documentFragmentVersion'

const OfficeEditorMarkSchema = z.object({
  type: z.literal('officeRun'),
  attrs: OfficeRichTextRunSchema.omit({ text: true }).extend({ href: z.union([z.string().url(), z.null()]).optional() }),
}).strict()

export type OfficeEditorJsonNode = {
  type: string
  attrs?: Record<string, unknown>
  content?: OfficeEditorJsonNode[]
  text?: string
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>
}

const TextNodeSchema: z.ZodType<OfficeEditorJsonNode> = z.object({
  type: z.literal('text'),
  text: z.string().min(1),
  marks: z.array(OfficeEditorMarkSchema).length(1),
}).strict()

const EmptyRunNodeSchema: z.ZodType<OfficeEditorJsonNode> = z.object({
  type: z.literal('officeEmptyRun'),
  attrs: OfficeRichTextRunSchema.omit({ text: true }),
  content: z.array(z.never()).optional(),
}).strict()

const RichContainerContentSchema = z.array(z.union([TextNodeSchema, EmptyRunNodeSchema]))

const RichContainerSchema: z.ZodType<OfficeEditorJsonNode> = z.object({
  type: z.enum(['officeHeader', 'officeFooter', 'officeListItem', 'officeTableCellText']),
  attrs: z.record(z.unknown()),
  content: RichContainerContentSchema,
}).strict()

const FlowNodeSchema: z.ZodType<OfficeEditorJsonNode> = z.lazy(() => z.discriminatedUnion('type', [
  z.object({ type: z.enum(['paragraph', 'heading']), attrs: z.record(z.unknown()), content: RichContainerContentSchema }).strict(),
  z.object({ type: z.literal('officeList'), attrs: z.record(z.unknown()), content: z.array(RichContainerSchema) }).strict(),
  z.object({
    type: z.literal('officeTable'),
    attrs: z.record(z.unknown()),
    content: z.array(z.object({
      type: z.literal('officeTableRow'),
      attrs: z.record(z.unknown()),
      content: z.array(z.object({
        type: z.literal('officeTableCell'),
        attrs: z.record(z.unknown()),
        content: z.array(RichContainerSchema).length(1),
      }).strict()),
    }).strict()),
  }).strict(),
  z.object({ type: z.enum(['officeImage', 'officeChart', 'officeVideo', 'officePageBreak', 'officeSectionBreak']), attrs: z.record(z.unknown()), content: z.array(z.never()).optional() }).strict(),
]))

const SectionNodeSchema: z.ZodType<OfficeEditorJsonNode> = z.object({
  type: z.literal('officeSection'),
  attrs: z.record(z.unknown()),
  content: z.tuple([
    z.object({ type: z.literal('officeHeader'), attrs: z.record(z.unknown()), content: RichContainerContentSchema }).strict(),
    z.object({ type: z.literal('officeBody'), attrs: z.record(z.unknown()), content: z.array(FlowNodeSchema) }).strict(),
    z.object({ type: z.literal('officeFooter'), attrs: z.record(z.unknown()), content: RichContainerContentSchema }).strict(),
  ]),
}).strict()

const EditorDocSchema: z.ZodType<OfficeEditorJsonNode> = z.object({
  type: z.literal('doc'),
  attrs: z.record(z.unknown()),
  content: z.array(SectionNodeSchema).min(1),
}).strict()

function without<T extends Record<string, unknown>, K extends keyof T>(value: T, keys: readonly K[]): Omit<T, K> {
  const copy = { ...value }
  for (const key of keys) delete copy[key]
  return copy
}

function runsToEditor(runs: OfficeRichTextRun[]): OfficeEditorJsonNode[] {
  return runs.map((run) => run.text.length === 0
    ? { type: 'officeEmptyRun', attrs: without(run, ['text']) }
    : { type: 'text', text: run.text, marks: [{ type: 'officeRun', attrs: without(run, ['text']) }] })
}

function runsFromEditor(nodes: OfficeEditorJsonNode[]): OfficeRichTextRun[] {
  return nodes.map((node) => {
    if (node.type === 'officeEmptyRun') return OfficeRichTextRunSchema.parse({ ...node.attrs, text: '' })
    const parsed = TextNodeSchema.parse(node)
    const attrs = { ...parsed.marks![0].attrs }
    if (attrs.href == null) delete attrs.href
    return OfficeRichTextRunSchema.parse({ ...attrs, text: parsed.text })
  })
}

function flowNodeToEditor(node: DocumentSnapshot['sections'][number]['nodes'][number]): OfficeEditorJsonNode {
  if (node.kind === 'paragraph' || node.kind === 'heading') return {
    type: node.kind,
    attrs: without(node, ['kind', 'runs']),
    content: runsToEditor(node.runs),
  }
  if (node.kind === 'list') return {
    type: 'officeList',
    attrs: without(node, ['kind', 'items']),
    content: node.items.map((item) => ({ type: 'officeListItem', attrs: { id: item.id }, content: runsToEditor(item.runs) })),
  }
  if (node.kind === 'table') return {
    type: 'officeTable',
    attrs: without(node, ['kind', 'rows']),
    content: node.rows.map((row) => ({
      type: 'officeTableRow',
      attrs: without(row, ['cells']),
      content: row.cells.map((cell) => ({
        type: 'officeTableCell',
        attrs: without(cell, ['runs']),
        content: [{ type: 'officeTableCellText', attrs: { id: cell.id }, content: runsToEditor(cell.runs) }],
      })),
    })),
  }
  return { type: `office${node.kind[0].toUpperCase()}${node.kind.slice(1)}`, attrs: without(node, ['kind']) }
}

function flowNodeFromEditor(input: OfficeEditorJsonNode): DocumentSnapshot['sections'][number]['nodes'][number] {
  const node = FlowNodeSchema.parse(input)
  if (node.type === 'paragraph' || node.type === 'heading') return DocumentFlowNodeSchema.parse({
    ...node.attrs,
    kind: node.type,
    runs: runsFromEditor(node.content ?? []),
  })
  if (node.type === 'officeList') return DocumentFlowNodeSchema.parse({
    ...node.attrs,
    kind: 'list',
    items: (node.content ?? []).map((item) => ({ id: item.attrs?.id, runs: runsFromEditor(item.content ?? []) })),
  })
  if (node.type === 'officeTable') return DocumentFlowNodeSchema.parse({
    ...node.attrs,
    kind: 'table',
    rows: (node.content ?? []).map((row) => ({
      ...row.attrs,
      cells: (row.content ?? []).map((cell) => ({ ...cell.attrs, runs: runsFromEditor(cell.content?.[0]?.content ?? []) })),
    })),
  })
  const kindByType = {
    officeImage: 'image',
    officeChart: 'chart',
    officeVideo: 'video',
    officePageBreak: 'pageBreak',
    officeSectionBreak: 'sectionBreak',
  } as const
  const kind = kindByType[node.type as keyof typeof kindByType]
  if (!kind) throw new Error(`Unsupported Office editor node: ${node.type}`)
  return DocumentFlowNodeSchema.parse({ ...node.attrs, kind })
}

export function documentSnapshotToEditorJson(snapshot: DocumentSnapshot): OfficeEditorJsonNode {
  const parsed = DocumentSnapshotSchema.parse(snapshot)
  return EditorDocSchema.parse({
    type: 'doc',
    attrs: without(parsed, ['sections']),
    content: parsed.sections.map((section) => ({
      type: 'officeSection',
      attrs: without(section, ['header', 'footer', 'nodes']),
      content: [
        { type: 'officeHeader', attrs: { id: `${section.id}:header` }, content: runsToEditor(section.header) },
        { type: 'officeBody', attrs: { id: `${section.id}:body` }, content: section.nodes.map(flowNodeToEditor) },
        { type: 'officeFooter', attrs: { id: `${section.id}:footer` }, content: runsToEditor(section.footer) },
      ],
    })),
  })
}

export function editorJsonToDocumentSnapshot(input: OfficeEditorJsonNode): DocumentSnapshot {
  const doc = EditorDocSchema.parse(input)
  return DocumentSnapshotSchema.parse({
    ...doc.attrs,
    sections: (doc.content ?? []).map((section) => DocumentSectionSchema.parse({
      ...section.attrs,
      header: runsFromEditor(section.content![0].content ?? []),
      nodes: (section.content![1].content ?? []).map(flowNodeFromEditor),
      footer: runsFromEditor(section.content![2].content ?? []),
    })),
  })
}

function editorNodeToY(node: OfficeEditorJsonNode): Y.XmlElement | Y.XmlText {
  if (node.type === 'text') {
    const parsed = TextNodeSchema.parse(node)
    const text = new Y.XmlText()
    text.insert(0, parsed.text!, { officeRun: parsed.marks![0].attrs ?? {} })
    return text
  }
  const element = new Y.XmlElement(node.type)
  for (const [key, value] of Object.entries(node.attrs ?? {})) element.setAttribute(key, value as never)
  const children = (node.content ?? []).map(editorNodeToY)
  if (children.length > 0) element.insert(0, children)
  return element
}

function yNodeToEditor(node: Y.XmlElement | Y.XmlText | Y.XmlHook): OfficeEditorJsonNode[] {
  if (node instanceof Y.XmlText) return node.toDelta().map((delta: { insert: unknown; attributes?: Record<string, unknown> }) => {
    if (typeof delta.insert !== 'string' || delta.insert.length === 0) throw new Error('Office Document fragment contains invalid text')
    const attributes = delta.attributes ?? {}
    const keys = Object.keys(attributes)
    if (keys.length !== 1 || keys[0] !== 'officeRun') throw new Error('Office Document text requires exactly one officeRun mark')
    const marks = Object.entries(attributes).map(([type, rawAttrs]) => {
      const attrs = Object.fromEntries(Object.entries(rawAttrs as Record<string, unknown>).filter(([, value]) => value != null))
      return { type: type.replace(/--[a-zA-Z0-9+/=]{8}$/, ''), attrs }
    })
    return { type: 'text', text: delta.insert, marks }
  })
  if (!(node instanceof Y.XmlElement)) throw new Error('Office Document fragment contains an unsupported XML hook')
  return [{
    type: node.nodeName,
    ...(Object.keys(node.getAttributes()).length > 0 ? { attrs: node.getAttributes() } : {}),
    content: node.toArray().flatMap((child) => yNodeToEditor(child)),
  }]
}

export function writeDocumentEditorJson(fragment: Y.XmlFragment, input: OfficeEditorJsonNode): void {
  const doc = EditorDocSchema.parse(input)
  if (fragment.length > 0) fragment.delete(0, fragment.length)
  fragment.insert(0, (doc.content ?? []).map(editorNodeToY))
}

export function documentEditorJsonFromFragment(fragment: Y.XmlFragment): OfficeEditorJsonNode {
  return EditorDocSchema.parse({
    type: 'doc',
    attrs: fragment.doc?.getMap<Record<string, unknown>>('office').get('documentMetadata') ?? {},
    content: fragment.toArray().flatMap((node) => yNodeToEditor(node)),
  })
}

export function writeDocumentSnapshotToFragment(fragment: Y.XmlFragment, snapshot: DocumentSnapshot): void {
  const editor = documentSnapshotToEditorJson(snapshot)
  const metadata = editor.attrs ?? {}
  fragment.doc?.getMap<Record<string, unknown>>('office').set('documentMetadata', metadata)
  writeDocumentEditorJson(fragment, editor)
}

export function documentSnapshotFromFragment(fragment: Y.XmlFragment): DocumentSnapshot {
  return editorJsonToDocumentSnapshot(documentEditorJsonFromFragment(fragment))
}
