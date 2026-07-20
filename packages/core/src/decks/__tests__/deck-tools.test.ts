import JSZip from 'jszip'
import { beforeEach, describe, expect, it } from 'vitest'
import type { DeckSpec } from '@use-brian/shared/decks'
import type { FilesApi, FilesContext } from '../../workspace-files/api.js'
import type { WorkspaceFile } from '../../workspace-files/types.js'
import type { ToolContext } from '../../tools/types.js'
import { createDeckTools, DECK_PPTX_MIME, type DeckRecord, type DeckStorePort } from '../tools.js'

const context = {
  userId: 'user-1',
  assistantId: 'assistant-1',
  sessionId: 'session-1',
  appId: 'app-1',
  channelType: 'web',
  channelId: 'chan-1',
  workspaceId: 'ws-1',
} as ToolContext

const THEME_XML = `<a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <a:clrScheme>
    <a:dk1><a:srgbClr val="101418"/></a:dk1><a:lt1><a:srgbClr val="FFFFFF"/></a:lt1>
    <a:accent1><a:srgbClr val="E94560"/></a:accent1><a:accent2><a:srgbClr val="16C79A"/></a:accent2>
    <a:accent3><a:srgbClr val="F0A500"/></a:accent3>
  </a:clrScheme>
  <a:fontScheme><a:majorFont><a:latin typeface="Georgia"/></a:majorFont><a:minorFont><a:latin typeface="Verdana"/></a:minorFont></a:fontScheme>
</a:theme>`

function fakeFile(path: string, sizeBytes: number): WorkspaceFile {
  return {
    id: `id-${path}`,
    path,
    name: path.split('/').pop() ?? path,
    mime: DECK_PPTX_MIME,
    sizeBytes,
  } as unknown as WorkspaceFile
}

function makeFakes() {
  const files = new Map<string, Uint8Array>()
  const filesApi = {
    async writeBytes(_ctx: FilesContext, params: { path: string; bytes: Uint8Array }) {
      if (files.has(params.path)) return { ok: false as const, error: { kind: 'conflict' as const, path: params.path } }
      files.set(params.path, params.bytes)
      return { ok: true as const, value: fakeFile(params.path, params.bytes.length) }
    },
    async readBytes(_ctx: FilesContext, idOrPath: string) {
      const bytes = files.get(idOrPath)
      if (!bytes) return { ok: false as const, error: { kind: 'not_found' as const, reference: idOrPath } }
      return { ok: true as const, value: { file: fakeFile(idOrPath, bytes.length), bytes } }
    },
    async delete(_ctx: FilesContext, idOrPath: string) {
      files.delete(idOrPath)
      return { ok: true as const, value: { id: `id-${idOrPath}`, path: idOrPath } }
    },
  } as unknown as FilesApi

  const rows = new Map<string, DeckRecord>()
  const deckStore: DeckStorePort = {
    async create(ctx, row) {
      const record: DeckRecord = { ...row, workspaceId: ctx.workspaceId, version: 1 }
      rows.set(row.id, record)
      return record
    },
    async get(ctx, deckId) {
      const row = rows.get(deckId)
      return row && row.workspaceId === ctx.workspaceId ? row : null
    },
    async update(ctx, deckId, patch) {
      const row = rows.get(deckId)
      if (!row || row.workspaceId !== ctx.workspaceId) return null
      if (row.version !== patch.expectedVersion) return 'version_conflict'
      const next: DeckRecord = {
        ...row,
        title: patch.title,
        spec: patch.spec,
        style: patch.style,
        styleSource: patch.styleSource,
        version: row.version + 1,
      }
      rows.set(deckId, next)
      return next
    },
  }
  return { files, rows, filesApi, deckStore }
}

const baseSlides: DeckSpec['slides'] = [
  { title: 'Agenda', bullets: ['One', 'Two'] },
  { title: 'Growth', chart: { type: 'bar', labels: ['Q1', 'Q2'], values: [10, 20] } },
]

