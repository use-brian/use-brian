import { describe, expect, it, vi } from 'vitest'
import { createOfficeTools, type OfficeToolPort } from '../tools.js'
import { id } from './fixtures.js'

const context = { userId: id(80), assistantId: id(81), workspaceId: id(2), sessionId: id(82), appId: 'chat', channelType: 'web', channelId: 'web', abortSignal: new AbortController().signal }

describe('[COMP:office/tools] Office tools', () => {
  it('creates only a durable shell/job and returns its native editor link', async () => {
    const port: OfficeToolPort = {
      create: vi.fn(async () => ({ artifactId: id(1), jobId: id(90) })),
      get: vi.fn(async () => null),
      revise: vi.fn(async () => null),
    }
    const tools = new Map(createOfficeTools({ port, appOrigin: 'https://app.example.com' }).map((tool) => [tool.name, tool]))
    const result = await tools.get('createOfficeArtifact')!.execute({ family: 'document', outcome: 'Build a report', audience: 'Board', sourceHandles: [], canonicalWebsite: 'https://example.com', companyHasNoWebsite: false, idempotencyKey: 'request-12345678' }, context)
    expect(result.data).toMatchObject({ artifactId: id(1), jobId: id(90), status: 'queued', editorUrl: `https://app.example.com/w/${id(2)}/office/${id(1)}` })
    expect(port.create).toHaveBeenCalledWith(expect.objectContaining({ userId: id(80), assistantId: id(81), workspaceId: id(2) }))
  })

  it('preserves version conflicts and Comment-mode proposals', async () => {
    const port: OfficeToolPort = {
      create: vi.fn(async () => ({ artifactId: id(1), jobId: id(90) })),
      get: vi.fn(async () => ({ artifactId: id(1), family: 'document' as const, title: 'Report', version: 2, lifecycleState: 'active' as const, role: 'comment' as const })),
      revise: vi.fn(async () => ({ jobId: id(91), mode: 'proposal' as const })),
    }
    const tools = new Map(createOfficeTools({ port }).map((tool) => [tool.name, tool]))
    const read = await tools.get('getOfficeArtifact')!.execute({ artifactId: id(1) }, context)
    expect(read.data).toMatchObject({ role: 'comment', version: 2 })
    const revised = await tools.get('reviseOfficeArtifact')!.execute({ artifactId: id(1), instruction: 'Tighten this', targetIds: [], expectedVersion: 2, idempotencyKey: 'revise-12345678' }, context)
    expect(revised.data).toEqual({ jobId: id(91), mode: 'proposal' })
  })
})
