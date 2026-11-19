import { describe, expect, it, vi } from 'vitest'
import { createOfficeTools } from '../tools.js'
import { id } from './fixtures.js'

/**
 * M4 step 5: the creation barrier (templates/compiler.ts, which imports every
 * family's renderer) loads on the first createOfficeArtifact call, not when the
 * Office tool roster is built. A load failure is an honest refusal before any
 * effect. Spec: docs/architecture/platform/deployment.md -> "Lazy tool implementations".
 */
vi.mock('../templates/compiler.js', () => { throw Object.assign(new Error('fixture: compiler module missing'), { code: 'ERR_MODULE_NOT_FOUND' }) })

const context = { userId: id(80), assistantId: id(81), workspaceId: id(2), sessionId: id(82), appId: 'chat', channelType: 'web', channelId: 'web', abortSignal: new AbortController().signal }

describe('[COMP:office/tools] Office creation barrier loads on first use', () => {
  it('builds the roster without the barrier and refuses creation honestly when it cannot load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const createFromContext = vi.fn()
    const create = vi.fn()
    const tools = createOfficeTools({ port: { createFromContext, create, get: vi.fn(), revise: vi.fn() } })
    const tool = tools.find((t) => t.name === 'createOfficeArtifact')!
    expect(tool.inputSchema).toBeDefined()
    const result = await tool.execute({ family: 'document', outcome: 'Quotation', audience: 'Client', sourceHandles: [], idempotencyKey: 'lazy-barrier-test' }, context as never)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('the Office creation runtime could not be loaded on this server, so nothing was created')
    expect(createFromContext).not.toHaveBeenCalled()
    expect(create).not.toHaveBeenCalled()
  })
})
