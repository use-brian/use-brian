/**
 * Zod schema tests for the A2A module.
 *
 * Validates parsing, denormalization invariants, and JSON round-trip for the
 * types most likely to cross the wire later (Task, Message, ConsultRequest).
 * Loop-prevention scenarios test the chain envelope's structural rules.
 */

import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import {
  artifactSchema,
  callerIdentitySchema,
  capabilityIdSchema,
  capabilitySchema,
  consultChainSchema,
  consultRequestSchema,
  a2aMessageSchema,
  partSchema,
  specialistCardSchema,
  taskSchema,
} from '../schemas.js'
import { CONSULT_LIMITS, INITIAL_BUDGET, ERROR_CODES } from '../limits.js'

const ts = '2026-05-08T00:00:00Z'

const validMessage = {
  messageId: 'm_1',
  role: 'user' as const,
  parts: [{ kind: 'text' as const, text: 'hello' }],
}

const validCaller = {
  workspaceId: 'ws_a',
  assistantId: 'asst_primary',
  userId: 'user_1',
  channelType: 'web' as const,
}

const validChain = { path: [], depth: 0, budget: 10 }

describe('[COMP:a2a/schemas] Part schema', () => {
  it('parses each kind of part', () => {
    expect(() => partSchema.parse({ kind: 'text', text: 'hi' })).not.toThrow()
    expect(() =>
      partSchema.parse({
        kind: 'file',
        mimeType: 'application/pdf',
        ref: { type: 'inline', bytes: 'aGVsbG8=' },
      }),
    ).not.toThrow()
    expect(() =>
      partSchema.parse({
        kind: 'file',
        mimeType: 'image/png',
        ref: { type: 'url', uri: 'https://example.com/x.png' },
      }),
    ).not.toThrow()
    expect(() =>
      partSchema.parse({ kind: 'data', data: { foo: 1 } }),
    ).not.toThrow()
  })

  it('rejects unknown part kinds', () => {
    expect(() => partSchema.parse({ kind: 'video', url: 'x' })).toThrow()
  })

  it('rejects file part with non-URL string in `url` ref', () => {
    expect(() =>
      partSchema.parse({
        kind: 'file',
        mimeType: 'image/png',
        ref: { type: 'url', uri: 'not-a-url' },
      }),
    ).toThrow()
  })
})

describe('[COMP:a2a/schemas] CallerIdentity schema', () => {
  it('parses valid identity with userId', () => {
    expect(() => callerIdentitySchema.parse(validCaller)).not.toThrow()
  })

  it('parses valid identity with null userId (cron / workflow caller)', () => {
    expect(() =>
      callerIdentitySchema.parse({ ...validCaller, userId: null, channelType: 'cron' }),
    ).not.toThrow()
  })

  it('accepts a2a-external as a channel type from day one', () => {
    expect(() =>
      callerIdentitySchema.parse({ ...validCaller, channelType: 'a2a-external' }),
    ).not.toThrow()
  })

  it('rejects unknown channel types', () => {
    expect(() =>
      callerIdentitySchema.parse({ ...validCaller, channelType: 'sms' }),
    ).toThrow()
  })
})

describe('[COMP:a2a/schemas] Capability ID format', () => {
  it.each([
    'distribution.threads.publishPost',
    'crm.contact.create',
    'tasks.list.byStatus',
    'brand.review.scoreContent',
  ])('accepts valid capability ID: %s', (id) => {
    expect(() => capabilityIdSchema.parse(id)).not.toThrow()
  })

  it.each([
    'distribution.threads', // only two segments
    'distribution.threads.publishPost.extra', // four segments
    'Distribution.threads.publishPost', // capitalized first segment
    'distribution.threads.', // trailing dot
    '.threads.publishPost', // leading dot
    'distribution-threads.publishPost.now', // dash not allowed
    '', // empty
  ])('rejects malformed capability ID: %s', (id) => {
    expect(() => capabilityIdSchema.parse(id)).toThrow()
  })
})

