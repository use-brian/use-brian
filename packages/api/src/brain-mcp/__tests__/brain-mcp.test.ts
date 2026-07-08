/**
 * Unit tests for the brain MCP server's pure logic.
 * Component tag: [COMP:api/brain-mcp].
 *
 * Covers scope-gated tool construction and API-key authentication. The
 * DB-touching tool handlers are exercised by the integration harness.
 */

import { describe, it, expect, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import { z } from 'zod'
import { buildTool, type PipelineBResult, type Tool, type ToolContext } from '@sidanclaw/core'
import { hashSecret } from '../../db/api-key-store.js'
import { mintBrainPlaintext, type BrainKeyStore } from '../../db/brain-keys-store.js'
import { authenticateBrainRequest } from '../auth.js'
import {
  buildBrainTools,
  effectiveBrainClearance,
  type BrainCrmTools,
  type BrainDocTools,
  type BrainFileTools,
  type BrainMemoryTools,
  type BrainRetrievalTools,
  type BrainTaskTools,
} from '../tools.js'

// `resolveWriteTarget` (in tools.ts) calls the bare `query()` helper to look
// up the workspace owner + its primary assistant, and `loadActiveCapabilities`
// reads `assistant_capabilities`. Bridge-shape tests below stub both query
// shapes so the resolver can build a ToolContext without a real database.
vi.mock('../../db/client.js', () => ({
  query: vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('assistant_capabilities')) {
      return { rows: [{ capability: 'tasks' }, { capability: 'crm' }] }
    }
    return {
      rows: [
        {
          ownerUserId: '11111111-1111-1111-1111-111111111111',
          assistantId: '22222222-2222-2222-2222-222222222222',
          clearance: 'confidential',
          kind: 'primary',
          compartments: null,
          defaultCompartments: [],
        },
      ],
    }
  }),
}))

/**
 * `buildBrainTools` only touches the underlying core `Tool` instances inside
 * a handler (never at build time) so a no-op stub is enough for the
 * scope-gating tests. The stub keeps an `id?` input so the "non-empty input
 * schema" assertion holds — real tools always take at least an id or title.
 */
function stubCoreTool(name: string, isReadOnly = false): Tool {
  return buildTool({
    name,
    description: `${name} stub for tests`,
    inputSchema: z.object({ id: z.string().optional() }),
    isReadOnly,
    isConcurrencySafe: isReadOnly,
    async execute() {
      return { data: `${name} stub` }
    },
  })
}

const MEMORY_TOOLS_STUB: BrainMemoryTools = {
  saveMemory: stubCoreTool('saveMemory'),
  getMemory: stubCoreTool('getMemory', true),
  deleteMemory: stubCoreTool('deleteMemory'),
}

const TASK_TOOLS_STUB: BrainTaskTools = {
  saveTask: stubCoreTool('saveTask'),
  getTask: stubCoreTool('getTask', true),
  listTasks: stubCoreTool('listTasks', true),
  updateTask: stubCoreTool('updateTask'),
  closeTask: stubCoreTool('closeTask'),
  reopenTask: stubCoreTool('reopenTask'),
}

const CRM_TOOLS_STUB: BrainCrmTools = {
  saveContact: stubCoreTool('saveContact'),
  getContact: stubCoreTool('getContact', true),
  listContacts: stubCoreTool('listContacts', true),
  updateContact: stubCoreTool('updateContact'),
  saveCompany: stubCoreTool('saveCompany'),
  getCompany: stubCoreTool('getCompany', true),
  listCompanies: stubCoreTool('listCompanies', true),
  updateCompany: stubCoreTool('updateCompany'),
  saveDeal: stubCoreTool('saveDeal'),
  getDeal: stubCoreTool('getDeal', true),
  listDeals: stubCoreTool('listDeals', true),
  updateDeal: stubCoreTool('updateDeal'),
  advanceDealStage: stubCoreTool('advanceDealStage'),
}

const RETRIEVAL_TOOLS_STUB: BrainRetrievalTools = {
  // The retrieval-tool bridge renames `search` to `searchBrain`, so the core
  // tool name here is `search` (mirroring `createRetrievalTools`). `getEntity`
  // keeps its name and is the edge-discovery read path.
  search: stubCoreTool('search', true),
  getEntity: stubCoreTool('getEntity', true),
}

const FILE_TOOLS_STUB: BrainFileTools = {
  fileWrite: stubCoreTool('fileWrite'),
  fileAppend: stubCoreTool('fileAppend'),
  fileRead: stubCoreTool('fileRead', true),
  fileSearch: stubCoreTool('fileSearch', true),
  fileSetMeta: stubCoreTool('fileSetMeta'),
  fileDelete: stubCoreTool('fileDelete'),
  saveFileToBrain: stubCoreTool('saveFileToBrain'),
  saveFileBytes: stubCoreTool('saveFileBytes'),
}

const ALL_STUBS = {
  memoryTools: MEMORY_TOOLS_STUB,
  taskTools: TASK_TOOLS_STUB,
  crmTools: CRM_TOOLS_STUB,
  retrievalTools: RETRIEVAL_TOOLS_STUB,
  fileTools: FILE_TOOLS_STUB,
}

/** A representative Pipeline B extraction result for the ingest spy. The
 *  entity rows only need `displayName` + `kind` for `formatIngestResult`. */
const PIPELINE_B_RESULT: PipelineBResult = {
  episodeId: '55555555-5555-5555-5555-555555555555',
  summaryText: 'summary',
  entitiesWritten: [
    { displayName: 'Acme Corp', kind: 'company' },
    { displayName: 'widget-cli', kind: 'project' },
  ] as unknown as PipelineBResult['entitiesWritten'],
  edgesWritten: [{}] as unknown as PipelineBResult['edgesWritten'],
  memoriesWritten: [{}] as unknown as PipelineBResult['memoriesWritten'],
  tasksWritten: [{ id: 't1' }],
  ephemeralCount: 0,
  tags: [],
  sensitivity: null,
  extractionUsage: null,
  extracted: true,
}

/** First text block of a CallToolResult, or '' when none. */
function textBody(result: { content: Array<{ type: string; text?: string }> }): string {
  const block = result.content[0]
  return block && block.type === 'text' ? (block.text ?? '') : ''
}

const READ_TOOL_NAMES = [
  'fileRead',
  'fileSearch',
  'getCompany',
  'getContact',
  'getDeal',
  'getEntity',
  'getMemory',
  'getTask',
  'listCompanies',
  'listContacts',
  'listDeals',
  'listTasks',
  'searchBrain',
  'searchFileContent',
  'searchKnowledge',
  'searchRecording',
] as const

