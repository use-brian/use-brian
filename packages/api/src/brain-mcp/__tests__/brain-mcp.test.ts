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
  'searchKnowledge',
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
  // docs/plans/agent-facing-capability-surface.md §12.1.

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