describe('[COMP:a2a/schemas] Capability schema', () => {
  it('parses a valid capability with input schema', () => {
    expect(() =>
      capabilitySchema.parse({
        id: 'distribution.threads.publishPost',
        name: 'Publish to Threads',
        description: 'Publish a post.',
        inputSchema: z.object({ text: z.string() }),
        exposedTools: ['threadsCreatePost'],
      }),
    ).not.toThrow()
  })

  it('rejects capability whose inputSchema is not a Zod schema', () => {
    expect(() =>
      capabilitySchema.parse({
        id: 'distribution.threads.publishPost',
        name: 'Publish to Threads',
        description: 'Publish a post.',
        inputSchema: { type: 'object' }, // plain object, not Zod
        exposedTools: ['threadsCreatePost'],
      }),
    ).toThrow()
  })
})

describe('[COMP:a2a/schemas] SpecialistCard schema', () => {
  it('parses card with empty capabilities (specialist with no declared actions)', () => {
    expect(() =>
      specialistCardSchema.parse({
        assistantId: 'asst_distribution',
        workspaceId: 'ws_a',
        name: 'Threads distribution',
        description: 'Publishes to Threads.',
        capabilities: [],
        acceptsFreeChat: false,
      }),
    ).not.toThrow()
  })

  it('rejects card that uses `skills` instead of `capabilities` (rename guard)', () => {
    const wrongShape = {
      assistantId: 'asst_distribution',
      workspaceId: 'ws_a',
      name: 'Threads distribution',
      description: 'Publishes to Threads.',
      skills: [],
      acceptsFreeChat: false,
    }
    expect(() => specialistCardSchema.parse(wrongShape)).toThrow()
  })
})

describe('[COMP:a2a/schemas] ConsultChain schema (loop prevention)', () => {
  it('parses an initial chain', () => {
    expect(() => consultChainSchema.parse(validChain)).not.toThrow()
  })

  it('parses a chain after one hop', () => {
    expect(() =>
      consultChainSchema.parse({
        path: ['asst_primary'],
        depth: 1,
        budget: 9,
      }),
    ).not.toThrow()
  })

  it('rejects chain whose depth disagrees with path.length (denormalization invariant)', () => {
    expect(() =>
      consultChainSchema.parse({
        path: ['asst_a', 'asst_b'],
        depth: 1,
        budget: 8,
      }),
    ).toThrow(/depth must equal/)
  })

  it('rejects negative budget', () => {
    expect(() =>
      consultChainSchema.parse({ path: [], depth: 0, budget: -1 }),
    ).toThrow()
  })

  it('rejects negative depth', () => {
    expect(() =>
      consultChainSchema.parse({ path: [], depth: -1, budget: 10 }),
    ).toThrow()
  })
})

describe('[COMP:a2a/schemas] ConsultRequest schema', () => {
  it('parses a free-mode request (no capabilityId)', () => {
    expect(() =>
      consultRequestSchema.parse({
        target: { workspaceId: 'ws_b', assistantId: 'asst_alice' },
        message: validMessage,
        caller: validCaller,
        chain: validChain,
      }),
    ).not.toThrow()
  })

  it('parses a restricted-mode request (with capabilityId)', () => {
    expect(() =>
      consultRequestSchema.parse({
        target: {
          workspaceId: 'ws_a',
          assistantId: 'asst_distribution',
          capabilityId: 'distribution.threads.publishPost',
        },
        message: validMessage,
        caller: validCaller,
        chain: validChain,
      }),
    ).not.toThrow()
  })

  it('rejects request whose capabilityId does not match the format', () => {
    expect(() =>
      consultRequestSchema.parse({
        target: {
          workspaceId: 'ws_a',
          assistantId: 'asst_x',
          capabilityId: 'not_dotted',
        },
        message: validMessage,
        caller: validCaller,
        chain: validChain,
      }),
    ).toThrow()
  })

  it('parses a request with a uuid pageAnchorId (workflow page-anchored step)', () => {
    expect(() =>
      consultRequestSchema.parse({
        target: { workspaceId: 'ws_b', assistantId: 'asst_alice' },
        message: validMessage,
        caller: validCaller,
        chain: validChain,
        pageAnchorId: '00000000-0000-4000-8000-00000000aaaa',
      }),
    ).not.toThrow()
  })

  it('rejects a non-uuid pageAnchorId (the wire carries only resolved ids)', () => {
    expect(() =>
      consultRequestSchema.parse({
        target: { workspaceId: 'ws_b', assistantId: 'asst_alice' },
        message: validMessage,
        caller: validCaller,
        chain: validChain,
        pageAnchorId: '{{vars.pageId}}',
      }),
    ).toThrow()
  })
})

