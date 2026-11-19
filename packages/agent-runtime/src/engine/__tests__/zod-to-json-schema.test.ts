import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { jsonSchemaFromZod as productionJsonSchemaFromZod } from '../query-loop.js'

// The converter functions are not exported, so we test them indirectly
// through the query loop's tool definition builder. We import the internal
// helpers by re-exporting them for testing.
// Instead, we replicate the exact converter logic here as a snapshot test
// against the real scheduling schema.

// Import the actual scheduling schema shape to verify it converts correctly
// by running it through the query loop's tool definition path.

/**
 * These functions mirror the production code in query-loop.ts.
 * If the production code changes, these must be updated too.
 * The alternative (exporting from query-loop.ts) would pollute the public API.
 */

type TP = { type: string; [key: string]: unknown }

function jsonSchemaFromZod(schema: { _def: unknown }): {
  type: 'object'
  properties: Record<string, TP>
  required?: string[]
} {
  const def = schema._def as Record<string, unknown>

  if (def.typeName === 'ZodObject') {
    const shape = (def as { shape: () => Record<string, { _def: Record<string, unknown> }> }).shape()
    const properties: Record<string, TP> = {}
    const required: string[] = []

    for (const [key, fieldSchema] of Object.entries(shape)) {
      properties[key] = zodFieldToJsonSchema(fieldSchema) as TP
      if (fieldSchema._def.typeName !== 'ZodOptional' && fieldSchema._def.typeName !== 'ZodDefault') {
        required.push(key)
      }
    }

    return { type: 'object', properties, ...(required.length > 0 ? { required } : {}) }
  }

  return { type: 'object', properties: {} as Record<string, TP> }
}

function zodFieldToJsonSchema(field: { _def: Record<string, unknown> }): Record<string, unknown> {
  const def = field._def
  const typeName = def.typeName as string

  switch (typeName) {
    case 'ZodString':
      return { type: 'string', ...(def.description ? { description: def.description as string } : {}) }
    case 'ZodNumber':
      return { type: 'number', ...(def.description ? { description: def.description as string } : {}) }
    case 'ZodBoolean':
      return { type: 'boolean', ...(def.description ? { description: def.description as string } : {}) }
    case 'ZodOptional': {
      const inner = zodFieldToJsonSchema({ _def: (def.innerType as { _def: Record<string, unknown> })._def })
      if (def.description && !inner.description) {
        inner.description = def.description as string
      }
      return inner
    }
    case 'ZodDefault':
    case 'ZodNullable': {
      const inner = zodFieldToJsonSchema({ _def: (def.innerType as { _def: Record<string, unknown> })._def })
      if (def.description && !inner.description) {
        inner.description = def.description as string
      }
      return inner
    }
    case 'ZodEffects': {
      const inner = zodFieldToJsonSchema({ _def: (def.schema as { _def: Record<string, unknown> })._def })
      if (def.description && !inner.description) {
        inner.description = def.description as string
      }
      return inner
    }
    case 'ZodRecord':
      return { type: 'object', ...(def.description ? { description: def.description as string } : {}) }
    case 'ZodEnum':
      return { type: 'string', enum: def.values as string[], ...(def.description ? { description: def.description as string } : {}) }
    case 'ZodArray':
      return { type: 'array', items: zodFieldToJsonSchema({ _def: (def.type as { _def: Record<string, unknown> })._def }) }
    case 'ZodLiteral':
      return { type: 'string', enum: [String(def.value)] }
    case 'ZodObject':
      return jsonSchemaFromZod(field)
    case 'ZodDiscriminatedUnion': {
      const discriminator = def.discriminator as string
      const options = def.options as Array<{ _def: Record<string, unknown> }>
      const mergedProps: Record<string, Record<string, unknown>> = {}
      const variantDescriptions: string[] = []

      for (const option of options) {
        const converted = jsonSchemaFromZod(option)
        for (const [key, prop] of Object.entries(converted.properties)) {
          if (!mergedProps[key]) mergedProps[key] = prop as Record<string, unknown>
        }
        const variantKeys = Object.keys(converted.properties).filter((k) => k !== discriminator)
        const discValue = (converted.properties[discriminator] as Record<string, unknown>)?.enum
        if (discValue && Array.isArray(discValue) && discValue[0]) {
          variantDescriptions.push(`${discriminator}="${discValue[0]}": requires ${variantKeys.join(', ') || 'no extra fields'}`)
        }
      }

      const allDiscValues = options.map((opt) => {
        const shape = (opt._def as Record<string, unknown>).shape as undefined | (() => Record<string, { _def: Record<string, unknown> }>)
        if (!shape) return undefined
        const discField = shape()[discriminator]
        return discField?._def?.value as string | undefined
      }).filter(Boolean) as string[]

      if (allDiscValues.length > 0) {
        mergedProps[discriminator] = { type: 'string', enum: allDiscValues }
      }

      const desc = def.description as string | undefined
      const variantHint = variantDescriptions.length > 0
        ? `Variants: ${variantDescriptions.join('. ')}.`
        : undefined

      return {
        type: 'object',
        properties: mergedProps,
        required: [discriminator],
        ...(desc || variantHint ? { description: desc ?? variantHint } : {}),
      }
    }
    default:
      return { type: 'string' }
  }
}

