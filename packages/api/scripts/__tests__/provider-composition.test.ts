import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../../..')

describe('[COMP:api/model-resolution] provider composition', () => {
  it('constructs provider-neutral synthesis instead of using a Gemini-key gate', async () => {
    const source = await readFile(resolve(root, 'packages/api/src/boot.ts'), 'utf8')

    expect(source).toContain('const researchSynthesize = createResearchSynthesizer')
    expect(source).toContain('const generateSynthesize: GenerateSynthesizeFn = createGenerateSynthesizer')
    expect(source).not.toContain('const researchSynthesize = env.GEMINI_API_KEY')
    expect(source).not.toContain('const generateSynthesize: GenerateSynthesizeFn | undefined = env.GEMINI_API_KEY')
  })

  it('keeps audio keyed while resolving image and PDF media dynamically', async () => {
    const source = await readFile(resolve(root, 'packages/api/src/boot.ts'), 'utf8')

    expect(source).toContain("preferred === 'openai-codex'")
    expect(source).toContain("mime === 'application/pdf' || mime.startsWith('image/')")
    expect(source).toContain('backend: selectMediaBackend(mime)')
    expect(source).toMatch(/const voiceTranscription = \{[\s\S]*?selectKeyedMediaBackend\(\)/)
  })

  it('wires DashScope into browser exploration and both recording transports', async () => {
    const source = await readFile(resolve(root, 'packages/api/src/boot.ts'), 'utf8')
    const entry = await readFile(resolve(root, 'apps/api/src/index.ts'), 'utf8')

    expect(source).toContain("apiKeyEnvName: 'OPENAI_API_KEY' as const")
    expect(source).toContain('baseUrl: dashscopeBaseUrl')
    expect(source).toContain('useVision: false')
    expect(source).toContain('DASHSCOPE_FILETRANS_MODEL')
    expect(entry).toContain('DASHSCOPE_FILETRANS_MODEL: process.env.DASHSCOPE_FILETRANS_MODEL')
  })
})
