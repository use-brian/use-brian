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
  it('passes host context to atomic creation without falling through to legacy creation', async () => {
    const createFromContext = vi.fn(async () => ({artifactId:id(1),jobId:id(90)}))
    const create = vi.fn()
    const tool = createOfficeTools({port:{createFromContext,create,get:vi.fn(),revise:vi.fn()}}).find(t=>t.name==='createOfficeArtifact')!
    expect((await tool.execute({family:'document',outcome:'Quotation',audience:'Client',sourceHandles:[],idempotencyKey:'native-chat-test'},context)).data).toMatchObject({status:'queued'})
    expect(createFromContext).toHaveBeenCalledWith(context,expect.objectContaining({userId:context.userId,workspaceId:context.workspaceId}))
    expect(create).not.toHaveBeenCalled()
  })
  it('discovers a named published template and binds its version when creating from chat', async () => {
    const template = { templateId: id(10), templateVersionId: id(11), name: 'Waterman', description: 'Photography', family: 'document' as const, version: 4 }
    const listTemplates = vi.fn(async () => ({ templates: [template], scopeEvidence: { sensitivity: 'internal' as const, compartments: [], projectIds: [] } }))
    const create = vi.fn(async () => ({ artifactId: id(1), jobId: id(90) }))
    const tools = new Map(createOfficeTools({ port: { listTemplates, create, get: vi.fn(), revise: vi.fn() } }).map(tool => [tool.name, tool]))
    const found = await tools.get('listOfficeTemplates')!.execute({ family: 'document', query: 'Waterman' }, context)
    expect(found.data).toEqual({ templates: [template] })
    expect(found.scopeEvidence).toMatchObject({ sensitivity: 'internal' })
    const result = await tools.get('createOfficeArtifact')!.execute({ family: 'document', outcome: 'Test quotation', audience: 'Client', sourceHandles: [], templateId: template.templateVersionId, idempotencyKey: 'waterman-test-123' }, context)
    expect(result.data).toMatchObject({ artifactId: id(1), status: 'queued' })
    expect(create).toHaveBeenCalledWith(expect.objectContaining({ templateId: id(11), sourceHandles: [] }))
    const blocked = createOfficeTools({ port: { listTemplates, create, get: vi.fn(), revise: vi.fn() }, resolvePolicy: async () => 'block' }).find(tool => tool.name === 'listOfficeTemplates')!
    expect((await blocked.execute({}, context)).isError).toBe(true)
    expect(listTemplates).toHaveBeenCalledTimes(1)
    expect((await tools.get('listOfficeTemplates')!.execute({}, { ...context, workspaceId: undefined })).isError).toBe(true)
    expect(listTemplates).toHaveBeenCalledTimes(1)
  })
  it('explains how to recover an unavailable template binding without claiming creation', async () => {
    const create = vi.fn(async () => { throw new Error('office_source_unavailable') })
    const tool = createOfficeTools({ port: { create, get: vi.fn(), revise: vi.fn() } }).find(tool => tool.name === 'createOfficeArtifact')!
    const result = await tool.execute({ family: 'document', outcome: 'Test quotation', audience: 'Client', sourceHandles: [], templateId: id(10), idempotencyKey: 'waterman-test-123' }, context)
    expect(result.isError).toBe(true)
    expect(result.data).toContain('No generation job was queued')
    expect(result.data).toContain('listOfficeTemplates')
    expect(result.data).toContain('templateVersionId')
  })
  it('assigns comments with explicit clearing, validated due dates and native policy', async () => {
    const assignComment = vi.fn<NonNullable<OfficeToolPort['assignComment']>>().mockResolvedValue({ scopeEvidence: { sensitivity: 'internal' } })
    const port: OfficeToolPort = { create: vi.fn(), get: vi.fn(), revise: vi.fn(), assignComment }
    const tool = createOfficeTools({ port }).find(t => t.name === 'assignOfficeComment')!
    const input = { artifactId: id(1), threadId: id(3), assignedUserId: null, assignedToBrian: true, dueAt: '2026-12-01T12:00:00+08:00' }
    expect(tool.inputSchema.safeParse(input).success).toBe(true)
    expect(tool.inputSchema.safeParse({ ...input, dueAt: 'tomorrow' }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ ...input, assignedUserId: undefined }).success).toBe(false)
    expect(tool.inputSchema.safeParse({ ...input, actorAssistantId: id(99) }).success).toBe(false)
    expect(await tool.execute(input, context)).toMatchObject({ data: input, scopeEvidence: { sensitivity: 'internal' } })
    expect(assignComment).toHaveBeenCalledWith(context, input)
    const blocked = createOfficeTools({ port, resolvePolicy: async () => 'block' }).find(t => t.name === tool.name)!
    expect((await blocked.execute(input, context)).isError).toBe(true)
    expect(assignComment).toHaveBeenCalledOnce()
    assignComment.mockResolvedValueOnce(null)
    expect(await tool.execute({ ...input, dueAt: null }, context)).toMatchObject({ isError: true })
  })
  it('resolves comments through the native port with policy and host identity', async () => {
    const resolveComment = vi.fn<NonNullable<OfficeToolPort['resolveComment']>>().mockResolvedValue({ scopeEvidence: { sensitivity: 'internal' } })
    const port: OfficeToolPort = { create: vi.fn(), get: vi.fn(), revise: vi.fn(), resolveComment }
    const tool = createOfficeTools({ port }).find(t => t.name === 'resolveOfficeComment')!
    const input = { artifactId: id(1), threadId: id(3), resolved: true }
    expect(tool.inputSchema.safeParse({ ...input, actorAssistantId: id(99) }).success).toBe(false)
    expect(await tool.execute(input, context)).toEqual({ data: input, scopeEvidence: { sensitivity: 'internal' } })
    expect(resolveComment).toHaveBeenCalledWith(context, input)
    resolveComment.mockResolvedValueOnce(null)
    expect(await tool.execute(input, context)).toMatchObject({ isError: true, data: { code: 'office_comment_unavailable' } })
    const blocked = createOfficeTools({ port, resolvePolicy: async () => 'block' }).find(t => t.name === tool.name)!
    expect((await blocked.execute(input, context)).isError).toBe(true)
    expect(resolveComment).toHaveBeenCalledTimes(2)
    expect(tool.isReadOnly).toBe(false)
  })
  it('restores saved history with conflict and policy handling and no caller attribution', async () => {
    const restoreVersion = vi.fn<NonNullable<OfficeToolPort['restoreVersion']>>().mockResolvedValue({ id: id(9), version: 3 })
    const port: OfficeToolPort = { create: vi.fn(), get: vi.fn(), revise: vi.fn(), restoreVersion }
    const tool = createOfficeTools({ port }).find(t => t.name === 'restoreOfficeVersion')!
    const input = { artifactId: id(1), targetVersionId: id(8), expectedVersion: 2 }
    expect(tool.inputSchema.safeParse({ ...input, actorAssistantId: id(99) }).success).toBe(false)
    expect((await tool.execute(input, context)).data).toEqual({ artifactId: id(1), versionId: id(9), version: 3 })
    restoreVersion.mockResolvedValueOnce('version_conflict')
    expect(await tool.execute(input, context)).toMatchObject({ isError: true, data: { code: 'version_conflict' } })
    const blocked = createOfficeTools({ port, resolvePolicy: async () => 'block' }).find(t => t.name === tool.name)!
    expect((await blocked.execute(input, context)).isError).toBe(true)
    expect(restoreVersion).toHaveBeenCalledTimes(2)
    const ask = createOfficeTools({ port, resolvePolicy: async () => 'ask' }).find(t => t.name === tool.name)!
    expect(await ask.resolveConfirmation!(context, input)).toBe(true)
  })
  it('exports through native release and requires host-authenticated acknowledgement', async () => {
    const exportArtifact = vi.fn(async () => ({ status: 201, body: { fileId: id(9), releaseId: id(10) } }))
    const port: OfficeToolPort = { create: vi.fn(), get: vi.fn(), revise: vi.fn(), exportArtifact }
    const tool = createOfficeTools({ port }).find(t => t.name === 'exportOfficeArtifact')!
    const input = { artifactId: id(1), expectedVersion: 2, format: 'pdf' }
    expect(tool.inputSchema.safeParse({ ...input, approved: true }).success).toBe(false)
    expect(await tool.resolveConfirmation!(context, input)).toBe(false)
    expect((await tool.execute(input, context)).data).toEqual({ fileId: id(9), releaseId: id(10) })
    const acknowledged = { ...input, acknowledgeCodes: ['claim.unverified'] }
    expect(await tool.resolveConfirmation!(context, acknowledged)).toBe(true)
    expect((await tool.execute(acknowledged, context)).isError).toBe(true)
    expect(exportArtifact).toHaveBeenCalledOnce()
    expect((await tool.execute(acknowledged, { ...context, approvedToolInvocation: {
      toolName: tool.name, approvalId: id(11), approverUserId: context.userId,
    } })).isError).toBe(false)
    const blocked = createOfficeTools({ port, resolvePolicy: async () => 'block' }).find(t => t.name === tool.name)!
    expect((await blocked.execute(input, context)).isError).toBe(true)
    expect(exportArtifact).toHaveBeenCalledTimes(2)
  })

  it('requires human review for trash and purge while preserving allow, ask and block policy', async () => {
    const changeLifecycle = vi.fn(async () => ({ artifactId: id(1), lifecycleState: 'archived' }))
    const port: OfficeToolPort = { create: vi.fn(), get: vi.fn(), revise: vi.fn(), changeLifecycle }
    const tool = createOfficeTools({ port }).find(t => t.name === 'changeOfficeLifecycle')!
    expect(await tool.resolveConfirmation!(context, { artifactId: id(1), action: 'archive' })).toBe(false)
    for (const action of ['trash', 'purge']) expect(await tool.resolveConfirmation!(context, { artifactId: id(1), action })).toBe(true)
    expect((await tool.execute({ artifactId: id(1), action: 'archive' }, context)).data).toEqual({ artifactId: id(1), lifecycleState: 'archived' })
    const blocked = createOfficeTools({ port, resolvePolicy: async () => 'block' }).find(t => t.name === 'changeOfficeLifecycle')!
    expect((await blocked.execute({ artifactId: id(1), action: 'archive' }, context)).isError).toBe(true)
    expect(changeLifecycle).toHaveBeenCalledOnce()
    const ask = createOfficeTools({ port, resolvePolicy: async () => 'ask' }).find(t => t.name === 'changeOfficeLifecycle')!
    expect(await ask.resolveConfirmation!(context, { artifactId: id(1), action: 'archive' })).toBe(true)
  })

  it('cancels only through the canonical job port and honors policy',async()=>{
    const cancelJob=vi.fn(async()=>true)
    const port:OfficeToolPort={create:vi.fn(),get:vi.fn(),revise:vi.fn(),cancelJob}
    const input={artifactId:id(1),jobId:id(90)}
    const tool=createOfficeTools({port}).find(t=>t.name==='cancelOfficeJob')!
    expect((await tool.execute(input,context)).data).toEqual({cancellationRequested:true})
    expect(cancelJob).toHaveBeenCalledWith(context,input)
    const blocked=createOfficeTools({port,resolvePolicy:async()=>'block'}).find(t=>t.name==='cancelOfficeJob')!
    expect((await blocked.execute(input,context)).isError).toBe(true)
    expect(cancelJob).toHaveBeenCalledOnce()
  })

  it('exposes native review reads with bounded input, hidden evidence and policy gates',async()=>{
    const evidence={sensitivity:'internal' as const,compartments:[],projectIds:[]}
    const inspectReview=vi.fn(async()=>({items:[{id:id(9)}],nextOffset:1,windowLimit:200,windowLimitReached:false,scopeEvidence:evidence}))
    const port:OfficeToolPort={create:vi.fn(),get:vi.fn(),revise:vi.fn(),inspectReview}
    for(const name of ['getOfficeHistory','getOfficeComments','getOfficeSuggestions']){
      const tool=createOfficeTools({port}).find(tool=>tool.name===name)!
      expect(tool.inputSchema.safeParse({artifactId:id(1),limit:51}).success).toBe(false)
      const result=await tool.execute({artifactId:id(1),limit:1,offset:0},context)
      expect(result.data).toMatchObject({items:[{id:id(9)}],nextOffset:1})
      expect(result.data).not.toHaveProperty('scopeEvidence');expect(result.scopeEvidence).toEqual(evidence)
      const blocked=createOfficeTools({port,resolvePolicy:async()=>'block'}).find(tool=>tool.name===name)!
      expect((await blocked.execute({artifactId:id(1)},context)).isError).toBe(true)
    }
    expect(inspectReview).toHaveBeenCalledTimes(3)
  })

  it('keeps library observations internal and enforces the read policy',async()=>{
    const evidence={sensitivity:'internal' as const,compartments:['team:fictional']}
    const list=vi.fn(async()=>({artifacts:[{artifactId:id(1),family:'document' as const,title:'Fictional plan',version:2,lifecycleState:'active' as const,role:'view' as const,scopeEvidence:evidence}],nextCursor:id(2)}))
    const port:OfficeToolPort={create:vi.fn(),get:vi.fn(),revise:vi.fn(),list}
    const tool=createOfficeTools({port}).find(tool=>tool.name==='listOfficeArtifacts')!
    const input={view:'active',limit:20}
    const result=await tool.execute(input,context)
    expect(result.scopeEvidence).toMatchObject(evidence)
    expect((result.data as {artifacts:unknown[]}).artifacts[0]).not.toHaveProperty('scopeEvidence')
    expect(list).toHaveBeenCalledWith(context,input)
    const blocked=createOfficeTools({port,resolvePolicy:async()=>'block'}).find(tool=>tool.name==='listOfficeArtifacts')!
    expect((await blocked.execute(input,context)).isError).toBe(true)
    expect(list).toHaveBeenCalledTimes(1)
  })
  it('offers template recovery through the same typed selection and enforces tool policy',async()=>{
    const resumeGeneration=vi.fn(async()=>({artifactId:id(1),jobId:id(90)}))
    const port:OfficeToolPort={create:vi.fn(),get:vi.fn(),revise:vi.fn(),resumeGeneration}
    const input={artifactId:id(1),jobId:id(90),templateVersionId:id(91)}
    const allowed=createOfficeTools({port}).find(tool=>tool.name==='resumeOfficeGeneration')!
    expect((await allowed.execute(input,context)).data).toMatchObject({artifactId:id(1),jobId:id(90)})
    expect(resumeGeneration).toHaveBeenCalledWith(context,input)
    const blocked=createOfficeTools({port,resolvePolicy:async()=>'block'}).find(tool=>tool.name==='resumeOfficeGeneration')!
    expect((await blocked.execute(input,context)).isError).toBe(true)
    expect(resumeGeneration).toHaveBeenCalledTimes(1)
  })
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
      context,
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