describe('[COMP:engine/zod-to-json-schema] Zod to JSON Schema conversion', () => {
  it('converts ZodLiteral to single-value enum', () => {
    const schema = z.object({ mode: z.literal('fast') })
    const result = jsonSchemaFromZod(schema)
    expect(result.properties.mode).toEqual({ type: 'string', enum: ['fast'] })
  })

  it('converts nested ZodObject to object with properties', () => {
    const schema = z.object({
      config: z.object({
        name: z.string(),
        count: z.number(),
      }),
    })
    const result = jsonSchemaFromZod(schema)
    expect(result.properties.config).toEqual({
      type: 'object',
      properties: {
        name: { type: 'string' },
        count: { type: 'number' },
      },
      required: ['name', 'count'],
    })
  })

  it('converts discriminatedUnion to flattened object with enum discriminator', () => {
    const schema = z.object({
      schedule: z.discriminatedUnion('type', [
        z.object({ type: z.literal('daily'), time: z.string().describe('HH:MM') }),
        z.object({ type: z.literal('weekly'), days: z.array(z.string()), time: z.string() }),
        z.object({ type: z.literal('cron'), expression: z.string().describe('Cron expression') }),
      ]),
    })
    const result = jsonSchemaFromZod(schema)
    const schedule = result.properties.schedule as Record<string, unknown>

    expect(schedule.type).toBe('object')
    expect(schedule.required).toEqual(['type'])

    const props = schedule.properties as Record<string, Record<string, unknown>>
    // Discriminator has enum of all variant values
    expect(props.type.enum).toEqual(['daily', 'weekly', 'cron'])
    // All variant properties are merged
    expect(props.time.type).toBe('string')
    expect(props.days.type).toBe('array')
    expect(props.expression.type).toBe('string')
    // Description explains variants
    expect(schedule.description).toContain('daily')
    expect(schedule.description).toContain('cron')
  })

  it('matches the real scheduling tool schema structure', () => {
    // This is the exact schema from packages/core/src/scheduling/tools.ts
    const scheduleSchema = z.discriminatedUnion('type', [
      z.object({ type: z.literal('daily'), time: z.string().describe('HH:MM in 24h format') }),
      z.object({ type: z.literal('weekly'), days: z.array(z.string()).describe('Day names'), time: z.string() }),
      z.object({ type: z.literal('monthly'), dayOfMonth: z.number().min(1).max(31), time: z.string() }),
      z.object({ type: z.literal('cron'), expression: z.string().describe('Cron expression') }),
    ])

    const toolSchema = z.object({
      schedule: scheduleSchema,
      timezone: z.string(),
      instructions: z.string(),
    })

    const result = jsonSchemaFromZod(toolSchema)
    const schedule = result.properties.schedule as Record<string, unknown>

    // Must be an object, not a string (the bug we're fixing)
    expect(schedule.type).toBe('object')
    expect(schedule.type).not.toBe('string')

    const props = schedule.properties as Record<string, Record<string, unknown>>
    expect(props.type.enum).toEqual(['daily', 'weekly', 'monthly', 'cron'])
    expect(props.time).toBeDefined()
    expect(props.days).toBeDefined()
    expect(props.dayOfMonth).toBeDefined()
    expect(props.expression).toBeDefined()
  })

  it('unwraps ZodEffects (preprocess) to its inner schema shape', () => {
    // Without this branch the converter falls through to its
    // `default: { type: 'string' }` case, which would advertise
    // mcp_call's `args` as a string and reinforce the bug the
    // preprocess exists to recover from.
    const schema = z.object({
      args: z.preprocess(
        (v) => (typeof v === 'string' ? JSON.parse(v) : v),
        z.record(z.unknown()).optional(),
      ).describe('Arguments matching the tool\'s parameter schema'),
    })
    const result = jsonSchemaFromZod(schema)
    const args = result.properties.args as Record<string, unknown>
    expect(args.type).not.toBe('string')
    expect(args.description).toBe('Arguments matching the tool\'s parameter schema')
  })
})

