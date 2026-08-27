import { describe, expect, it, vi } from 'vitest'
import { createOfficeTools, type OfficeToolPort } from '../tools.js'
import { id } from './fixtures.js'

/**
 * Every family currently clears the admission barrier, so the "creation is
 * switched off" branch is only reachable with the barrier forced shut. The
 * mock delegates to the real compiler unless a test flips the flag — the
 * other suites in this file see the genuine behaviour.
 */
const barrier = vi.hoisted(() => ({ creationEnabled: true }))
vi.mock('../templates/compiler.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../templates/compiler.js')>()
  return {
    ...actual,
    canEnableOfficeCreation: (family: Parameters<typeof actual.canEnableOfficeCreation>[0]) =>
      barrier.creationEnabled && actual.canEnableOfficeCreation(family),
  }
})

const context = { userId: id(80), assistantId: id(81), workspaceId: id(2), sessionId: id(82), appId: 'chat', channelType: 'web', channelId: 'web', abortSignal: new AbortController().signal }

describe('[COMP:office/tools] Office tools', () => {
  it('creates only a durable shell/job and returns its native editor link', async () => {
    const port: OfficeToolPort = {
      create: vi.fn(async () => ({ artifactId: id(1), jobId: id(90) })),
      get: vi.fn(async () => null),
      revise: vi.fn(async () => null),
    }
    const tools = new Map(createOfficeTools({ port, appOrigin: 'https://app.example.com' }).map((tool) => [tool.name, tool]))
    const result = await tools.get('createOfficeArtifact')!.execute({ family: 'document', outcome: 'Build a report', audience: 'Board', additionalContext: 'Use the figures at https://reports.example.com/q2', sourceHandles: [], idempotencyKey: 'request-12345678' }, context)
    expect(result.data).toMatchObject({ artifactId: id(1), jobId: id(90), status: 'queued', editorUrl: `https://app.example.com/w/${id(2)}/office/${id(1)}` })
    expect(port.create).toHaveBeenCalledWith(expect.objectContaining({ userId: id(80), assistantId: id(81), workspaceId: id(2), additionalContext: 'Use the figures at https://reports.example.com/q2' }))
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
    const revised = await tools.get('reviseOfficeArtifact')!.execute({ artifactId: id(1), instruction: 'Tighten this', targetIds: [id(9)], expectedVersion: 2, idempotencyKey: 'revise-12345678' }, context)
    expect(revised.data).toEqual({ jobId: id(91), mode: 'proposal' })
  })

  it('forwards semantic target pagination for large artifacts', async () => {
    const port: OfficeToolPort = {
      create: vi.fn(async () => ({ artifactId: id(1), jobId: id(90) })),
      get: vi.fn(async () => ({ artifactId: id(1), family: 'spreadsheet' as const, title: 'Ledger', version: 2, lifecycleState: 'active' as const, role: 'edit' as const, targets: [], targetsTruncated: false })),
      revise: vi.fn(async () => null),
    }
    const tools = new Map(createOfficeTools({ port }).map((tool) => [tool.name, tool]))
    await tools.get('getOfficeArtifact')!.execute({ artifactId: id(1), targetOffset: 1_000 }, context)
    expect(port.get).toHaveBeenCalledWith({
      userId: id(80),
      artifactId: id(1),
      targetOffset: 1_000,
      clearance: undefined,
      compartmentGrant: null,
      projectGrant: null,
    })
  })
})

/**
 * Failure copy: every `isError` result is TEXT whose first sentence names the
 * operation and its target, then the diagnosis, the next call, and the retry
 * verdict. A version conflict used to be the object
 * `{ code: 'version_conflict', message }` — JSON the model had to parse to
 * read one sentence, and which never carried the version it actually failed
 * against. docs/architecture/engine/tool-executor.md → "Failure copy".
 */
