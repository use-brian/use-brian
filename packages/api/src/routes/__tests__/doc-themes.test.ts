import express from 'express'
import request from 'supertest'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DocThemesRouteOptions } from '../doc-themes.js'

vi.mock('../../db/workspace-icon.js', () => ({ getWorkspaceIconPointer: vi.fn() }))
vi.mock('../../db/brand-store.js', () => ({ getBrandStore: () => ({ get: brandGet }) }))
vi.mock('../../doc/theme-generator.js', async (original) => ({
  ...await original<typeof import('../../doc/theme-generator.js')>(),
  generateCustomTheme: vi.fn(),
}))
import { getWorkspaceIconPointer } from '../../db/workspace-icon.js'
import { generateCustomTheme, ThemeGenerationError } from '../../doc/theme-generator.js'
import { ThemeLimitReachedError } from '../../db/doc-themes-store.js'
import { docThemesRoutes } from '../doc-themes.js'
import { buildThemeTokens } from '@use-brian/shared'

const brandGet = vi.fn()
const seed = { name: 'Ocean', primary: '#0088CC', accent: '#00CC88', neutral: '#112233', mood: 'muted' as const }
const generated = { name: seed.name, description: null, seed, tokens: buildThemeTokens(seed), usage: null, model: 'test' }
const getRole = vi.fn()
const create = vi.fn()
const statBlob = vi.fn()
const readBlob = vi.fn()
const forUri = vi.fn()
let opts: DocThemesRouteOptions
function app(userId: string | null = 'user') {
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => { if (userId) req.userId = userId; next() })
  app.use(docThemesRoutes(opts))
  return app
}
const post = (body: object, userId: string | null = 'user') => request(app(userId)).post('/workspaces/ws/doc-themes').send(body)

beforeEach(() => {
  vi.clearAllMocks()
  getRole.mockResolvedValue('member')
  create.mockImplementation(async (input) => ({ ...input, id: 'theme', createdBy: input.userId, createdAt: new Date(), updatedAt: new Date() }))
  vi.mocked(getWorkspaceIconPointer).mockResolvedValue({ iconUrl: 'https://untrusted.example/icon', iconStorageKey: 'ws/icon', iconStorageUri: 'gs://bucket/ws/icon' })
  statBlob.mockResolvedValue({ sizeBytes: 3, mime: 'image/png' })
  readBlob.mockResolvedValue({ bytes: Buffer.from('png'), mime: 'image/png' })
  forUri.mockResolvedValue({ statBlob, readBlob })
  vi.mocked(generateCustomTheme).mockResolvedValue(generated)
  opts = {
    workspaceStore: { getRole } as unknown as DocThemesRouteOptions['workspaceStore'],
    docThemesStore: { create } as unknown as DocThemesRouteOptions['docThemesStore'],
    provider: {} as DocThemesRouteOptions['provider'],
    blobClient: { statBlob, readBlob } as unknown as DocThemesRouteOptions['blobClient'],
    filesResolver: { forUri } as unknown as DocThemesRouteOptions['filesResolver'],
    backgroundModel: 'background',
  }
})

