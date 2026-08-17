import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { actionableInputSchema } from '../actionable-input-schema.js'

// The SDK's validateToolInput calls the registered schema's safeParseAsync
// and, on failure, renders getParseErrorMessage(error) — which prefers
// `error.message`. These tests assert the message it will see.
describe('[COMP:api/brain-mcp-input-validation] actionableInputSchema', () => {
  const shape = {
    summary: z.string().min(1),
    status: z.enum(['todo', 'done']).or(z.array(z.enum(['todo', 'done']))).optional(),
  }

  it('valid input parses unchanged (defaults/coercions preserved)', async () => {
    const schema = actionableInputSchema({ n: z.coerce.number().default(5) }, 'listTasks')
    const r = await schema.safeParseAsync({})
    expect(r.success).toBe(true)
    if (r.success) expect(r.data).toEqual({ n: 5 })
  })

  it('a failure message is compact path: message lines + retry verdict, never the issues JSON', async () => {
    const schema = actionableInputSchema(shape, 'listTasks')
    const r = await schema.safeParseAsync({ summary: '', status: 'urgent' })
    expect(r.success).toBe(false)
    if (r.success) return
    const msg = (r.error as { message: string }).message
    expect(msg).toMatch(/^Validation failed:/)
    expect(msg).toContain('summary:')
    expect(msg).toContain('status:')
    expect(msg).toContain('call `listTasks` again')
    expect(msg).toContain('the same arguments will fail the same way')
    // The SDK-default blob shape must be gone.
    expect(msg).not.toContain('"code":')
    expect(msg).not.toContain('unionErrors')
    // Issues stay available for callers that want structure.
    expect(Array.isArray((r.error as { issues: unknown[] }).issues)).toBe(true)
  })

  it('the sync safeParse path renders the same message', () => {
    const schema = actionableInputSchema(shape, 'listTasks')
    const r = schema.safeParse({ summary: '' })
    expect(r.success).toBe(false)
    if (r.success) return
    expect((r.error as { message: string }).message).toContain('summary:')
  })

  it('wrapping an existing ZodObject does not mutate the original schema', async () => {
    const original = z.object({ a: z.string() })
    const originalParse = original.safeParseAsync.bind(original)
    actionableInputSchema(original, 'toolX')
    const r = await originalParse({ a: 1 })
    expect(r.success).toBe(false)
    if (r.success) return
    // Original still yields the stock ZodError message (the JSON), proving
    // the override landed on a copy.
    expect(r.error.message).toContain('"code":')
  })

  it('keeps the shape visible for the SDK tools/list JSON-schema conversion', () => {
    const schema = actionableInputSchema(shape, 'listTasks')
    expect(Object.keys(schema.shape)).toEqual(['summary', 'status'])
  })
})
