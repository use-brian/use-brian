import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createGoogleCalendarTools, type GoogleCalendarApi } from '../base/google-calendar.js'
import { LAYER_1_SYSTEM_PROMPT } from '../../system-prompt.js'

// ── Helpers ──────────────────────────────────────────────────

const ctx = {
  userId: 'test-user',
  assistantId: 'test-assistant',
  sessionId: 'test-session',
  appId: 'test',
  channelType: 'web' as const,
  channelId: 'test-channel',
  abortSignal: new AbortController().signal,
}

function mockApi(overrides?: Partial<GoogleCalendarApi>): GoogleCalendarApi {
  return {
    listEvents: vi.fn().mockResolvedValue([]),
    getEvent: vi.fn().mockResolvedValue({ id: 'evt1', summary: 'Test Event' }),
    createEvent: vi.fn().mockResolvedValue({ id: 'evt-new' }),
    updateEvent: vi.fn().mockResolvedValue({ id: 'evt1', summary: 'Updated' }),
    deleteEvent: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

/**
 * Mirrors the production jsonSchemaFromZod / zodFieldToJsonSchema
 * from packages/core/src/engine/query-loop.ts.
 *
 * This is intentionally duplicated (not imported) because query-loop.ts
 * doesn't export these functions. If the production converter changes,
 * the zod-to-json-schema.test.ts snapshot tests will catch divergence.
 */
type TP = { type: string;[key: string]: unknown }

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
      if (fieldSchema._def.typeName !== 'ZodOptional') required.push(key)
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
      if (def.description && !inner.description) inner.description = def.description as string
      return inner
    }
    case 'ZodEnum':
      return { type: 'string', enum: def.values as string[], ...(def.description ? { description: def.description as string } : {}) }
    case 'ZodArray':
      return { type: 'array', items: zodFieldToJsonSchema({ _def: (def.type as { _def: Record<string, unknown> })._def }) }
    case 'ZodLiteral':
      return { type: 'string', enum: [String(def.value)] }
    case 'ZodObject':
      return jsonSchemaFromZod(field)
    default:
      return { type: 'string' }
  }
}

// ── Tests ────────────────────────────────────────────────────