describe('[COMP:a2a/schemas] JSON round-trip (Message, Task, ConsultRequest)', () => {
  it('Message survives JSON.stringify / JSON.parse', () => {
    const msg = a2aMessageSchema.parse(validMessage)
    const round = a2aMessageSchema.parse(JSON.parse(JSON.stringify(msg)))
    expect(round).toEqual(msg)
  })

  it('Task survives JSON.stringify / JSON.parse', () => {
    const task = taskSchema.parse({
      taskId: 't_1',
      contextId: 'ctx_1',
      status: { state: 'completed', timestamp: ts },
      artifacts: [
        artifactSchema.parse({
          artifactId: 'a_1',
          name: 'threads-post-id',
          parts: [{ kind: 'data', data: { postId: 'p_42' } }],
        }),
      ],
    })
    const round = taskSchema.parse(JSON.parse(JSON.stringify(task)))
    expect(round).toEqual(task)
  })

  it('ConsultRequest survives JSON round-trip (free-mode)', () => {
    const req = consultRequestSchema.parse({
      target: { workspaceId: 'ws_b', assistantId: 'asst_alice' },
      message: validMessage,
      caller: validCaller,
      chain: validChain,
    })
    const round = consultRequestSchema.parse(JSON.parse(JSON.stringify(req)))
    expect(round).toEqual(req)
  })
})

describe('[COMP:a2a/limits] Limit constants', () => {
  it('MAX_DEPTH_FREE is 1 — cross-workspace stays single-hop', () => {
    expect(CONSULT_LIMITS.MAX_DEPTH_FREE).toBe(1)
  })

  it('MAX_DEPTH_RESTRICTED is 5 — leaves headroom for §12 workflow chains', () => {
    expect(CONSULT_LIMITS.MAX_DEPTH_RESTRICTED).toBe(5)
  })

  it('a2a_external initial budget forces leaf at the boundary', () => {
    expect(INITIAL_BUDGET.a2a_external).toBe(1)
  })

  it('every entry point has an integer budget ≥ 1', () => {
    for (const [k, v] of Object.entries(INITIAL_BUDGET)) {
      expect(Number.isInteger(v), `${k} budget`).toBe(true)
      expect(v).toBeGreaterThanOrEqual(1)
    }
  })

  it('error codes are unique', () => {
    const codes = Object.values(ERROR_CODES)
    expect(new Set(codes).size).toBe(codes.length)
  })

  it('error code ranges follow JSON-RPC convention', () => {
    // -32xxx is JSON-RPC reserved range; -33xxx is Use Brian additions
    expect(ERROR_CODES.TASK_NOT_FOUND).toBeGreaterThanOrEqual(-32999)
    expect(ERROR_CODES.TASK_NOT_FOUND).toBeLessThan(-32000)
    expect(ERROR_CODES.SHARING_BLOCKED).toBeGreaterThanOrEqual(-33999)
    expect(ERROR_CODES.SHARING_BLOCKED).toBeLessThan(-33000)
  })
})