const WRITE_TOOL_NAMES = [
  'advanceDealStage',
  'closeTask',
  'deleteMemory',
  'fileAppend',
  'fileDelete',
  'fileSetMeta',
  'fileWrite',
  'ingestToBrain',
  'reopenTask',
  'saveCompany',
  'saveContact',
  'saveDeal',
  'saveFileBytes',
  'saveFileToBrain',
  'saveMemory',
  'saveTask',
  'updateCompany',
  'updateContact',
  'updateDeal',
  'updateTask',
] as const

describe('[COMP:api/brain-mcp] buildBrainTools — scope gating', () => {
  it('a read_write key exposes every read tool plus every write tool', () => {
    const tools = buildBrainTools({
      workspaceId: 'ws', scope: 'read_write', keyId: 'k', maxClearance: null,
      ...ALL_STUBS,
    })
    const names = tools.map((t) => t.name).sort()
    const expected = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES].sort()
    expect(names).toEqual(expected)
  })

  it('a read key sees only the read tools — no write surface', () => {
    const tools = buildBrainTools({
      workspaceId: 'ws', scope: 'read', keyId: 'k', maxClearance: null,
      ...ALL_STUBS,
    })
    const names = tools.map((t) => t.name).sort()
    expect(names).toEqual([...READ_TOOL_NAMES].sort())
    for (const writeName of WRITE_TOOL_NAMES) {
      expect(names).not.toContain(writeName)
    }
  })

  it('every tool carries a description and a non-empty input schema', () => {
    for (const t of buildBrainTools({
      workspaceId: 'ws', scope: 'read_write', keyId: 'k', maxClearance: null,
      ...ALL_STUBS,
    })) {
      expect(t.description.length).toBeGreaterThan(0)
      expect(Object.keys(t.inputSchema).length).toBeGreaterThan(0)
    }
  })

  it('renames the bridged retrieval `search` to `searchBrain`', () => {
    const tools = buildBrainTools({
      workspaceId: 'ws', scope: 'read', keyId: 'k', maxClearance: null,
      ...ALL_STUBS,
    })
    expect(tools.map((t) => t.name)).toContain('searchBrain')
    expect(tools.map((t) => t.name)).not.toContain('search')
  })

  it('keeps searchKnowledge as a deprecated alias but ingestToBrain is now a first-class extraction tool', () => {
    const tools = buildBrainTools({
      workspaceId: 'ws', scope: 'read_write', keyId: 'k', maxClearance: null,
      ...ALL_STUBS,
    })
    const searchKnowledge = tools.find((t) => t.name === 'searchKnowledge')!
    const ingestToBrain = tools.find((t) => t.name === 'ingestToBrain')!
    expect(searchKnowledge.description).toMatch(/DEPRECATED/i)
    // ingestToBrain is no longer a deprecated saveMemory alias — it's the
    // decompose-by-default ingest path. Its description must advertise
    // extraction + the decompose:false escape hatch, not deprecation.
    expect(ingestToBrain.description).not.toMatch(/DEPRECATED/i)
    expect(ingestToBrain.description).toMatch(/extract/i)
    expect(ingestToBrain.description).toMatch(/decompose/i)
    expect(Object.keys(ingestToBrain.inputSchema)).toContain('decompose')
    expect(Object.keys(ingestToBrain.inputSchema)).toContain('sourceLabel')
  })

  it('omits every file tool when no fileTools are wired (files-less deployment)', () => {
    const { fileTools: _omitted, ...noFiles } = ALL_STUBS
    const tools = buildBrainTools({
      workspaceId: 'ws', scope: 'read_write', keyId: 'k', maxClearance: null,
      ...noFiles,
    })
    const names = tools.map((t) => t.name)
    for (const fileName of ['fileRead', 'fileSearch', 'fileWrite', 'fileAppend', 'fileSetMeta', 'fileDelete']) {
      expect(names).not.toContain(fileName)
    }
    // The non-file surface is unaffected — memory/task/CRM/retrieval still present.
    expect(names).toContain('saveMemory')
    expect(names).toContain('searchBrain')
  })

  it('a read key sees the file reads but never the file writes', () => {
    const tools = buildBrainTools({
      workspaceId: 'ws', scope: 'read', keyId: 'k', maxClearance: null,
      ...ALL_STUBS,
    })
    const names = tools.map((t) => t.name)
    expect(names).toContain('fileRead')
    expect(names).toContain('fileSearch')
    for (const writeName of ['fileWrite', 'fileAppend', 'fileSetMeta', 'fileDelete']) {
      expect(names).not.toContain(writeName)
    }
  })
})

/** Build a fake BrainKeyStore backed by exactly one freshly minted key. */
async function fakeKeyStore(
  opts: {
    scope?: 'read' | 'read_write'
    status?: 'active' | 'revoked'
    maxClearance?: 'public' | 'internal' | 'confidential' | null
  } = {},
) {
  const id = randomUUID()
  const workspaceId = randomUUID()
  const { plaintext, secret, prefix } = mintBrainPlaintext(id)
  const keyHash = await hashSecret(secret)
  const row = {
    id,
    workspaceId,
    name: 'laptop',
    prefix,
    scope: opts.scope ?? ('read_write' as const),
    status: opts.status ?? ('active' as const),
    maxClearance: opts.maxClearance ?? null,
    keyHash,
    createdBy: null,
    createdAt: new Date(),
    lastUsedAt: null,
  }
  const store: BrainKeyStore = {
    async getByIdSystem(lookupId) {
      return lookupId === id ? row : null
    },
    async create() {
      throw new Error('unused in this test')
    },
    async listForWorkspace() {
      return []
    },
    async revoke() {
      return false
    },
    async updateMaxClearance() {
      return false
    },
    async touchLastUsedAt() {
      /* noop */
    },
  }
  return { id, workspaceId, plaintext, store }
}

function reqWith(authorization?: string): Request {
  return { headers: authorization ? { authorization } : {} } as unknown as Request
}

describe('[COMP:api/brain-mcp] authenticateBrainRequest', () => {
  it('accepts a valid key and resolves its workspace + scope', async () => {
    const { id, workspaceId, plaintext, store } = await fakeKeyStore({ scope: 'read' })
    const auth = await authenticateBrainRequest(reqWith(`Bearer ${plaintext}`), {
      brainKeyStore: store,
    })
    expect(auth).toEqual({
      keyId: id,
      workspaceId,
      scope: 'read',
      maxClearance: null,
      authKind: 'api_key',
    })
  })

  it('rejects a missing Authorization header', async () => {
    const { store } = await fakeKeyStore()
    expect(await authenticateBrainRequest(reqWith(), { brainKeyStore: store })).toBeNull()
  })

  it('rejects a header without the Bearer scheme', async () => {
    const { plaintext, store } = await fakeKeyStore()
    expect(
      await authenticateBrainRequest(reqWith(plaintext), { brainKeyStore: store }),
    ).toBeNull()
  })

  it('rejects an sk_live_ public-API key', async () => {
    const { store } = await fakeKeyStore()
    expect(
      await authenticateBrainRequest(reqWith(`Bearer sk_live_${randomUUID()}_secret`), {
        brainKeyStore: store,
      }),
    ).toBeNull()
  })

  it('rejects a well-formed token the store never issued', async () => {
    const { store } = await fakeKeyStore()
    const { plaintext } = mintBrainPlaintext(randomUUID())
    expect(
      await authenticateBrainRequest(reqWith(`Bearer ${plaintext}`), { brainKeyStore: store }),
    ).toBeNull()
  })

  it('rejects a revoked key', async () => {
    const { plaintext, store } = await fakeKeyStore({ status: 'revoked' })
    expect(
      await authenticateBrainRequest(reqWith(`Bearer ${plaintext}`), { brainKeyStore: store }),
    ).toBeNull()
  })

  it('rejects a tampered secret', async () => {
    const { plaintext, store } = await fakeKeyStore()
    expect(
      await authenticateBrainRequest(reqWith(`Bearer ${plaintext}xxxx`), {
        brainKeyStore: store,
      }),
    ).toBeNull()
  })
})

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