describe('[COMP:office/pdf-tools] PDF session tools', () => {
  const basePort = (over: Partial<OfficeToolPort> = {}): OfficeToolPort => ({
    create: vi.fn(async () => ({ artifactId: id(1), jobId: id(90) })),
    get: vi.fn(async () => null),
    revise: vi.fn(async () => null),
    ...over,
  })
  const signatureInput = {
    artifactId: id(1),
    targetId: id(2),
    signatureResourceId: id(3),
    expectedSourceHash: 'a'.repeat(64),
    expectedVersion: 4,
    idempotencyKey: 'signature-request-1',
  }

  it('keeps PDF out of generic creation and admits only exact current-turn attachments', async () => {
    const openPdfSession = vi.fn(async () => ({
      artifactId: id(1), version: 0, expiresAt: '2026-10-01T00:00:00.000Z',
      editorUrl: `/w/${id(2)}/office/${id(1)}`,
      targets: [{ targetId: id(4), pageId: id(5), pageNumber: 1, rect: { x: 10, y: 20, width: 120, height: 30 } }],
      sourceHash: 'b'.repeat(64), signatureResourceId: id(3),
    }))
    const tools = new Map(createOfficeTools({ port: basePort({ openPdfSession }), appOrigin: 'https://app.example.com' }).map((tool) => [tool.name, tool]))
    expect(tools.get('createOfficeArtifact')!.inputSchema.safeParse({ family: 'pdf', outcome: 'Edit it', audience: 'Owner', sourceHandles: [], idempotencyKey: 'create-pdf-1' }).success).toBe(false)

    const input = { sourceAttachmentId: id(6), signatureAttachmentId: id(7), title: 'Agreement', idempotencyKey: 'open-pdf-request' }
    const stale = await tools.get('openPdfEditingSession')!.execute(input, {
      ...context,
      userMessageText: 'Please sign this PDF',
      currentTurnAttachmentIds: new Set([id(6)]),
    })
    expect(stale.isError).toBe(true)
    expect(openPdfSession).not.toHaveBeenCalled()

    const opened = await tools.get('openPdfEditingSession')!.execute(input, {
      ...context,
      userMessageText: 'Please sign this PDF',
      currentTurnAttachmentIds: new Set([id(6), id(7)]),
    })
    expect(opened.isError).toBeFalsy()
    expect(opened.data).toMatchObject({
      artifactId: id(1),
      editorUrl: `https://app.example.com/w/${id(2)}/office/${id(1)}`,
      sourceHash: 'b'.repeat(64),
      signatureResourceId: id(3),
    })
    expect(openPdfSession).toHaveBeenCalledWith(expect.objectContaining({ sessionId: id(82), sourceAttachmentId: id(6), signatureAttachmentId: id(7) }))
  })

  it('checkpoints current-turn provenance before policy approval and restores it only from that receipt', async () => {
    const openPdfSession = vi.fn(async () => ({
      artifactId: id(1), version: 0, expiresAt: '2026-10-01T00:00:00.000Z', editorUrl: `/w/${id(2)}/office/${id(1)}`,
      targets: [], sourceHash: 'b'.repeat(64),
    }))
    const tool = new Map(createOfficeTools({
      port: basePort({ openPdfSession }),
      resolvePolicy: async () => 'ask',
    }).map((item) => [item.name, item])).get('openPdfEditingSession')!
    const input = { sourceAttachmentId: id(6), title: 'Agreement', idempotencyKey: 'open-pdf-request' }
    expect(await tool.resolveConfirmation!({ ...context, currentTurnAttachmentIds: new Set([id(7)]) }, input)).toBe(false)
    expect(await tool.resolveConfirmation!({ ...context, currentTurnAttachmentIds: new Set([id(6)]) }, input)).toBe(true)
    const replayed = await tool.execute(input, {
      ...context,
      approvedToolInvocation: { approvalId: id(70), approverUserId: context.userId, toolName: 'openPdfEditingSession' },
    })
    expect(replayed.isError).toBeFalsy()
    expect(openPdfSession).toHaveBeenCalledTimes(1)
  })

  it('pins the authoritative one-time signature approval copy and static policy', async () => {
    const describePdfSignature = vi.fn(async () => ({
      title: 'Agreement', fileName: 'agreement.pdf', pageNumber: 2,
      rect: { x: 12, y: 34, width: 150, height: 42 },
      sourceHash: 'a'.repeat(64), version: 4, expiresAt: '2026-10-01T00:00:00.000Z',
    }))
    const tools = new Map(createOfficeTools({
      port: basePort({ describePdfSignature }),
      resolvePolicy: async () => 'allow',
    }).map((tool) => [tool.name, tool]))
    const tool = tools.get('placePdfSignature')!
    expect(tool.requiresConfirmation).toBe(true)
    expect(tool.confirmationMode).toBe('durable_attended')
    expect(tool.allowPersistentApproval).toBe(false)
    expect(tool.resolveConfirmation).toBeUndefined()
    expect(await tool.describeConfirmation!(signatureInput, context)).toEqual([
      'PDF: Agreement (agreement.pdf)',
      'Page 2; rectangle x=12, y=34, width=150, height=42',
      `Source ${'a'.repeat(12)}; version 4; expires 2026-10-01T00:00:00.000Z`,
      'This places an image-based signature. It is not a certificate-based digital signature.',
    ])
  })

  it('cannot execute without an authenticated approval receipt and reports anchor drift', async () => {
    const placePdfSignature = vi.fn()
      .mockResolvedValueOnce({ artifactId: id(1), version: 5 })
      .mockResolvedValueOnce('pdf_signature_approval_stale')
    const tool = new Map(createOfficeTools({ port: basePort({ placePdfSignature }) }).map((item) => [item.name, item])).get('placePdfSignature')!
    const refused = await tool.execute(signatureInput, context)
    expect(refused.isError).toBe(true)
    expect(placePdfSignature).not.toHaveBeenCalled()

    const approvedContext = {
      ...context,
      approvedToolInvocation: { approvalId: id(70), approverUserId: context.userId, toolName: 'placePdfSignature' },
    }
    await expect(tool.execute(signatureInput, approvedContext)).resolves.toMatchObject({ data: { artifactId: id(1), version: 5 } })
    expect(placePdfSignature).toHaveBeenCalledWith(expect.objectContaining({
      approvalId: id(70),
      approverUserId: context.userId,
      expectedVersion: 4,
      expectedSourceHash: 'a'.repeat(64),
    }))
    const stale = await tool.execute(signatureInput, approvedContext)
    expect(stale.isError).toBe(true)
    expect(String(stale.data)).toContain('pdf_signature_approval_stale')
  })
})

describe('[COMP:office/tools] classification approval and scope evidence',()=>{
  it('shares the classified artifact command and always requires confirmation for protection changes',async()=>{
    const inspectClassification=vi.fn(async()=>({revision:'a'.repeat(64),sensitivity:'confidential',compartments:['team:planning'],projectIds:[]}))
    const restrictClassification=vi.fn(async()=>({artifactId:id(1),sensitivity:'confidential',compartments:['team:planning']}))
    const port:OfficeToolPort={create:vi.fn(),get:vi.fn(),revise:vi.fn(),inspectClassification,restrictClassification}
    const tools=createOfficeTools({port})
    const inspect=tools.find(t=>t.name==='getOfficeClassification')!
    const write=tools.find(t=>t.name==='restrictOfficeClassification')!
    expect(write.requiresCapability).toBe('office');expect(write.requiresConfirmation).toBe(true)
    const result=await inspect.execute({artifactId:id(1)},context)
    expect(result.scopeEvidence).toMatchObject({sensitivity:'confidential',compartments:['team:planning']})
    const command={artifactId:id(1),expectedRevision:'a'.repeat(64),sensitivity:'confidential' as const}
    await write.execute(command,context)
    expect(restrictClassification).toHaveBeenCalledWith(context,command)
  })
})
