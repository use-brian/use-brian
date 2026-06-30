/**
 * Zod schemas mirroring `types.ts`. Used at trust boundaries:
 *
 * - The wire binding (later) parses inbound JSON-RPC payloads through these
 *   before handing off to in-process callers.
 * - The workflow runtime (§12) validates `assistant_call` step input/output
 *   against `Capability.inputSchema` / `outputSchema`.
 *
 * In-process call sites within a single trusted runtime can skip validation —
 * TypeScript types alone are enough for trusted callers.
 *
 * For `Capability.inputSchema` / `outputSchema` themselves: the schema accepts
 * any `z.ZodType` instance. Wire serialization (`z.toJSONSchema()` for Zod 4
 * or `zod-to-json-schema` for Zod 3) is deferred to the binding.
 *
 * [COMP:a2a/schemas]
 */

import { z } from 'zod'
import { ERROR_CODES } from './limits.js'
import { ResearchDepthConfigSchema } from '../engine/research-depth.js'

// ── Identity ────────────────────────────────────────────────────────────

export const channelTypeSchema = z.enum([
  'web',
  'telegram',
  'slack',
  'cron',
  'workflow',
  'a2a-external',
])

export const callerIdentitySchema = z.object({
  workspaceId: z.string().min(1),
  assistantId: z.string().min(1),
  userId: z.string().min(1).nullable(),
  channelType: channelTypeSchema,
})

// ── Parts ───────────────────────────────────────────────────────────────

const fileRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('inline'), bytes: z.string() }),
  z.object({ type: z.literal('url'), uri: z.string().url() }),
])

export const partSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('text'), text: z.string() }),
  z.object({
    kind: z.literal('file'),
    mimeType: z.string().min(1),
    ref: fileRefSchema,
  }),
  z.object({ kind: z.literal('data'), data: z.record(z.unknown()) }),
])

// ── Messages and Artifacts ──────────────────────────────────────────────

export const a2aMessageSchema = z.object({
  messageId: z.string().min(1),
  role: z.enum(['user', 'agent']),
  parts: z.array(partSchema),
  contextId: z.string().min(1).optional(),
  taskId: z.string().min(1).optional(),
})

export const artifactSchema = z.object({
  artifactId: z.string().min(1),
  name: z.string().min(1).optional(),
  parts: z.array(partSchema),
})

// ── Tasks ───────────────────────────────────────────────────────────────

export const taskStateSchema = z.enum([
  'submitted',
  'working',
  'input_required',
  'auth_required',
  'completed',
  'failed',
  'canceled',
])

export const taskStatusSchema = z.object({
  state: taskStateSchema,
  message: a2aMessageSchema.optional(),
  timestamp: z.string().datetime(),
})

export const taskSchema = z.object({
  taskId: z.string().min(1),
  contextId: z.string().min(1),
  status: taskStatusSchema,
  artifacts: z.array(artifactSchema),
  history: z.array(a2aMessageSchema).optional(),
})

// ── Capability surface ──────────────────────────────────────────────────

/**
 * Capability ID format: `<domain>.<entity>.<action>`. Each segment must start
 * with a lowercase ASCII letter and contain only ASCII letters and digits
 * (lowerCamelCase). Exactly three dot-separated segments.
 */
const CAPABILITY_ID_PATTERN = /^[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*\.[a-z][a-zA-Z0-9]*$/

export const capabilityIdSchema = z
  .string()
  .regex(
    CAPABILITY_ID_PATTERN,
    'Capability ID must be `<domain>.<entity>.<action>` lowerCamelCase per segment',
  )

/**
 * Validates that the value is a Zod schema instance. We can't structurally
 * verify the schema's contents — only that it is a schema.
 */
const zodSchemaSchema = z.custom<z.ZodType<unknown>>(
  (val): val is z.ZodType<unknown> => val instanceof z.ZodType,
  { message: 'Expected a Zod schema instance' },
)

export const capabilitySchema = z.object({
  id: capabilityIdSchema,
  name: z.string().min(1),
  description: z.string().min(1),
  inputSchema: zodSchemaSchema,
  outputSchema: zodSchemaSchema.optional(),
  exposedTools: z.array(z.string().min(1)),
})

export const specialistCardSchema = z.object({
  assistantId: z.string().min(1),
  workspaceId: z.string().min(1),
  name: z.string().min(1),
  description: z.string().min(1),
  capabilities: z.array(capabilitySchema),
  acceptsFreeChat: z.boolean(),
})

// ── Loop-prevention envelope ────────────────────────────────────────────

/**
 * `chain.depth` MUST equal `chain.path.length` — the second field is the
 * denormalized count of the first. Validating both shapes a request that
 * cannot lie about its own depth.
 */
export const consultChainSchema = z
  .object({
    path: z.array(z.string().min(1)),
    depth: z.number().int().min(0),
    budget: z.number().int().min(0),
  })
  .refine((c) => c.depth === c.path.length, {
    message: 'chain.depth must equal chain.path.length',
    path: ['depth'],
  })

// ── The primitive ───────────────────────────────────────────────────────

export const consultRequestSchema = z.object({
  target: z.object({
    workspaceId: z.string().min(1),
    assistantId: z.string().min(1),
    capabilityId: capabilityIdSchema.optional(),
  }),
  message: a2aMessageSchema,
  contextId: z.string().min(1).optional(),
  allowedTools: z.array(z.string().min(1)).optional(),
  depth: ResearchDepthConfigSchema.optional(),
  // Always a concrete saved_views id on the wire (the workflow executor
  // resolves create/fromStep variants before the consult).
  pageAnchorId: z.string().uuid().optional(),
  // Blueprint slug to fill on a research step (structural-synthesis P4).
  blueprintId: z.string().min(1).max(128).optional(),
  caller: callerIdentitySchema,
  chain: consultChainSchema,
})

export const consultResponseSchema = z.object({
  task: taskSchema,
})

// ── Errors ──────────────────────────────────────────────────────────────

const errorCodeValues = Object.values(ERROR_CODES) as [number, ...number[]]

export const consultErrorSchema = z.object({
  code: z.union(errorCodeValues.map((v) => z.literal(v)) as [
    z.ZodLiteral<number>,
    z.ZodLiteral<number>,
    ...z.ZodLiteral<number>[],
  ]),
  message: z.string().min(1),
  reason: z
    .enum([
      'cycle_detected',
      'depth_exceeded',
      'budget_exhausted',
      'capability_not_found',
      'sharing_blocked',
      'input_invalid',
    ])
    .optional(),
  data: z.unknown().optional(),
})