describe('[COMP:api/brain-mcp] buildBrainTools — bridged ToolContext shape', () => {
  // Regression guards for the two bugs that blocked every brain-MCP write in
  // prod 2026-05-28: (1) the per-request `sessionId` was a non-UUID
  // `brain-key:<id>` label, which Postgres rejected on UUID-typed write
  // columns; (2) the deprecated `ingestToBrain` wrapper forwarded
  // `scope: 'workspace'`, an enum value the chat-side `saveMemory` schema
  // had retired in favour of `'user' | 'team'`.

  it('the bridged saveMemory receives a UUID-shaped sessionId, not a "brain-key:..." label', async () => {
    let capturedCtx: ToolContext | undefined
    const captureSaveMemory: Tool = buildTool({
      name: 'saveMemory',
      description: 'capture context for assertion',
      inputSchema: z.object({
        summary: z.string(),
        detail: z.string().optional(),
        scope: z.enum(['user', 'team']).optional(),
        sensitivity: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
      async execute(_input, ctx) {
        capturedCtx = ctx
        return { data: 'ok' }
      },
    })
    const tools = buildBrainTools({
      workspaceId: '33333333-3333-3333-3333-333333333333',
      scope: 'read_write',
      keyId: '982d4a41-c568-4a5d-8614-833c7594bc1a',
      maxClearance: null,
      ...ALL_STUBS,
      memoryTools: { ...MEMORY_TOOLS_STUB, saveMemory: captureSaveMemory },
    })
    const saveMemory = tools.find((t) => t.name === 'saveMemory')!
    const result = await saveMemory.handler({ summary: 'hi' })
    expect(result.isError).toBeFalsy()
    expect(capturedCtx).toBeDefined()
    expect(capturedCtx!.sessionId).toMatch(UUID_RE)
    expect(capturedCtx!.sessionId).not.toContain('brain-key:')
    // The brain-key trace lives in channelType + channelId, not sessionId.
    expect(capturedCtx!.channelType).toBe('programmatic')
    expect(capturedCtx!.channelId).toBe('982d4a41-c568-4a5d-8614-833c7594bc1a')
  })

  it('the bridged saveMemory context seeds the sensitivity accumulator at the effective clearance (primary capped by max_clearance)', async () => {
    // saveMemory stamps `context.sensitivity?.max ?? 'public'`. The chat path
    // builds an accumulator that rises as sources are read; a brain-key call
    // has no in-turn reads, so without a seed every programmatic write would
    // land at baseline 'public' — readable by the lowest-clearance assistant.
    // The mock primary is 'confidential'; a key capped at 'internal' must
    // read AND seed at 'internal' (effectiveBrainClearance = min of the two).
    let capturedCtx: ToolContext | undefined
    const captureSaveMemory: Tool = buildTool({
      name: 'saveMemory',
      description: 'capture context for assertion',
      inputSchema: z.object({ summary: z.string() }),
      async execute(_input, ctx) {
        capturedCtx = ctx
        return { data: 'ok' }
      },
    })
    const tools = buildBrainTools({
      workspaceId: '33333333-3333-3333-3333-333333333333',
      scope: 'read_write',
      keyId: '982d4a41-c568-4a5d-8614-833c7594bc1a',
      maxClearance: 'internal',
      ...ALL_STUBS,
      memoryTools: { ...MEMORY_TOOLS_STUB, saveMemory: captureSaveMemory },
    })
    await tools.find((t) => t.name === 'saveMemory')!.handler({ summary: 'hi' })
    expect(capturedCtx).toBeDefined()
    expect(capturedCtx!.sensitivity?.max).toBe('internal')
    // The seed never drops the read ceiling — both stay at the effective tier,
    // and the write ceiling matches (a capped key can't author above its cap).
    expect(capturedCtx!.clearance).toBe('internal')
    expect(capturedCtx!.assistantClearance).toBe('internal')
  })

  it('every bridged tool in one request shares the same UUID sessionId (resolver memoization)', async () => {
    const seen: string[] = []
    const captureTool = (name: string): Tool =>
      buildTool({
        name,
        description: 'capture ctx',
        inputSchema: z.object({ summary: z.string().optional(), title: z.string().optional() }),
        async execute(_input, ctx) {
          seen.push(ctx.sessionId)
          return { data: 'ok' }
        },
      })
    const tools = buildBrainTools({
      workspaceId: '33333333-3333-3333-3333-333333333333',
      scope: 'read_write',
      keyId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      maxClearance: null,
      ...ALL_STUBS,
      memoryTools: { ...MEMORY_TOOLS_STUB, saveMemory: captureTool('saveMemory') },
      taskTools: { ...TASK_TOOLS_STUB, saveTask: captureTool('saveTask') },
    })
    await tools.find((t) => t.name === 'saveMemory')!.handler({ summary: 's' })
    await tools.find((t) => t.name === 'saveTask')!.handler({ title: 't' })
    expect(seen).toHaveLength(2)
    expect(seen[0]).toMatch(UUID_RE)
    expect(seen[0]).toBe(seen[1])
  })

  it('ingestToBrain falls back to a direct saveMemory (scope: "team") when no ingestor is wired', async () => {
    // No `ingest` capability in ALL_STUBS → even the default (decompose:true)
    // degrades to the direct discovery path. Regression guard: the forwarded
    // scope is the live `'team'`, never the retired `'workspace'` enum value.
    let capturedInput: Record<string, unknown> | undefined
    const captureSaveMemory: Tool = buildTool({
      name: 'saveMemory',
      description: 'capture input for assertion',
      inputSchema: z.object({
        summary: z.string(),
        detail: z.string().optional(),
        scope: z.enum(['user', 'team']).optional(),
        sensitivity: z.string().optional(),
        tags: z.array(z.string()).optional(),
      }),
      async execute(input) {
        capturedInput = input as Record<string, unknown>
        return { data: 'ok' }
      },
    })
    const tools = buildBrainTools({
      workspaceId: '33333333-3333-3333-3333-333333333333',
      scope: 'read_write',
      keyId: '982d4a41-c568-4a5d-8614-833c7594bc1a',
      maxClearance: null,
      ...ALL_STUBS,
      memoryTools: { ...MEMORY_TOOLS_STUB, saveMemory: captureSaveMemory },
    })
    const ingestToBrain = tools.find((t) => t.name === 'ingestToBrain')!
    const result = await ingestToBrain.handler({ content: 'a note', title: 'T' })
    expect(result.isError).toBeFalsy()
    expect(capturedInput).toBeDefined()
    expect(capturedInput!.scope).toBe('team')
  })

  it('ingestToBrain defaults to the Pipeline B ingestor when one is wired (smart decomposition)', async () => {
    const ingest = vi.fn(async () => PIPELINE_B_RESULT)
    let saveCalled = false
    const captureSaveMemory: Tool = buildTool({
      name: 'saveMemory',
      description: 'must NOT be called in decompose mode',
      inputSchema: z.object({ summary: z.string(), detail: z.string().optional() }),
      async execute() {
        saveCalled = true
        return { data: 'ok' }
      },
    })
    const tools = buildBrainTools({
      workspaceId: '33333333-3333-3333-3333-333333333333',
      scope: 'read_write',
      keyId: '982d4a41-c568-4a5d-8614-833c7594bc1a',
      maxClearance: 'internal',
      ...ALL_STUBS,
      memoryTools: { ...MEMORY_TOOLS_STUB, saveMemory: captureSaveMemory },
      ingest,
    })
    const ingestToBrain = tools.find((t) => t.name === 'ingestToBrain')!
    const result = await ingestToBrain.handler({
      content: 'Acme Corp builds widget-cli.',
      sourceLabel: 'acme',
    })
    expect(result.isError).toBeFalsy()
    // Routed to Pipeline B with the resolved owner/assistant + key-tier sensitivity.
    expect(ingest).toHaveBeenCalledTimes(1)
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: '33333333-3333-3333-3333-333333333333',
        userId: '11111111-1111-1111-1111-111111111111',
        assistantId: '22222222-2222-2222-2222-222222222222',
        content: 'Acme Corp builds widget-cli.',
        sourceLabel: 'acme',
        sensitivity: 'internal',
      }),
    )
    // The direct saveMemory path is bypassed entirely.
    expect(saveCalled).toBe(false)
    // The result summarises what landed so the agent won't re-ingest.
    const body = textBody(result)
    expect(body).toContain('Extracted')
    expect(body).toContain('Acme Corp')
  })

  it('ingestToBrain with decompose:false uses the direct saveMemory path even when an ingestor is wired', async () => {
    const ingest = vi.fn(async () => PIPELINE_B_RESULT)
    let capturedInput: Record<string, unknown> | undefined
    const captureSaveMemory: Tool = buildTool({
      name: 'saveMemory',
      description: 'direct discovery path',
      inputSchema: z.object({
        summary: z.string(),
        detail: z.string().optional(),
        scope: z.enum(['user', 'team']).optional(),
        tags: z.array(z.string()).optional(),
      }),
      async execute(input) {
        capturedInput = input as Record<string, unknown>
        return { data: 'ok' }
      },
    })
    const tools = buildBrainTools({
      workspaceId: '33333333-3333-3333-3333-333333333333',
      scope: 'read_write',
      keyId: '982d4a41-c568-4a5d-8614-833c7594bc1a',
      maxClearance: null,
      ...ALL_STUBS,
      memoryTools: { ...MEMORY_TOOLS_STUB, saveMemory: captureSaveMemory },
      ingest,
    })
    const ingestToBrain = tools.find((t) => t.name === 'ingestToBrain')!
    const result = await ingestToBrain.handler({
      content: 'a distilled fact',
      title: 'fact',
      decompose: false,
    })
    expect(result.isError).toBeFalsy()
    expect(ingest).not.toHaveBeenCalled()
    expect(capturedInput).toBeDefined()
    expect(capturedInput!.scope).toBe('team')
    expect(capturedInput!.detail).toBe('a distilled fact')
    expect(capturedInput!.summary).toBe('fact')
  })

  it('a bridged file write receives the resolved workspace + programmatic context at the key clearance', async () => {
    // The file tools read FilesContext fields off the ToolContext
    // (workspaceId, clearance, assistantKind); this guards that the bridge
    // fills them in for a programmatic caller, so a file write lands in the
    // right workspace at the right sensitivity ceiling.
    let capturedCtx: ToolContext | undefined
    const captureFileWrite: Tool = buildTool({
      name: 'fileWrite',
      description: 'capture ctx for assertion',
      inputSchema: z.object({ path: z.string(), content: z.string() }),
      async execute(_input, ctx) {
        capturedCtx = ctx
        return { data: 'Saved /x.md (2 bytes, text/plain). id=44444444-4444-4444-4444-444444444444' }
      },
    })
    const tools = buildBrainTools({
      workspaceId: '33333333-3333-3333-3333-333333333333',
      scope: 'read_write',
      keyId: '982d4a41-c568-4a5d-8614-833c7594bc1a',
      maxClearance: 'internal',
      ...ALL_STUBS,
      fileTools: { ...FILE_TOOLS_STUB, fileWrite: captureFileWrite },
    })
    const fileWrite = tools.find((t) => t.name === 'fileWrite')!
    const result = await fileWrite.handler({ path: '/x.md', content: 'hi' })
    expect(result.isError).toBeFalsy()
    expect(capturedCtx).toBeDefined()
    expect(capturedCtx!.workspaceId).toBe('33333333-3333-3333-3333-333333333333')
    expect(capturedCtx!.channelType).toBe('programmatic')
    expect(capturedCtx!.channelId).toBe('982d4a41-c568-4a5d-8614-833c7594bc1a')
    // Effective clearance — file reads/writes are clearance-capped like every channel.
    expect(capturedCtx!.clearance).toBe('internal')
  })
})