describe('[COMP:office/tools] Office failure copy', () => {
  const port = (over: Partial<OfficeToolPort> = {}): OfficeToolPort => ({
    create: vi.fn(async () => ({ artifactId: id(1), jobId: id(90) })),
    get: vi.fn(async () => null),
    revise: vi.fn(async () => null),
    ...over,
  })

  it('renders a version conflict as text carrying the rejected version and the re-read step', async () => {
    const tools = new Map(
      createOfficeTools({ port: port({ revise: vi.fn(async () => 'version_conflict' as const) }) }).map((tool) => [tool.name, tool]),
    )
    const res = await tools.get('reviseOfficeArtifact')!.execute(
      { artifactId: id(1), instruction: 'Tighten this', targetIds: [id(9)], expectedVersion: 2, idempotencyKey: 'revise-12345678' },
      context,
    )
    expect(res.isError).toBe(true)
    expect(typeof res.data).toBe('string')
    const text = res.data as string
    expect(text).toContain(`reviseOfficeArtifact did not start a revision of artifact ${id(1)}`)
    // The load-bearing detail the old object dropped: which version was stale.
    expect(text).toContain('expectedVersion 2')
    expect(text).toContain('version_conflict')
    expect(text).toContain('Nothing was changed and no job was queued.')
    expect(text).toContain('getOfficeArtifact')
    expect(text).toMatch(/will\s+conflict again/)
  })

  it('names the id and the discovery route when an artifact is unreachable', async () => {
    const tools = new Map(createOfficeTools({ port: port() }).map((tool) => [tool.name, tool]))
    const read = await tools.get('getOfficeArtifact')!.execute({ artifactId: id(1) }, context)
    expect(read.isError).toBe(true)
    expect(read.data as string).toContain(`could not read Office artifact ${id(1)}`)
    expect(read.data as string).toContain('not eligible')
    expect(read.data as string).toContain('Do NOT retry this exact id.')

    const revise = await tools.get('reviseOfficeArtifact')!.execute(
      { artifactId: id(1), instruction: 'Tighten this', targetIds: [id(9)], expectedVersion: 2, idempotencyKey: 'revise-12345678' },
      context,
    )
    expect(revise.isError).toBe(true)
    // A miss on the write path must also say the write did not happen.
    expect(revise.data as string).toContain('Nothing was changed and no job was queued.')
  })

  it('says an unbuilt family is a build-state limit, not an argument problem', async () => {
    const p = port()
    const tools = new Map(createOfficeTools({ port: p }).map((tool) => [tool.name, tool]))
    barrier.creationEnabled = false
    try {
      const res = await tools.get('createOfficeArtifact')!.execute(
        { family: 'spreadsheet', outcome: 'Model the runway', audience: 'Board', sourceHandles: [], idempotencyKey: 'create-12345678' },
        context,
      )
      expect(res.isError).toBe(true)
      const text = res.data as string
      expect(text).toContain('createOfficeArtifact did not create the spreadsheet')
      expect(text).toContain('Nothing was created.')
      // The verdict must stop the model rewriting its arguments — no argument
      // clears a barrier that has not shipped.
      expect(text).toContain('not a problem with the arguments')
      expect(text).toContain('do not retry')
      expect(p.create).not.toHaveBeenCalled()
    } finally {
      barrier.creationEnabled = true
    }
  })
})

/**
 * Office is an `auth_type: 'none'` built-in primitive: the `office` capability
 * grant is its on/off switch, and per-tool allow/ask/block governs whatever
 * remains. See docs/architecture/features/builtin-primitives.md.
 */
describe('[COMP:office/tools] Office governance', () => {
  const port = (): OfficeToolPort => ({
    create: vi.fn(async () => ({ artifactId: id(1), jobId: id(90) })),
    get: vi.fn(async () => ({ artifactId: id(1), family: 'document' as const, title: 'Report', version: 2, lifecycleState: 'active' as const, role: 'edit' as const })),
    revise: vi.fn(async () => ({ jobId: id(91), mode: 'direct' as const })),
  })

  it('tags every tool with requiresCapability so the off switch can gate them', () => {
    const tools = createOfficeTools({ port: port() })
    expect(tools.length).toBeGreaterThan(0)
    for (const tool of tools) {
      expect(tool.requiresCapability, `${tool.name} must be capability-gated`).toBe('office')
    }
  })

  it('refuses a blocked tool at execute time instead of running it', async () => {
    const p = port()
    const tools = new Map(
      createOfficeTools({
        port: p,
        resolvePolicy: async (name) => (name === 'reviseOfficeArtifact' ? 'block' : 'allow'),
      }).map((tool) => [tool.name, tool]),
    )
    const res = await tools.get('reviseOfficeArtifact')!.execute(
      { artifactId: id(1), instruction: 'Tighten this', targetIds: [id(9)], expectedVersion: 2, idempotencyKey: 'revise-12345678' },
      context,
    )
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('blocked by tool policy')
    // The block must happen BEFORE the port is touched — a refusal that still
    // queued the revision would be the write-only control this replaced.
    expect(p.revise).not.toHaveBeenCalled()
  })

  it("resolves 'ask' into a per-call confirmation", async () => {
    const tools = new Map(
      createOfficeTools({
        port: port(),
        resolvePolicy: async (name) => (name === 'createOfficeArtifact' ? 'ask' : 'allow'),
      }).map((tool) => [tool.name, tool]),
    )
    const create = tools.get('createOfficeArtifact')!
    expect(await create.resolveConfirmation!(context as never)).toBe(true)
    expect(await tools.get('getOfficeArtifact')!.resolveConfirmation!(context as never)).toBe(false)
  })

  it('fails OPEN when the policy resolver throws — a policy outage must not take Office down', async () => {
    const p = port()
    const tools = new Map(
      createOfficeTools({
        port: p,
        resolvePolicy: async () => { throw new Error('policy store down') },
      }).map((tool) => [tool.name, tool]),
    )
    const res = await tools.get('getOfficeArtifact')!.execute({ artifactId: id(1) }, context)
    expect(res.isError).toBeFalsy()
    expect(p.get).toHaveBeenCalled()
  })

  it('leaves the static flags alone when no resolver is wired (open default, tests)', async () => {
    const p = port()
    const tools = new Map(createOfficeTools({ port: p }).map((tool) => [tool.name, tool]))
    expect(tools.get('createOfficeArtifact')!.resolveConfirmation).toBeUndefined()
    const res = await tools.get('getOfficeArtifact')!.execute({ artifactId: id(1) }, context)
    expect(res.isError).toBeFalsy()
  })
})