describe('[COMP:tools/google-calendar] Google Calendar tools', () => {
  it('creates all 5 calendar tools', () => {
    const tools = createGoogleCalendarTools(mockApi())
    expect(tools).toHaveLength(5)
    expect(tools.map((t) => t.name).sort()).toEqual([
      'googleCalendarCreateEvent',
      'googleCalendarDeleteEvent',
      'googleCalendarGetEvent',
      'googleCalendarListEvents',
      'googleCalendarUpdateEvent',
    ])
  })

  // ── RSVP schema visibility ──────────────────────────────────
  // These tests guard against the bug where Gemini couldn't see the
  // responseStatus field and told users "I can't change RSVP directly."

  it('updateEvent inputSchema includes responseStatus with enum values', () => {
    const tools = createGoogleCalendarTools(mockApi())
    const updateTool = tools.find((t) => t.name === 'googleCalendarUpdateEvent')!
    const schema = updateTool.inputSchema as z.ZodObject<Record<string, z.ZodTypeAny>>
    const shape = schema.shape

    expect(shape.responseStatus).toBeDefined()

    // Unwrap ZodOptional to get the inner ZodEnum
    const innerDef = (shape.responseStatus as z.ZodOptional<z.ZodEnum<[string, ...string[]]>>)._def
    expect(innerDef.typeName).toBe('ZodOptional')
    const enumDef = (innerDef.innerType as z.ZodEnum<[string, ...string[]]>)._def
    expect(enumDef.typeName).toBe('ZodEnum')
    expect(enumDef.values).toEqual(['accepted', 'declined', 'tentative'])
  })

  it('responseStatus survives Zod-to-JSON-Schema conversion (what Gemini sees)', () => {
    const tools = createGoogleCalendarTools(mockApi())
    const updateTool = tools.find((t) => t.name === 'googleCalendarUpdateEvent')!
    const jsonSchema = jsonSchemaFromZod(updateTool.inputSchema)

    // responseStatus must exist in the converted schema
    expect(jsonSchema.properties.responseStatus).toBeDefined()
    expect(jsonSchema.properties.responseStatus.type).toBe('string')
    expect(jsonSchema.properties.responseStatus.enum).toEqual(['accepted', 'declined', 'tentative'])
    // Must have a description so the model knows what it does
    expect(jsonSchema.properties.responseStatus.description).toBeTruthy()
    expect(jsonSchema.properties.responseStatus.description).toMatch(/RSVP/i)
  })

  it('responseStatus is optional (not in required array)', () => {
    const tools = createGoogleCalendarTools(mockApi())
    const updateTool = tools.find((t) => t.name === 'googleCalendarUpdateEvent')!
    const jsonSchema = jsonSchemaFromZod(updateTool.inputSchema)

    // responseStatus should NOT be required — it's only used for RSVP updates
    expect(jsonSchema.required ?? []).not.toContain('responseStatus')
    // eventId should be required
    expect(jsonSchema.required).toContain('eventId')
  })

  it('updateEvent tool description mentions RSVP', () => {
    const tools = createGoogleCalendarTools(mockApi())
    const updateTool = tools.find((t) => t.name === 'googleCalendarUpdateEvent')!
    expect(updateTool.description).toMatch(/RSVP/i)
    expect(updateTool.description).toMatch(/responseStatus/)
  })

  // ── RSVP execution passthrough ──────────────────────────────

  it('passes responseStatus through to api.updateEvent', async () => {
    const api = mockApi()
    const tools = createGoogleCalendarTools(api)
    const updateTool = tools.find((t) => t.name === 'googleCalendarUpdateEvent')!

    await updateTool.execute({
      eventId: 'evt-123',
      responseStatus: 'tentative',
    }, ctx)

    expect(api.updateEvent).toHaveBeenCalledWith('evt-123', {
      responseStatus: 'tentative',
    })
  })

  it('passes responseStatus "accepted" through to api.updateEvent', async () => {
    const api = mockApi()
    const tools = createGoogleCalendarTools(api)
    const updateTool = tools.find((t) => t.name === 'googleCalendarUpdateEvent')!

    await updateTool.execute({
      eventId: 'evt-456',
      responseStatus: 'accepted',
    }, ctx)

    expect(api.updateEvent).toHaveBeenCalledWith('evt-456', {
      responseStatus: 'accepted',
    })
  })

  it('passes responseStatus "declined" through to api.updateEvent', async () => {
    const api = mockApi()
    const tools = createGoogleCalendarTools(api)
    const updateTool = tools.find((t) => t.name === 'googleCalendarUpdateEvent')!

    await updateTool.execute({
      eventId: 'evt-789',
      responseStatus: 'declined',
    }, ctx)

    expect(api.updateEvent).toHaveBeenCalledWith('evt-789', {
      responseStatus: 'declined',
    })
  })

  it('strips current* fields before calling api.updateEvent', async () => {
    const api = mockApi()
    const tools = createGoogleCalendarTools(api)
    const updateTool = tools.find((t) => t.name === 'googleCalendarUpdateEvent')!

    await updateTool.execute({
      eventId: 'evt-123',
      responseStatus: 'tentative',
      currentSummary: 'Old Title',
      currentStart: '2026-04-10T00:00:00Z',
      currentEnd: '2026-04-11T00:00:00Z',
      currentAttendees: ['a@b.com'],
    }, ctx)

    // current* fields should be stripped — only responseStatus passed
    expect(api.updateEvent).toHaveBeenCalledWith('evt-123', {
      responseStatus: 'tentative',
    })
  })

  it('can combine responseStatus with other field updates', async () => {
    const api = mockApi()
    const tools = createGoogleCalendarTools(api)
    const updateTool = tools.find((t) => t.name === 'googleCalendarUpdateEvent')!

    await updateTool.execute({
      eventId: 'evt-123',
      responseStatus: 'accepted',
      location: 'Room 42',
    }, ctx)

    expect(api.updateEvent).toHaveBeenCalledWith('evt-123', {
      responseStatus: 'accepted',
      location: 'Room 42',
    })
  })

  // ── System prompt guardrail ─────────────────────────────────

  it('updateEvent tool description covers RSVP / responseStatus', () => {
    // The RSVP instruction lives in the tool description (not the system prompt)
    // so it's only visible to the model when calendar tools are actually available.
    const tools = createGoogleCalendarTools(mockApi())
    const updateTool = tools.find((t) => t.name === 'googleCalendarUpdateEvent')!
    expect(updateTool.description).toMatch(/responseStatus/)
    expect(updateTool.description).toMatch(/RSVP/i)
  })

  it('system prompt tells model to never ask for text confirmation on tool actions', () => {
    // Guard against double confirmation: the model asking "Is that okay?" /
    // "Just to confirm..." in text AND the tool showing an Approve/Deny UI card.
    expect(LAYER_1_SYSTEM_PROMPT).toMatch(/NEVER ask/)
    expect(LAYER_1_SYSTEM_PROMPT).toMatch(/Approve\/Deny button/)
    expect(LAYER_1_SYSTEM_PROMPT).toMatch(/Just to confirm/i)
  })

  it('write tools have requiresConfirmation set so the UI handles confirmation', () => {
    const tools = createGoogleCalendarTools(mockApi())
    const createTool = tools.find((t) => t.name === 'googleCalendarCreateEvent')!
    const updateTool = tools.find((t) => t.name === 'googleCalendarUpdateEvent')!
    const deleteTool = tools.find((t) => t.name === 'googleCalendarDeleteEvent')!

    expect(createTool.requiresConfirmation).toBe(true)
    expect(updateTool.requiresConfirmation).toBe(true)
    expect(deleteTool.requiresConfirmation).toBe(true)
  })

  // ── Timezone passthrough ──────────────────────────────────────

  it('passes userTimezone to listEvents API call', async () => {
    const api = mockApi()
    const tools = createGoogleCalendarTools(api, 'Asia/Taipei')
    const listTool = tools.find((t) => t.name === 'googleCalendarListEvents')!

    await listTool.execute({}, ctx)

    expect(api.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: 'Asia/Taipei' }),
    )
  })

  it('omits timeZone when userTimezone is not provided', async () => {
    const api = mockApi()
    const tools = createGoogleCalendarTools(api)
    const listTool = tools.find((t) => t.name === 'googleCalendarListEvents')!

    await listTool.execute({}, ctx)

    expect(api.listEvents).toHaveBeenCalledWith(
      expect.objectContaining({ timeZone: undefined }),
    )
  })

  it('enriches listEvents results with localStart/localEnd in user timezone', async () => {
    const api = mockApi({
      listEvents: vi.fn().mockResolvedValue([
        {
          id: 'evt1',
          summary: 'Test Meeting',
          start: { dateTime: '2026-04-17T08:15:00Z' },
          end: { dateTime: '2026-04-17T09:15:00Z' },
        },
      ]),
    })
    const tools = createGoogleCalendarTools(api, 'Asia/Hong_Kong')
    const listTool = tools.find((t) => t.name === 'googleCalendarListEvents')!

    const result = await listTool.execute({}, ctx)
    const events = result.data as Array<{ localStart: string; localEnd: string }>

    // 08:15 UTC = 16:15 HKT
    expect(events[0].localStart).toMatch(/4:15\s*PM/)
    expect(events[0].localEnd).toMatch(/5:15\s*PM/)
  })

  it('enriches getEvent result with localStart/localEnd in user timezone', async () => {
    const api = mockApi({
      getEvent: vi.fn().mockResolvedValue({
        id: 'evt1',
        summary: 'Test Meeting',
        start: { dateTime: '2026-04-17T08:15:00Z' },
        end: { dateTime: '2026-04-17T09:15:00Z' },
      }),
    })
    const tools = createGoogleCalendarTools(api, 'Asia/Hong_Kong')
    const getTool = tools.find((t) => t.name === 'googleCalendarGetEvent')!

    const result = await getTool.execute({ eventId: 'evt1' }, ctx)
    const event = result.data as { localStart: string; localEnd: string }

    expect(event.localStart).toMatch(/4:15\s*PM/)
    expect(event.localEnd).toMatch(/5:15\s*PM/)
  })

  it('projects events with UTC localStart when userTimezone is not provided', async () => {
    // Result projection is unconditional (2026-06-11 MCP precision pass): even
    // without a user timezone the event is slimmed to the documented fields and
    // localStart/localEnd are formatted in UTC, never the raw ~40-field object.
    const api = mockApi({
      listEvents: vi.fn().mockResolvedValue([
        {
          id: 'evt1',
          summary: 'Test',
          start: { dateTime: '2026-04-17T08:15:00Z' },
          end: { dateTime: '2026-04-17T09:15:00Z' },
          // Noise fields the projection must drop:
          iCalUID: 'x', etag: 'y', sequence: 3, htmlLink: 'http://h',
        },
      ]),
    })
    const tools = createGoogleCalendarTools(api)
    const listTool = tools.find((t) => t.name === 'googleCalendarListEvents')!

    const result = await listTool.execute({}, ctx)
    const events = result.data as Array<Record<string, unknown>>

    expect(events[0]).toHaveProperty('localStart')
    expect(events[0]).toMatchObject({ id: 'evt1', summary: 'Test' })
    // Raw noise dropped by the projection.
    expect(events[0]).not.toHaveProperty('iCalUID')
    expect(events[0]).not.toHaveProperty('etag')
    expect(events[0]).not.toHaveProperty('sequence')
  })

  it('tool descriptions must NOT say "Requires confirmation" (causes double-confirm)', () => {
    // The model reads tool descriptions and if it sees "Requires confirmation
    // before executing", it asks the user in text BEFORE calling the tool —
    // then the UI ALSO shows Approve/Deny. This creates double confirmation.
    // The requiresConfirmation flag on the tool definition handles it mechanically.
    const tools = createGoogleCalendarTools(mockApi())
    for (const tool of tools) {
      expect(tool.description).not.toMatch(/[Rr]equires confirmation/)
    }
  })
})