describe('[COMP:api/brain-mcp] agent capability toolset gating (agent-facing capability surface §5)', () => {
  const AGENT_TOOLS = {
    reads: new Map([['listAssistants', stubCoreTool('listAssistants', true)]]),
    writes: new Map([['runWorkflow', stubCoreTool('runWorkflow')]]),
  }

  it('agent reads ride both scopes; agent writes need read_write + the configure gate', () => {
    const readKey = buildBrainTools({
      workspaceId: 'ws', scope: 'read', keyId: 'k', maxClearance: null,
      ...ALL_STUBS,
      agentTools: AGENT_TOOLS,
      agentWritesEnabled: true, // even gated-on, a read key never sees writes
    })
    expect(readKey.map((t) => t.name)).toContain('listAssistants')
    expect(readKey.map((t) => t.name)).not.toContain('runWorkflow')

    const ungated = buildBrainTools({
      workspaceId: 'ws', scope: 'read_write', keyId: 'k', maxClearance: null,
      ...ALL_STUBS,
      agentTools: AGENT_TOOLS,
      agentWritesEnabled: false, // primary lacks `configure`
    })
    expect(ungated.map((t) => t.name)).toContain('listAssistants')
    expect(ungated.map((t) => t.name)).not.toContain('runWorkflow')

    const gatedOn = buildBrainTools({
      workspaceId: 'ws', scope: 'read_write', keyId: 'k', maxClearance: null,
      ...ALL_STUBS,
      agentTools: AGENT_TOOLS,
      agentWritesEnabled: true,
    })
    expect(gatedOn.map((t) => t.name)).toContain('listAssistants')
    expect(gatedOn.map((t) => t.name)).toContain('runWorkflow')
  })

  it('without agentTools the surface is unchanged (data-plane only)', () => {
    const tools = buildBrainTools({
      workspaceId: 'ws', scope: 'read_write', keyId: 'k', maxClearance: null,
      ...ALL_STUBS,
    })
    expect(tools.map((t) => t.name)).not.toContain('listAssistants')
    expect(tools.map((t) => t.name)).not.toContain('runWorkflow')
  })
})

