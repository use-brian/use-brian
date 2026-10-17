import { describe, expect, it } from 'vitest'
import { ApplicationPlatformError, applicationCommandSchema, applicationDecimalSchema,
  applicationQuerySchema, applicationResourceRefSchema, applicationResourceSchema } from '../application-platform.js'

describe('[COMP:shared/application-platform] application wire boundaries', () => {
  const ref = { workspaceId: '10000000-0000-4000-8000-000000000001', origin: { kind: 'native', moduleKey: 'operations' },
    typeKey: 'purchase', id: 'same-local-id', version: '7' }
  it('requires a complete origin, workspace, type, ID and version', () => {
    expect(applicationResourceRefSchema.parse(ref)).toEqual(ref)
    for (const missing of ['workspaceId', 'origin', 'typeKey', 'id', 'version']) {
      expect(applicationResourceRefSchema.safeParse(Object.fromEntries(Object.entries(ref).filter(([key]) => key !== missing))).success).toBe(false)
    }
    expect(applicationResourceRefSchema.safeParse({ ...ref, ownerUserId: 'injected' }).success).toBe(false)
    expect(applicationResourceRefSchema.safeParse({ ...ref, origin: { kind: 'external', connectorInstanceId: ref.workspaceId } }).success).toBe(false)
  })
  it('rejects duplicate field and enum catalogs and inverted bounds', () => {
    const resource = { typeKey: 'purchase', origin: ref.origin, schemaVersion: '1' }
    const field = { key: 'state', label: 'State', kind: 'enum', options: ['open'] }
    expect(applicationResourceSchema.safeParse({ ...resource, fields: [field, field] }).success).toBe(false)
    expect(applicationResourceSchema.safeParse({ ...resource, fields: [{ ...field, options: ['open', 'open'] }] }).success).toBe(false)
    expect(applicationResourceSchema.safeParse({ ...resource, fields: [{ key: 'amount', label: 'Amount', kind: 'number', minimum: 10, maximum: 1 }] }).success).toBe(false)
  })
  it('caps query and batch vocabulary and refuses unknown operators/SQL', () => {
    expect(applicationQuerySchema.parse({}).limit).toBe(50)
    for (const input of [{ limit: 101 }, { limit: 0 }, { sql: 'SELECT *' }, { filters: [{ field: 'cost', op: 'execute', value: 1 }] }]) {
      expect(applicationQuerySchema.safeParse(input).success).toBe(false)
    }
  })
  it('preserves lossless decimals and rejects exponent, whitespace and non-finite inputs', () => {
    expect(applicationDecimalSchema.parse('12345678901234567890.123456789012345678')).toBe('12345678901234567890.123456789012345678')
    for (const value of ['1e2', ' 1', '01', 'NaN', '1.1234567890123456789', 1.2]) expect(applicationDecimalSchema.safeParse(value).success).toBe(false)
  })
  it('requires semantic idempotency and JSON input without provider code', () => {
    expect(applicationCommandSchema.safeParse({ input: {}, idempotencyKey: '' }).success).toBe(false)
    expect(applicationCommandSchema.safeParse({ input: { amount: Infinity }, idempotencyKey: 'once' }).success).toBe(false)
    expect(applicationCommandSchema.safeParse({ input: { run: () => 1 }, idempotencyKey: 'once' }).success).toBe(false)
  })
  it('keeps uncertain effect state separate from safe retry', () => {
    const error = new ApplicationPlatformError('outcome_uncertain', 'Reconcile the saved receipt.', 'uncertain')
    expect(error.retrySafe).toBe(false)
    expect(error.effect).toBe('uncertain')
  })
})
