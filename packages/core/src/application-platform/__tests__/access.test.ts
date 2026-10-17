import { describe, expect, it } from 'vitest'
import type { PropertyDef } from '../../entities/doc-types.js'
import { applicationDecimalUnits, canonicalApplicationDecimal, validateApplicationValues,
  validateDocApplicationSchema, validateDocApplicationValues } from '../values.js'

describe('[COMP:security/application-access] canonical application value admission', () => {
  const properties: PropertyDef[] = [
    { name: 'title', config: { kind: 'text' }, required: true },
    { name: 'quantity', config: { kind: 'number', format: 'int', minimum: 1, maximum: 10 } },
    { name: 'state', config: { kind: 'select', options: [{ id: 'open', name: 'Open' }] } },
    { name: 'delivery', config: { kind: 'date', supportRange: true } },
  ]
  const title = { title: { kind: 'text' as const, value: 'Request' } }
  it('validates required, declared, finite, enum, kind and bounded values', () => {
    expect(() => validateDocApplicationValues(properties, { ...title, quantity: { kind: 'number', value: 3 } })).not.toThrow()
    for (const data of [{}, { ...title, extra: { kind: 'text', value: 'hidden' } }, { ...title, title: { kind: 'number', value: 3 } },
      { ...title, quantity: { kind: 'number', value: Infinity } }, { ...title, quantity: { kind: 'number', value: 0 } },
      { ...title, quantity: { kind: 'number', value: 1.5 } }, { ...title, state: { kind: 'select', value: 'closed' } }]) {
      expect(() => validateDocApplicationValues(properties, data as Parameters<typeof validateDocApplicationValues>[1])).toThrow()
    }
  })
  it('refuses nonexistent calendar dates and reversed or undeclared ranges', () => {
    for (const value of [{ start: '2026-02-30' }, { start: '2026-01-03', end: '2026-01-02' }, { start: 'not-a-date' }]) {
      expect(() => validateDocApplicationValues(properties, { ...title, delivery: { kind: 'date', value } })).toThrow()
    }
    expect(() => validateDocApplicationValues(properties, { ...title, delivery: { kind: 'date', value: { start: '2026-02-28', end: '2026-03-01' } } })).not.toThrow()
  })
  it('protects system cells while accepting their unchanged prior value', () => {
    const schema: PropertyDef[] = [{ name: 'created', config: { kind: 'created_time' } }]
    const data = { created: { kind: 'created_time' as const, value: '2026-01-01T00:00:00Z' } }
    expect(() => validateDocApplicationValues(schema, data)).toThrow()
    expect(() => validateDocApplicationValues(schema, data, data)).not.toThrow()
    expect(() => validateDocApplicationValues(schema, { created: { kind: 'created_time', value: '2027-01-01T00:00:00Z' } }, data)).toThrow()
  })
  it('refuses ambiguous schemas before storage', () => {
    for (const schema of [[properties[0], properties[0]], [{ name: 'constructor', config: { kind: 'text' as const } }],
      [{ name: 'cost', config: { kind: 'number' as const, minimum: 10, maximum: 1 } }],
      [{ name: 'tags', unique: true, config: { kind: 'multi_select' as const, options: [] } }]]) {
      expect(() => validateDocApplicationSchema(schema)).toThrow()
    }
  })
  it('calculates currency through integer units without floating-point rounding', () => {
    expect(canonicalApplicationDecimal('-0.000')).toBe('0')
    expect(canonicalApplicationDecimal('12.500', 3)).toBe('12.5')
    expect(applicationDecimalUnits('12.50', 2) * 3n).toBe(3750n)
    expect(applicationDecimalUnits('9007199254740993.01', 2)).toBe(900719925474099301n)
    expect(() => applicationDecimalUnits('1.001', 2)).toThrow()
  })
  it('validates native lossless decimals and required/immutable fields before business commands', () => {
    const schema = { typeKey: 'order', schemaVersion: '1', origin: { kind: 'native' as const, moduleKey: 'operations' },
      fields: [{ key: 'cost', label: 'Cost', kind: 'decimal' as const, scale: 2, required: true }] }
    expect(validateApplicationValues(schema, { cost: '0.10' })).toEqual({ cost: '0.10' })
    expect(() => validateApplicationValues(schema, { cost: 0.1 })).toThrow()
    expect(() => validateApplicationValues(schema, { cost: '0.100' })).toThrow()
  })
})