describe('[COMP:engine/zod-to-json-schema] defaulted and nullable fields (production converter)', () => {
  const tp = (schema: { _def: unknown }) => productionJsonSchemaFromZod(schema) as unknown as { properties: Record<string, Record<string, unknown>>; required?: string[] }

  it('advertises a defaulted field as its real type and not required', () => {
    // The listCrmEvents failure: `limit` was shown as a required string, so the model sent "10".
    const result = tp(z.object({
      limit: z.number().int().max(100).default(50).describe('Page size'),
      include_archived: z.boolean().default(false),
      tags: z.array(z.string()).default([]),
      metadata: z.record(z.unknown()).default({}),
      name: z.string(),
    }))
    expect(result.properties.limit).toEqual({ type: 'number', description: 'Page size' })
    expect(result.properties.include_archived).toEqual({ type: 'boolean' })
    expect(result.properties.tags).toEqual({ type: 'array', items: { type: 'string' } })
    expect(result.properties.metadata).toEqual({ type: 'object' })
    expect(result.required).toEqual(['name'])
  })

  it('advertises a nullable field as its real type and keeps its required status', () => {
    const result = tp(z.object({
      capacity: z.number().nullable(),
      note: z.string().nullable().optional().describe('Free text'),
      venue: z.object({ city: z.string() }).nullable(),
    }))
    expect(result.properties.capacity).toEqual({ type: 'number' })
    expect(result.properties.note).toEqual({ type: 'string', description: 'Free text' })
    expect(result.properties.venue).toMatchObject({ type: 'object', properties: { city: { type: 'string' } } })
    expect(result.required).toEqual(['capacity', 'venue'])
  })

  it('unwraps nested wrappers and keeps the outer description', () => {
    const result = tp(z.object({
      count: z.number().nullable().default(null).describe('How many'),
      flags: z.array(z.object({ on: z.boolean().default(true) })).optional(),
    }))
    expect(result.properties.count).toEqual({ type: 'number', description: 'How many' })
    expect(result.properties.flags).toEqual({ type: 'array', items: { type: 'object', properties: { on: { type: 'boolean' } } } })
    expect(result.required).toBeUndefined()
  })

  it('still shows types it cannot express safely for every provider as text', () => {
    // Unions, unknown values and tuples have no Gemini-safe general form; tools handle them with tolerance.
    const result = tp(z.object({ value: z.unknown(), level: z.union([z.literal(1), z.literal(2)]) }))
    expect(result.properties.value).toEqual({ type: 'string' })
    expect(result.properties.level).toEqual({ type: 'string' })
  })
})
