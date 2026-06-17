import { describe, it, expect } from 'vitest'
import { z } from 'zod'

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
      if (fieldSchema._def.typeName !== 'ZodOptional') {
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
