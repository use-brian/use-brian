import { describe, expect, it } from 'vitest'
import {
  CrmSegmentPredicateSchema,
  validateCrmSegmentCatalog,
  type CrmSegmentCatalog,
  type CrmSegmentPredicate,
} from '../segments.js'

const catalog: CrmSegmentCatalog = {
  fields: new Map([
    ['base:name', { family: 'base', operators: ['eq', 'contains'], valueType: 'text' }],
    ['custom:score', { family: 'custom', operators: ['eq', 'gte'], valueType: 'number' }],
    ['consent:newsletter', {
      family: 'consent', operators: ['eq', 'in'], valueType: 'enum',
      validValues: ['granted', 'withdrawn', 'none'],
    }],
  ]),
}

describe('[COMP:crm/segments] bounded predicate contracts', () => {
  it('accepts nested predicates within the four-level and one-hundred-item bounds', () => {
    const predicate: CrmSegmentPredicate = {
      type: 'group', combinator: 'and', items: [
        { type: 'rule', family: 'base', field: 'name', operator: 'contains', value: 'Example' },
        { type: 'group', combinator: 'or', items: [
          { type: 'rule', family: 'custom', field: 'score', operator: 'gte', value: 10 },
          { type: 'rule', family: 'consent', field: 'newsletter', operator: 'eq', value: 'granted' },
        ] },
      ],
    }
    expect(CrmSegmentPredicateSchema.parse(predicate)).toEqual(predicate)
    expect(validateCrmSegmentCatalog(predicate, catalog)).toEqual([])
  })

  it('fails closed with enumerable fields, operators, and values', () => {
    const unknown = CrmSegmentPredicateSchema.parse({
      type: 'group', combinator: 'and', items: [
        { type: 'rule', family: 'base', field: 'guessed_field', operator: 'eq', value: 'x' },
      ],
    })
    expect(validateCrmSegmentCatalog(unknown, catalog)[0]).toMatchObject({
      path: 'predicate.items.0.field',
      validValues: ['base:name', 'consent:newsletter', 'custom:score'],
    })

    const invalidOperator = CrmSegmentPredicateSchema.parse({
      type: 'group', combinator: 'and', items: [
        { type: 'rule', family: 'custom', field: 'score', operator: 'contains', value: 10 },
      ],
    })
    expect(validateCrmSegmentCatalog(invalidOperator, catalog)[0]).toMatchObject({
      path: 'predicate.items.0.operator', validValues: ['eq', 'gte'],
    })

    const invalidValue = CrmSegmentPredicateSchema.parse({
      type: 'group', combinator: 'and', items: [
        { type: 'rule', family: 'consent', field: 'newsletter', operator: 'eq', value: 'maybe' },
      ],
    })
    expect(validateCrmSegmentCatalog(invalidValue, catalog)[0]).toMatchObject({
      path: 'predicate.items.0.value', validValues: ['granted', 'withdrawn', 'none'],
    })
  })

  it('rejects a fifth nested group and unbounded list operands', () => {
    const rule = { type: 'rule', family: 'base', field: 'name', operator: 'eq', value: 'x' }
    const tooDeep = {
      type: 'group', combinator: 'and', items: [{
        type: 'group', combinator: 'and', items: [{
          type: 'group', combinator: 'and', items: [{
            type: 'group', combinator: 'and', items: [{ type: 'group', combinator: 'and', items: [rule] }],
          }],
        }],
      }],
    }
    expect(CrmSegmentPredicateSchema.safeParse(tooDeep).success).toBe(false)

    const tooManyValues = CrmSegmentPredicateSchema.parse({
      type: 'group', combinator: 'and', items: [
        { type: 'rule', family: 'consent', field: 'newsletter', operator: 'in', value: Array.from({ length: 101 }, () => 'granted') },
      ],
    })
    expect(validateCrmSegmentCatalog(tooManyValues, catalog)[0]?.message).toContain('between 1 and 100')
  })
})