describe('[COMP:doc-themes/route] icon theme creation', () => {
  it.each([undefined, '  make it dark  '])('uses trusted bytes and optional direction %s', async (prompt) => {
    const response = await post({ fromIcon: true, ...(prompt ? { prompt } : {}) })
    expect(response.status).toBe(201)
    expect(forUri).toHaveBeenCalledWith('ws', 'gs://bucket/ws/icon')
    expect(readBlob).toHaveBeenCalledWith('ws/icon')
    expect(generateCustomTheme).toHaveBeenCalledWith(expect.objectContaining({
      image: { mimeType: 'image/png', data: Buffer.from('png').toString('base64') },
      prompt: prompt?.trim() ?? '', model: 'background',
    }))
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws', userId: 'user', tokens: generated.tokens }))
    expect(response.body.theme.prompt).toMatch(/^Derived from workspace icon/)
  })
  it('checks authentication and membership before reading an icon', async () => {
    expect((await post({ fromIcon: true }, null)).status).toBe(401)
    getRole.mockResolvedValue(null)
    expect((await post({ fromIcon: true })).status).toBe(403)
    expect(getWorkspaceIconPointer).not.toHaveBeenCalled()
  })
  it.each([{ fromIcon: false }, { fromIcon: true, fromBrand: true }, { fromIcon: true, iconUrl: 'https://example.com' }, { fromIcon: true, prompt: '' }, { fromIcon: true, prompt: 'x'.repeat(601) }])('rejects invalid request %j', async (body) => {
    expect((await post(body)).status).toBe(400)
    expect(getWorkspaceIconPointer).not.toHaveBeenCalled()
  })
  it('requires an uploaded icon, not the generated landmark fallback', async () => {
    vi.mocked(getWorkspaceIconPointer).mockResolvedValue(null)
    expect((await post({ fromIcon: true })).body.code).toBe('no_workspace_icon')
    expect(generateCustomTheme).not.toHaveBeenCalled()
  })
  it('requires storage and a provider', async () => {
    opts.blobClient = undefined
    expect((await post({ fromIcon: true })).status).toBe(503)
    opts.provider = undefined
    expect((await post({ fromIcon: true })).status).toBe(503)
  })
  it.each([null, { sizeBytes: 6 * 1024 * 1024, mime: 'image/png' }, { sizeBytes: 5, mime: 'image/svg+xml' }, { sizeBytes: 5, mime: 'image/avif' }])('rejects unusable metadata without downloading %j', async (stat) => {
    statBlob.mockResolvedValue(stat)
    expect((await post({ fromIcon: true })).status).toBe(422)
    expect(readBlob).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
  it('handles a deleted blob', async () => {
    readBlob.mockResolvedValue(null)
    expect((await post({ fromIcon: true })).body.code).toBe('unusable_workspace_icon')
  })
  it('does not silently use a text-only custom model or platform fallback', async () => {
    opts.resolveBackgroundRuntime = vi.fn().mockResolvedValue({ supportsVision: false, provider: {}, selector: 'custom' })
    expect((await post({ fromIcon: true })).body.code).toBe('theme_model_no_vision')
    expect(generateCustomTheme).not.toHaveBeenCalled()
  })
  it('uses the workspace vision runtime', async () => {
    const provider = { custom: true }
    opts.resolveBackgroundRuntime = vi.fn().mockResolvedValue({ supportsVision: true, provider, selector: 'custom' })
    expect((await post({ fromIcon: true })).status).toBe(201)
    expect(generateCustomTheme).toHaveBeenCalledWith(expect.objectContaining({ provider, model: 'custom' }))
  })
  it('preserves generation and cap errors', async () => {
    vi.mocked(generateCustomTheme).mockRejectedValueOnce(new ThemeGenerationError())
    expect((await post({ fromIcon: true })).status).toBe(422)
    create.mockRejectedValueOnce(new ThemeLimitReachedError())
    const response = await post({ fromIcon: true })
    expect(response.status).toBe(409)
    expect(response.body.code).toBe('theme_limit_reached')
  })
  it('preserves prompt-only generation without icon reads', async () => {
    expect((await post({ prompt: ' ocean ' })).status).toBe(201)
    expect(generateCustomTheme).toHaveBeenCalledWith(expect.objectContaining({ prompt: 'ocean', image: undefined }))
    expect(getWorkspaceIconPointer).not.toHaveBeenCalled()
  })
  it('preserves provider-free brand generation and missing-brand errors', async () => {
    opts.provider = undefined
    brandGet.mockResolvedValueOnce(null)
    expect((await post({ fromBrand: true })).body.code).toBe('no_approved_brand')
    brandGet.mockResolvedValueOnce({ activeRecord: { naming: { name: 'Ocean' }, colors: [] } })
    expect((await post({ fromBrand: true })).body.code).toBe('no_brand_colors')
    brandGet.mockResolvedValueOnce({ activeRecord: { naming: { name: 'Ocean' }, colors: [{ name: 'Ocean', value: '#0088CC', role: 'primary' }] } })
    expect((await post({ fromBrand: true })).status).toBe(201)
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ seed: expect.objectContaining({ primary: '#0088CC' }) }))
    expect(generateCustomTheme).not.toHaveBeenCalled()
    expect(getWorkspaceIconPointer).not.toHaveBeenCalled()
  })
})
