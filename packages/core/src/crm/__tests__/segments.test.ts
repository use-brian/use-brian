import { describe, expect, it } from 'vitest'
import {
  CrmSegmentPredicateSchema,
  validateCrmSegmentCatalog,
} from '../segments.js'

describe('[COMP:crm/segments] bounded segment predicates', () => {
  it('parses nested boolean groups within the depth bound', () => {
    expect(CrmSegmentPredicateSchema.parse({
      type: 'group',
      combinator: 'and',
      items: [
        { type: 'rule', family: 'base', field: 'email', operator: 'is_not_empty' },
        {
          type: 'group',
          combinator: 'or',
          items: [
            { type: 'rule', family: 'tag', field: 'tags', operator: 'contains', value: 'member' },
            { type: 'rule', family: 'consent', field: 'newsletter', operator: 'eq', value: 'granted' },
          ],
        },
      ],
    }).items).toHaveLength(2)
  })

  it('rejects a fifth group level and missing values', () => {
    const tooDeep = (depth: number): unknown => depth === 0
      ? { type: 'rule', family: 'base', field: 'name', operator: 'eq' }
      : { type: 'group', combinator: 'and', items: [tooDeep(depth - 1)] }
    expect(CrmSegmentPredicateSchema.safeParse(tooDeep(5)).success).toBe(false)
  })

  it('fails closed with valid catalog fields and operators', () => {
    const predicate = CrmSegmentPredicateSchema.parse({
      type: 'group',
      combinator: 'and',
      items: [
        { type: 'rule', family: 'base', field: 'mystery', operator: 'eq', value: 'x' },
        { type: 'rule', family: 'base', field: 'amount', operator: 'contains', value: '10' },
      ],
    })
    const issues = validateCrmSegmentCatalog(predicate, {
      fields: new Map([
        ['base:email', { family: 'base' as const, operators: ['eq', 'contains'] as const }],
        ['base:amount', { family: 'base' as const, operators: ['eq', 'gt', 'gte', 'lt', 'lte'] as const }],
      ]),
    })
    expect(issues).toEqual([
      expect.objectContaining({ path: 'predicate.items.0.field', validValues: ['base:amount', 'base:email'] }),
      expect.objectContaining({ path: 'predicate.items.1.operator', validValues: ['eq', 'gt', 'gte', 'lt', 'lte'] }),
    ])
  })
})
