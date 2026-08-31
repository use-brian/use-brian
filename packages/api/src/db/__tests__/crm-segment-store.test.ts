import { describe, expect, it } from 'vitest'
import { CrmOperationsError, type CrmSegmentCatalog, type CrmSegmentPredicate } from '@use-brian/core'
import { compileCrmSegmentPredicate } from '../crm-segment-store.js'

type InternalCatalogEntry = {
  family: 'base' | 'custom' | 'tag' | 'relationship' | 'consent' | 'suppression' | 'entitlement' | 'participation' | 'pipeline'
  operators: Array<'eq' | 'neq' | 'contains' | 'not_contains' | 'in' | 'not_in' | 'gte' | 'is_empty' | 'is_not_empty'>
  valueType: 'text' | 'number' | 'enum'
  sourceKey?: string
  sqlKind?: string
  validValues?: string[]
}

const fields = new Map<string, InternalCatalogEntry>([
  ['base:name', { family: 'base', operators: ['contains'], valueType: 'text' }],
  ['tag:tags', { family: 'tag', operators: ['in'], valueType: 'text' }],
  ['custom:audiences', { family: 'custom', operators: ['in'], valueType: 'enum', sqlKind: 'multi_select', validValues: ['partners', 'customers'] }],
  ['consent:newsletter', { family: 'consent', operators: ['eq'], valueType: 'enum', sourceKey: 'newsletter', validValues: ['granted', 'withdrawn', 'none'] }],
  ['entitlement:member', { family: 'entitlement', operators: ['eq'], valueType: 'enum', sourceKey: 'member', validValues: ['pending', 'active', 'expired', 'cancelled'] }],
  ['participation:annual_meeting', { family: 'participation', operators: ['eq'], valueType: 'enum', sourceKey: 'annual_meeting', validValues: ['registered', 'attended', 'cancelled', 'no_show'] }],
])
const catalog = { fields } as unknown as CrmSegmentCatalog

describe('[COMP:crm/segments] SQL compiler and collection-query parity', () => {
  it('compiles nested catalog rules into parameterized canonical CRM expressions', () => {
    const predicate: CrmSegmentPredicate = {
      type: 'group', combinator: 'and', items: [
        { type: 'rule', family: 'base', field: 'name', operator: 'contains', value: "O'Reilly" },
        { type: 'group', combinator: 'or', items: [
          { type: 'rule', family: 'tag', field: 'tags', operator: 'in', value: ['priority'] },
          { type: 'rule', family: 'custom', field: 'audiences', operator: 'in', value: ['partners'] },
        ] },
        { type: 'rule', family: 'consent', field: 'newsletter', operator: 'eq', value: 'granted' },
      ],
    }
    const compiled = compileCrmSegmentPredicate(predicate, catalog, 3)
    expect(compiled.sql).toContain("COALESCE((e.display_name)::text,'') ILIKE $3")
    expect(compiled.sql).toContain("COALESCE(e.attributes->'tags','[]'::jsonb) ?| $4::text[]")
    expect(compiled.sql).toContain("jsonb_array_elements_text")
    expect(compiled.sql).toContain("e.attributes->'custom_fields'->$5")
    expect(compiled.sql).toContain('association_consent_events')
    expect(compiled.sql).not.toContain("O'Reilly")
    expect(compiled.params).toEqual(["%O'Reilly%", ['priority'], 'audiences', ['partners'], 'newsletter', 'granted'])
  })

  it('uses the same tag and multi-select membership semantics as the CRM collection surface', () => {
    const predicate: CrmSegmentPredicate = {
      type: 'group', combinator: 'and', items: [
        { type: 'rule', family: 'tag', field: 'tags', operator: 'in', value: ['priority'] },
        { type: 'rule', family: 'custom', field: 'audiences', operator: 'in', value: ['partners'] },
      ],
    }
    const { sql } = compileCrmSegmentPredicate(predicate, catalog)
    // These are the two canonical membership expressions used by
    // `crm-r2.ts` collection filters: jsonb `?|` for tags and array-element
    // overlap for multi-select custom fields.
    expect(sql).toMatch(/attributes->'tags'.*\?\|/s)
    expect(sql).toMatch(/jsonb_array_elements_text[\s\S]*value = ANY/)
  })

  it('rejects unknown catalog keys before emitting SQL', () => {
    const predicate = {
      type: 'group', combinator: 'and', items: [
        { type: 'rule', family: 'base', field: 'email_guess', operator: 'contains', value: 'example' },
      ],
    } as CrmSegmentPredicate
    expect(() => compileCrmSegmentPredicate(predicate, catalog)).toThrow(CrmOperationsError)
    try { compileCrmSegmentPredicate(predicate, catalog) } catch (error) {
      expect(error).toMatchObject({
        code: 'catalog_key_invalid',
        details: { issues: [expect.objectContaining({ validValues: expect.arrayContaining(['base:name']) })] },
      })
    }
  })

  it('maps commerce registration states into canonical participation segment values', () => {
    const predicate: CrmSegmentPredicate = {
      type: 'group', combinator: 'and', items: [
        { type: 'rule', family: 'entitlement', field: 'member', operator: 'eq', value: 'active' },
        { type: 'rule', family: 'participation', field: 'annual_meeting', operator: 'eq', value: 'registered' },
      ],
    }
    const compiled = compileCrmSegmentPredicate(predicate, catalog)
    expect(compiled.sql).toContain('association_memberships')
    expect(compiled.sql).toContain("WHEN 'confirmed' THEN 'registered'")
    expect(compiled.sql).toContain("WHEN 'checked_in' THEN 'attended'")
    expect(compiled.params).toEqual(['member', 'active', 'annual_meeting', 'registered'])
  })
})