describe('[COMP:api/brain-mcp] primary-assistant authority (agent-facing capability surface §2)', () => {
  // The brain MCP acts AS the workspace primary assistant: clearance,
  // compartments, kind, and capability grants all derive from the primary
  // row, capped by the key's max_clearance. See
  // docs/architecture/integrations/agent-capability-surface.md §12.1.

  it('effectiveBrainClearance: NULL cap = primary governs; a cap takes the min', () => {
    expect(effectiveBrainClearance('confidential', null)).toBe('confidential')
    expect(effectiveBrainClearance('internal', null)).toBe('internal')
    expect(effectiveBrainClearance('confidential', 'internal')).toBe('internal')
    expect(effectiveBrainClearance('confidential', 'public')).toBe('public')
    // The cap never RAISES the ceiling above the primary's own clearance.
    expect(effectiveBrainClearance('public', 'confidential')).toBe('public')
    expect(effectiveBrainClearance('internal', 'confidential')).toBe('internal')
  })

  it('an uncapped key inherits the full primary authority: clearance, kind, capabilities', async () => {
    // The mocked resolveWriteTarget row is a kind='primary' assistant with
    // clearance='confidential' and active grants ['tasks','crm'].
    let capturedCtx: ToolContext | undefined
    const captureSaveMemory: Tool = buildTool({
      name: 'saveMemory',
      description: 'capture ctx for assertion',
      inputSchema: z.object({ summary: z.string() }),
      async execute(_input, ctx) {
        capturedCtx = ctx
        return { data: 'ok' }
      },
    })
    const tools = buildBrainTools({
      workspaceId: '33333333-3333-3333-3333-333333333333',
      scope: 'read_write',
      keyId: '982d4a41-c568-4a5d-8614-833c7594bc1a',
      maxClearance: null,
      ...ALL_STUBS,
      memoryTools: { ...MEMORY_TOOLS_STUB, saveMemory: captureSaveMemory },
    })
    await tools.find((t) => t.name === 'saveMemory')!.handler({ summary: 'hi' })
    expect(capturedCtx).toBeDefined()
    expect(capturedCtx!.clearance).toBe('confidential')
    expect(capturedCtx!.assistantClearance).toBe('confidential')
    expect(capturedCtx!.sensitivity?.max).toBe('confidential')
    expect(capturedCtx!.assistantKind).toBe('primary')
    expect(capturedCtx!.activeCapabilities).toBeDefined()
    expect(capturedCtx!.activeCapabilities!.has('tasks')).toBe(true)
    expect(capturedCtx!.activeCapabilities!.has('crm')).toBe(true)
    expect(capturedCtx!.activeCapabilities!.has('configure')).toBe(false)
  })

  it('a key capped below the primary reads and writes at the cap (no-silent-widening posture)', async () => {
    let capturedCtx: ToolContext | undefined
    const captureSaveMemory: Tool = buildTool({
      name: 'saveMemory',
      description: 'capture ctx for assertion',
      inputSchema: z.object({ summary: z.string() }),
      async execute(_input, ctx) {
        capturedCtx = ctx
        return { data: 'ok' }
      },
    })
    const tools = buildBrainTools({
      workspaceId: '33333333-3333-3333-3333-333333333333',
      scope: 'read_write',
      keyId: '982d4a41-c568-4a5d-8614-833c7594bc1a',
      maxClearance: 'public',
      ...ALL_STUBS,
      memoryTools: { ...MEMORY_TOOLS_STUB, saveMemory: captureSaveMemory },
    })
    await tools.find((t) => t.name === 'saveMemory')!.handler({ summary: 'hi' })
    expect(capturedCtx).toBeDefined()
    expect(capturedCtx!.clearance).toBe('public')
    expect(capturedCtx!.assistantClearance).toBe('public')
    expect(capturedCtx!.sensitivity?.max).toBe('public')
  })
})