describe('[COMP:decks/tools] Deck tools', () => {
  let fakes: ReturnType<typeof makeFakes>
  let tools: Map<string, ReturnType<typeof createDeckTools>[number]>

  beforeEach(() => {
    fakes = makeFakes()
    tools = new Map(
      createDeckTools({
        filesApi: fakes.filesApi,
        deckStore: fakes.deckStore,
        appOrigin: 'https://app.example.com',
      }).map((tool) => [tool.name, tool]),
    )
  })

  it('generatePowerpoint writes decks/<id>.pptx and returns the handle', async () => {
    const result = await tools.get('generatePowerpoint')!.execute({ title: 'Board Deck', slides: baseSlides }, context)
    expect(result.isError).toBeFalsy()
    const data = result.data as { deckId: string; path: string; version: number; slideCount: number; previewUrl?: string }
    expect(data.version).toBe(1)
    expect(data.slideCount).toBe(3)
    expect(data.path).toBe(`decks/${data.deckId}.pptx`)
    expect(data.previewUrl).toBe(`https://app.example.com/w/ws-1/decks/${data.deckId}`)
    const bytes = fakes.files.get(data.path)!
    expect(Buffer.from(bytes.subarray(0, 2)).toString('ascii')).toBe('PK')
    expect(fakes.rows.get(data.deckId)?.title).toBe('Board Deck')
  })

  it('generatePowerpoint extracts a style from a reference .pptx in the workspace', async () => {
    const zip = new JSZip()
    zip.file('ppt/theme/theme1.xml', THEME_XML)
    fakes.files.set('uploads/chat/reference.pptx', await zip.generateAsync({ type: 'nodebuffer' }))

    const result = await tools.get('generatePowerpoint')!.execute(
      { title: 'Styled', slides: baseSlides, styleFromFile: 'uploads/chat/reference.pptx' },
      context,
    )
    expect(result.isError).toBeFalsy()
    const data = result.data as { deckId: string; styleSource?: string }
    expect(data.styleSource).toBe('uploads/chat/reference.pptx')
    const row = fakes.rows.get(data.deckId)!
    expect(row.style?.headingFont).toBe('Georgia')
    expect(row.style?.bodyFont).toBe('Verdana')
    expect(row.styleSource).toBe('uploads/chat/reference.pptx')
  })

  it('generatePowerpoint surfaces schema refinements as actionable errors', async () => {
    const result = await tools.get('generatePowerpoint')!.execute(
      { title: 'Bad', slides: [{ title: 'Empty content slide' }] },
      context,
    )
    expect(result.isError).toBe(true)
    expect(String(result.data)).toMatch(/no body/)
  })

  it('updatePowerpoint applies ops, bumps version and rebuilds the same path', async () => {
    const created = await tools.get('generatePowerpoint')!.execute({ title: 'Deck', slides: baseSlides }, context)
    const { deckId, path } = created.data as { deckId: string; path: string }
    const before = fakes.files.get(path)!

    const result = await tools.get('updatePowerpoint')!.execute(
      {
        deckId,
        ops: [
          { op: 'replaceSlide', index: 0, slide: { title: 'Agenda v2', bullets: ['One'] } },
          { op: 'setMeta', title: 'Deck v2' },
        ],
      },
      context,
    )
    expect(result.isError).toBeFalsy()
    const data = result.data as { version: number; path: string }
    expect(data.version).toBe(2)
    expect(data.path).toBe(path) // stable-path contract
    const row = fakes.rows.get(deckId)!
    expect(row.title).toBe('Deck v2')
    expect(row.spec.slides[0].title).toBe('Agenda v2')
    const after = fakes.files.get(path)!
    expect(after).not.toEqual(before) // rebuilt in place
  })

  it('updatePowerpoint enforces expectedVersion and reports missing decks honestly', async () => {
    const created = await tools.get('generatePowerpoint')!.execute({ title: 'Deck', slides: baseSlides }, context)
    const { deckId } = created.data as { deckId: string }

    const conflict = await tools.get('updatePowerpoint')!.execute(
      { deckId, expectedVersion: 7, ops: [{ op: 'deleteSlide', index: 0 }] },
      context,
    )
    expect(conflict.isError).toBe(true)
    expect(String(conflict.data)).toMatch(/version 1, not 7/)

    const missing = await tools.get('updatePowerpoint')!.execute(
      { deckId: '00000000-0000-4000-8000-000000000000', ops: [{ op: 'deleteSlide', index: 0 }] },
      context,
    )
    expect(missing.isError).toBe(true)
    expect(String(missing.data)).toMatch(/not found/)
  })

  it('getPowerpoint returns the current spec for precise edits', async () => {
    const created = await tools.get('generatePowerpoint')!.execute({ title: 'Deck', slides: baseSlides }, context)
    const { deckId } = created.data as { deckId: string }
    const result = await tools.get('getPowerpoint')!.execute({ deckId }, context)
    expect(result.isError).toBeFalsy()
    const data = result.data as { spec: DeckSpec; version: number }
    expect(data.version).toBe(1)
    expect(data.spec.slides).toHaveLength(2)
  })

  it('all three tools refuse without a workspace', async () => {
    const noWs = { ...context, workspaceId: null } as unknown as ToolContext
    for (const name of ['generatePowerpoint', 'updatePowerpoint', 'getPowerpoint']) {
      const input =
        name === 'generatePowerpoint'
          ? { title: 'T', slides: baseSlides }
          : { deckId: '00000000-0000-4000-8000-000000000000', ops: [{ op: 'deleteSlide', index: 0 }] }
      const result = await tools.get(name)!.execute(input, noWs)
      expect(result.isError).toBe(true)
      expect(String(result.data)).toMatch(/workspace/)
    }
  })
})