describe('[COMP:api/brain-mcp-page-tools] doc-page tools (readPage / listPages / editPage / deletePage / createPage / templates)', () => {
  // A minimal page row the doc-page store stub returns. One heading block is
  // enough for the Markdown export + the delete/edit access-confirm read.
  const SAMPLE_PAGE = {
    page: { blocks: [{ kind: 'heading', id: 'b1', level: 1, text: 'Hello' }] },
    version: 3,
    title: 'Worker Maintenance Log',
    nameOrigin: 'user' as const,
    icon: null,
  }

  function listRow(name: string, id: string) {
    return {
      id,
      workspaceId: 'ws',
      name,
      nameOrigin: 'user' as const,
      description: null,
      icon: null,
      entity: 'tasks' as const,
      viewType: 'table' as const,
      state: 'saved' as const,
      nestParentId: null,
      position: 0,
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    }
  }

  /** A spyable BrainDocTools stub. The spies let each test assert the right
   *  store path ran (read → getVersionedPage, edit → applyPatch, delete →
   *  remove) without a real database. */
  function docToolsStub(overrides: Partial<{
    getVersionedPage: (userId: string, pageId: string) => Promise<typeof SAMPLE_PAGE | null>
    list: (...args: unknown[]) => Promise<ReturnType<typeof listRow>[]>
    applyPatch: (...args: unknown[]) => Promise<{ newVersion: number } | null>
    remove: (...args: unknown[]) => Promise<boolean>
    createDraft: (...args: unknown[]) => Promise<{ id: string }>
    // `createPage`'s parent guard: resolve + workspace-confirm a `parentPageId`.
    // Default returns a same-workspace page so a supplied parent validates.
    getById: (...args: unknown[]) => Promise<{ workspaceId: string } | null>
    // Custom page templates (migration 281) — wired only when provided so the
    // existing tests still exercise the built-in-only catalog.
    templateList: (...args: unknown[]) => Promise<unknown[]>
    templateGetById: (...args: unknown[]) => Promise<unknown>
    templateCreate: (...args: unknown[]) => Promise<unknown>
  }> = {}): BrainDocTools {
    const tools: BrainDocTools = {
      savedViewStore: {
        list: vi.fn(overrides.list ?? (async () => [listRow('Worker Maintenance Log', 'p1')])),
        remove: vi.fn(overrides.remove ?? (async () => true)),
        createDraft: vi.fn(overrides.createDraft ?? (async () => ({ id: 'new-page-1' }))),
        getById: vi.fn(
          overrides.getById ??
            (async () => ({ workspaceId: '33333333-3333-3333-3333-333333333333' })),
        ),
      } as unknown as BrainDocTools['savedViewStore'],
      docPageStore: {
        getVersionedPage: vi.fn(overrides.getVersionedPage ?? (async () => SAMPLE_PAGE)),
        applyPatch: vi.fn(overrides.applyPatch ?? (async () => ({ newVersion: 4 }))),
      } as unknown as BrainDocTools['docPageStore'],
    }
    if (overrides.templateList || overrides.templateGetById || overrides.templateCreate) {
      tools.pageTemplateStore = {
        list: vi.fn(overrides.templateList ?? (async () => [])),
        getById: vi.fn(overrides.templateGetById ?? (async () => null)),
        create: vi.fn(
          overrides.templateCreate ??
            (async (_userId: string, input: { name: string; category: string }) => ({
              id: 'ct-new-uuid',
              workspaceId: '33333333-3333-3333-3333-333333333333',
              createdBy: 'u',
              name: input.name,
              description: null,
              icon: null,
              category: input.category,
              blocks: [],
              createdAt: '2026-01-01T00:00:00Z',
              updatedAt: '2026-01-01T00:00:00Z',
            })),
        ),
      } as unknown as NonNullable<BrainDocTools['pageTemplateStore']>
    }
    return tools
  }

  const BASE = {
    workspaceId: '33333333-3333-3333-3333-333333333333',
    keyId: '982d4a41-c568-4a5d-8614-833c7594bc1a',
    maxClearance: null,
    ...ALL_STUBS,
  } as const

  it('readPage is exposed on a read key; editPage/deletePage/createPage are NOT', () => {
    const tools = buildBrainTools({ ...BASE, scope: 'read', docTools: docToolsStub() })
    const names = tools.map((t) => t.name)
    expect(names).toContain('readPage')
    expect(names).not.toContain('editPage')
    expect(names).not.toContain('deletePage')
    expect(names).not.toContain('createPage')
  })

  it('editPage, deletePage and createPage appear only on a read_write key', () => {
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools: docToolsStub() })
    const names = tools.map((t) => t.name)
    expect(names).toContain('readPage')
    expect(names).toContain('editPage')
    expect(names).toContain('deletePage')
    expect(names).toContain('createPage')
  })

  it('omits the whole page surface when no docTools are wired', () => {
    const tools = buildBrainTools({ ...BASE, scope: 'read_write' })
    const names = tools.map((t) => t.name)
    for (const n of ['readPage', 'editPage', 'deletePage', 'createPage']) expect(names).not.toContain(n)
  })

  it('createPage mints a new page via createDraft and returns its id', async () => {
    const docTools = docToolsStub()
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const createPage = tools.find((t) => t.name === 'createPage')!
    const result = await createPage.handler({ title: 'Launch checklist', content: '## Step 1\nShip it.' })
    expect(result.isError).toBeFalsy()
    expect(textBody(result)).toContain('new-page-1')
    expect(docTools.savedViewStore.createDraft).toHaveBeenCalledTimes(1)
  })

  it('createPage rejects an empty title', async () => {
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools: docToolsStub() })
    const createPage = tools.find((t) => t.name === 'createPage')!
    const result = await createPage.handler({ title: '   ' })
    expect(result.isError).toBe(true)
  })

  it('createPage without a parent files a top-level page (nestParentId null)', async () => {
    const docTools = docToolsStub()
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const createPage = tools.find((t) => t.name === 'createPage')!
    const result = await createPage.handler({ title: 'Top level' })
    expect(result.isError).toBeFalsy()
    expect(docTools.savedViewStore.getById).not.toHaveBeenCalled()
    expect(docTools.savedViewStore.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ nestParentId: null }),
    )
  })

  it('createPage nests under a valid same-workspace parent', async () => {
    const parentId = '44444444-4444-4444-4444-444444444444'
    const docTools = docToolsStub()
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const createPage = tools.find((t) => t.name === 'createPage')!
    const result = await createPage.handler({ title: 'Child', parentPageId: parentId })
    expect(result.isError).toBeFalsy()
    expect(textBody(result)).toContain(parentId)
    expect(docTools.savedViewStore.getById).toHaveBeenCalledWith(expect.any(String), parentId)
    expect(docTools.savedViewStore.createDraft).toHaveBeenCalledWith(
      expect.objectContaining({ nestParentId: parentId }),
    )
  })

  it('createPage rejects a parentPageId the principal cannot see', async () => {
    const docTools = docToolsStub({ getById: async () => null })
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const createPage = tools.find((t) => t.name === 'createPage')!
    const result = await createPage.handler({
      title: 'Child',
      parentPageId: '44444444-4444-4444-4444-444444444444',
    })
    expect(result.isError).toBe(true)
    expect(docTools.savedViewStore.createDraft).not.toHaveBeenCalled()
  })

  it('createPage refuses a parent in another workspace', async () => {
    const docTools = docToolsStub({ getById: async () => ({ workspaceId: 'other-ws' }) })
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const createPage = tools.find((t) => t.name === 'createPage')!
    const result = await createPage.handler({
      title: 'Child',
      parentPageId: '44444444-4444-4444-4444-444444444444',
    })
    expect(result.isError).toBe(true)
    expect(docTools.savedViewStore.createDraft).not.toHaveBeenCalled()
  })

  it('readPage by id returns the page as Markdown', async () => {
    const docTools = docToolsStub()
    const tools = buildBrainTools({ ...BASE, scope: 'read', docTools })
    const readPage = tools.find((t) => t.name === 'readPage')!
    const result = await readPage.handler({ pageId: 'p1' })
    expect(result.isError).toBeFalsy()
    const body = textBody(result)
    // pageToMarkdown renders the title as an H1 + the heading block.
    expect(body).toContain('Worker Maintenance Log')
    expect(body).toContain('Hello')
    expect(docTools.docPageStore.getVersionedPage).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111', // resolved owner userId (mocked query)
      'p1',
    )
  })

  it('readPage by title returns content for a single match', async () => {
    const docTools = docToolsStub()
    const tools = buildBrainTools({ ...BASE, scope: 'read', docTools })
    const readPage = tools.find((t) => t.name === 'readPage')!
    const result = await readPage.handler({ title: 'Worker Maintenance' })
    expect(result.isError).toBeFalsy()
    expect(textBody(result)).toContain('Hello')
  })

  it('readPage by title lists matches (no content) when several pages match', async () => {
    const docTools = docToolsStub({
      list: async () => [listRow('Report A', 'pa'), listRow('Report B', 'pb')],
    })
    const tools = buildBrainTools({ ...BASE, scope: 'read', docTools })
    const readPage = tools.find((t) => t.name === 'readPage')!
    const result = await readPage.handler({ title: 'Report' })
    const body = textBody(result)
    expect(body).toContain('pa')
    expect(body).toContain('pb')
    // No content fetch on an ambiguous search.
    expect(docTools.docPageStore.getVersionedPage).not.toHaveBeenCalled()
  })

  it('listPages is exposed on a read key', () => {
    const tools = buildBrainTools({ ...BASE, scope: 'read', docTools: docToolsStub() })
    expect(tools.map((t) => t.name)).toContain('listPages')
  })

  it('listPages returns every page as a { pageId, title } row, newest first', async () => {
    const docTools = docToolsStub({
      list: async () => [
        { ...listRow('Older', 'p-old'), updatedAt: new Date('2026-01-01T00:00:00Z') },
        { ...listRow('Newer', 'p-new'), updatedAt: new Date('2026-02-01T00:00:00Z') },
      ],
    })
    const tools = buildBrainTools({ ...BASE, scope: 'read', docTools })
    const listPages = tools.find((t) => t.name === 'listPages')!
    const result = await listPages.handler({})
    expect(result.isError).toBeFalsy()
    const body = textBody(result)
    expect(body).toContain('Newer')
    expect(body).toContain('p-new')
    expect(body).toContain('p-old')
    // Recency order: the newer page is listed before the older one.
    expect(body.indexOf('p-new')).toBeLessThan(body.indexOf('p-old'))
  })

  it('listPages filters by a case-insensitive titlePrefix', async () => {
    const docTools = docToolsStub({
      list: async () => [
        listRow('sidanCode plan: alpha', 'pa'),
        listRow('sidanCode plan: beta', 'pb'),
        listRow('Unrelated page', 'pu'),
      ],
    })
    const tools = buildBrainTools({ ...BASE, scope: 'read', docTools })
    const listPages = tools.find((t) => t.name === 'listPages')!
    const result = await listPages.handler({ titlePrefix: 'SIDANCODE PLAN:' })
    const body = textBody(result)
    expect(body).toContain('pa')
    expect(body).toContain('pb')
    expect(body).not.toContain('pu')
  })

  it('listPages reports an empty result for a prefix that matches nothing', async () => {
    const docTools = docToolsStub({ list: async () => [listRow('Something else', 'px')] })
    const tools = buildBrainTools({ ...BASE, scope: 'read', docTools })
    const listPages = tools.find((t) => t.name === 'listPages')!
    const result = await listPages.handler({ titlePrefix: 'no-such-prefix' })
    expect(result.isError).toBeFalsy()
    expect(textBody(result)).toMatch(/no pages/i)
  })

  it('editPage append confirms access then applies a CAS patch', async () => {
    const docTools = docToolsStub()
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const editPage = tools.find((t) => t.name === 'editPage')!
    const result = await editPage.handler({ pageId: 'p1', content: 'New paragraph.' })
    expect(result.isError).toBeFalsy()
    expect(docTools.docPageStore.getVersionedPage).toHaveBeenCalled()
    expect(docTools.docPageStore.applyPatch).toHaveBeenCalledTimes(1)
    const call = (docTools.docPageStore.applyPatch as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // CAS uses the read version as the expected base; undo entry captured.
    expect(call.expectedVersion).toBe(3)
    expect(call.pageId).toBe('p1')
    expect(call.undo).toBeDefined()
    expect(textBody(result)).toMatch(/version 4/i)
  })

  it('editPage surfaces a concurrent-edit conflict when applyPatch returns null', async () => {
    const docTools = docToolsStub({ applyPatch: async () => null })
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const editPage = tools.find((t) => t.name === 'editPage')!
    const result = await editPage.handler({ pageId: 'p1', content: 'x' })
    expect(result.isError).toBe(true)
    expect(textBody(result)).toMatch(/concurrent/i)
  })

  it('editPage refuses a page the key cannot access (null read)', async () => {
    const docTools = docToolsStub({ getVersionedPage: async () => null })
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const editPage = tools.find((t) => t.name === 'editPage')!
    const result = await editPage.handler({ pageId: 'nope', content: 'x' })
    expect(result.isError).toBe(true)
    // Access not confirmed → never reaches applyPatch.
    expect(docTools.docPageStore.applyPatch).not.toHaveBeenCalled()
  })

  it('deletePage confirms access then calls the RLS-scoped remove', async () => {
    const docTools = docToolsStub()
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const deletePage = tools.find((t) => t.name === 'deletePage')!
    const result = await deletePage.handler({ pageId: 'p1' })
    expect(result.isError).toBeFalsy()
    expect(docTools.docPageStore.getVersionedPage).toHaveBeenCalled()
    expect(docTools.savedViewStore.remove).toHaveBeenCalledWith(
      '11111111-1111-1111-1111-111111111111',
      'p1',
    )
  })

  it('deletePage refuses (and never removes) a page the key cannot access', async () => {
    const docTools = docToolsStub({ getVersionedPage: async () => null })
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const deletePage = tools.find((t) => t.name === 'deletePage')!
    const result = await deletePage.handler({ pageId: 'nope' })
    expect(result.isError).toBe(true)
    expect(docTools.savedViewStore.remove).not.toHaveBeenCalled()
  })

  // ── template tools ────────────────────────────────────────────

  it('listPageTemplates is a read tool; createPageFromTemplate is read_write only', () => {
    const readNames = buildBrainTools({ ...BASE, scope: 'read', docTools: docToolsStub() }).map(
      (t) => t.name,
    )
    expect(readNames).toContain('listPageTemplates')
    expect(readNames).not.toContain('createPageFromTemplate')

    const rwNames = buildBrainTools({ ...BASE, scope: 'read_write', docTools: docToolsStub() }).map(
      (t) => t.name,
    )
    expect(rwNames).toContain('listPageTemplates')
    expect(rwNames).toContain('createPageFromTemplate')
  })

  it('the template tools are omitted when no docTools are wired', () => {
    const names = buildBrainTools({ ...BASE, scope: 'read_write' }).map((t) => t.name)
    expect(names).not.toContain('listPageTemplates')
    expect(names).not.toContain('createPageFromTemplate')
  })

  it('listPageTemplates returns the catalog with ids', async () => {
    const tools = buildBrainTools({ ...BASE, scope: 'read', docTools: docToolsStub() })
    const tool = tools.find((t) => t.name === 'listPageTemplates')!
    const result = await tool.handler({})
    expect(result.isError).toBeFalsy()
    const body = textBody(result)
    expect(body).toContain('meeting-notes')
    expect(body).toMatch(/page templates/i)
  })

  it('createPageFromTemplate seeds a page (with icon) via createDraft', async () => {
    const docTools = docToolsStub()
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const tool = tools.find((t) => t.name === 'createPageFromTemplate')!
    const result = await tool.handler({ templateId: 'meeting-notes' })
    expect(result.isError).toBeFalsy()
    expect(textBody(result)).toContain('new-page-1')
    expect(docTools.savedViewStore.createDraft).toHaveBeenCalledTimes(1)
    const arg = (docTools.savedViewStore.createDraft as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // Template icon + non-empty seeded blocks reach the store.
    expect(arg.icon).toBe('📝')
    expect(arg.page.blocks.length).toBeGreaterThan(0)
  })

  it('createPageFromTemplate honors a title override', async () => {
    const docTools = docToolsStub()
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const tool = tools.find((t) => t.name === 'createPageFromTemplate')!
    await tool.handler({ templateId: 'standup', title: 'Monday sync' })
    const arg = (docTools.savedViewStore.createDraft as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.name).toBe('Monday sync')
  })

  it('createPageFromTemplate rejects an unknown templateId without writing', async () => {
    const docTools = docToolsStub()
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const tool = tools.find((t) => t.name === 'createPageFromTemplate')!
    const result = await tool.handler({ templateId: 'no-such-template' })
    expect(result.isError).toBe(true)
    expect(docTools.savedViewStore.createDraft).not.toHaveBeenCalled()
  })

  it('listPageTemplates appends workspace custom templates when the store is wired', async () => {
    const docTools = docToolsStub({
      templateList: async () => [
        {
          id: 'ct-uuid-1',
          name: 'Sprint plan',
          description: 'two-week sprint',
          icon: '🏃',
          category: 'planning',
        },
      ],
    })
    const tools = buildBrainTools({ ...BASE, scope: 'read', docTools })
    const tool = tools.find((t) => t.name === 'listPageTemplates')!
    const body = textBody(await tool.handler({}))
    expect(body).toContain('meeting-notes') // built-in still present
    expect(body).toContain('ct-uuid-1') // custom appended
    expect(body).toMatch(/custom/i)
  })

  it('createPageFromTemplate resolves a custom template id via the store (fresh ids)', async () => {
    const docTools = docToolsStub({
      templateGetById: async () => ({
        id: 'ct-uuid-1',
        workspaceId: 'ws',
        createdBy: 'u',
        name: 'Sprint plan',
        description: null,
        icon: '🏃',
        category: 'planning',
        blocks: [{ kind: 'heading', id: 'orig-block', level: 1, text: 'Sprint' }],
        createdAt: '2026-01-01T00:00:00Z',
        updatedAt: '2026-01-01T00:00:00Z',
      }),
    })
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const tool = tools.find((t) => t.name === 'createPageFromTemplate')!
    const result = await tool.handler({ templateId: 'ct-uuid-1' })
    expect(result.isError).toBeFalsy()
    expect(docTools.savedViewStore.createDraft).toHaveBeenCalledTimes(1)
    const arg = (docTools.savedViewStore.createDraft as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(arg.name).toBe('Sprint plan')
    expect(arg.icon).toBe('🏃')
    // Block ids are re-minted, so the stored 'orig-block' id never reaches the page.
    expect(arg.page.blocks).toHaveLength(1)
    expect(arg.page.blocks[0].id).not.toBe('orig-block')
  })

  it('createPageTemplate is omitted unless the pageTemplateStore is wired', () => {
    // Built-in catalog tools need no store; createPageTemplate has no fallback.
    const noStore = buildBrainTools({ ...BASE, scope: 'read_write', docTools: docToolsStub() }).map(
      (t) => t.name,
    )
    expect(noStore).toContain('createPageFromTemplate')
    expect(noStore).not.toContain('createPageTemplate')

    const withStore = buildBrainTools({
      ...BASE,
      scope: 'read_write',
      docTools: docToolsStub({ templateCreate: async () => ({}) }),
    }).map((t) => t.name)
    expect(withStore).toContain('createPageTemplate')
  })

  it('createPageTemplate is a write tool (absent on a read key)', () => {
    const readNames = buildBrainTools({
      ...BASE,
      scope: 'read',
      docTools: docToolsStub({ templateCreate: async () => ({}) }),
    }).map((t) => t.name)
    expect(readNames).not.toContain('createPageTemplate')
  })

  it('createPageTemplate persists a template via the store and returns its id', async () => {
    // `templateList` flips the store branch on; `create` defaults to the stub.
    const docTools = docToolsStub({ templateList: async () => [] })
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const tool = tools.find((t) => t.name === 'createPageTemplate')!
    const result = await tool.handler({
      name: 'Weekly sync',
      category: 'meeting',
      content: '## Agenda\n- [ ] Item one',
      icon: '🗓️',
      description: 'Recurring sync layout',
    })
    expect(result.isError).toBeFalsy()
    expect(textBody(result)).toContain('ct-new-uuid')
    const create = docTools.pageTemplateStore!.create as ReturnType<typeof vi.fn>
    expect(create).toHaveBeenCalledTimes(1)
    const arg = create.mock.calls[0][1]
    expect(arg.name).toBe('Weekly sync')
    expect(arg.category).toBe('meeting')
    expect(arg.icon).toBe('🗓️')
    expect(arg.description).toBe('Recurring sync layout')
    // Markdown body became a non-empty canonical block list.
    expect(arg.blocks.length).toBeGreaterThan(0)
  })

  it('createPageTemplate rejects an empty name without writing', async () => {
    const docTools = docToolsStub({ templateList: async () => [] })
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const tool = tools.find((t) => t.name === 'createPageTemplate')!
    const result = await tool.handler({ name: '   ', category: 'meeting', content: '## X' })
    expect(result.isError).toBe(true)
    expect(docTools.pageTemplateStore!.create).not.toHaveBeenCalled()
  })

  it('createPageTemplate rejects content that yields no blocks', async () => {
    const docTools = docToolsStub({ templateList: async () => [] })
    const tools = buildBrainTools({ ...BASE, scope: 'read_write', docTools })
    const tool = tools.find((t) => t.name === 'createPageTemplate')!
    const result = await tool.handler({ name: 'Empty', category: 'meeting', content: '   ' })
    expect(result.isError).toBe(true)
    expect(docTools.pageTemplateStore!.create).not.toHaveBeenCalled()
  })
})
