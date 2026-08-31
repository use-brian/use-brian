/**
 * Bounded, closed-world dynamic segment predicate contracts.
 *
 * [COMP:crm/segments]
 */

import { z } from 'zod'
import { CrmOperationsStableKeySchema, CrmOperationsUuidSchema } from './operations-types.js'

export const CrmSegmentOperatorSchema = z.enum([
  'eq', 'neq', 'contains', 'not_contains', 'in', 'not_in',
  'gt', 'gte', 'lt', 'lte', 'before', 'after', 'is_empty', 'is_not_empty',
])
export type CrmSegmentOperator = z.infer<typeof CrmSegmentOperatorSchema>

export const CrmSegmentFieldFamilySchema = z.enum([
  'base', 'custom', 'tag', 'relationship', 'consent', 'suppression',
  'entitlement', 'participation', 'pipeline',
])

export type CrmSegmentRule = {
  type: 'rule'
  family: z.infer<typeof CrmSegmentFieldFamilySchema>
  field: string
  operator: CrmSegmentOperator
  value?: unknown
}

export type CrmSegmentGroup = {
  type: 'group'
  combinator: 'and' | 'or'
  items: Array<CrmSegmentGroup | CrmSegmentRule>
}

const ruleSchema: z.ZodType<CrmSegmentRule> = z.object({
  type: z.literal('rule'),
  family: CrmSegmentFieldFamilySchema,
  field: CrmOperationsStableKeySchema,
  operator: CrmSegmentOperatorSchema,
  value: z.unknown().optional(),
}).superRefine((rule, ctx) => {
  const unary = rule.operator === 'is_empty' || rule.operator === 'is_not_empty'
  if (unary && rule.value !== undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: `${rule.operator} does not accept a value` })
  }
  if (!unary && rule.value === undefined) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['value'], message: `${rule.operator} requires a value` })
  }
})

function makeGroupSchema(depth: number): z.ZodType<CrmSegmentGroup> {
  return z.object({
    type: z.literal('group'),
    combinator: z.enum(['and', 'or']),
    items: z.array(z.lazy(() => depth >= 4
      ? ruleSchema
      : z.union([ruleSchema, makeGroupSchema(depth + 1)])))
      .min(1)
      .max(50),
  })
}

export const CrmSegmentPredicateSchema = makeGroupSchema(1).superRefine((predicate, ctx) => {
  let count = 0
  const walk = (group: CrmSegmentGroup) => {
    for (const item of group.items) {
      count += 1
      if (item.type === 'group') walk(item)
    }
  }
  walk(predicate)
  if (count > 100) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['items'], message: 'segment predicate may contain at most 100 items' })
  }
})

export type CrmSegmentPredicate = z.infer<typeof CrmSegmentPredicateSchema>

export const CrmSegmentRecordSchema = z.object({
  id: CrmOperationsUuidSchema,
  workspaceId: CrmOperationsUuidSchema,
  segmentKey: CrmOperationsStableKeySchema,
  name: z.string(),
  description: z.string(),
  entityKind: z.enum(['person', 'company', 'deal']),
  predicate: CrmSegmentPredicateSchema,
  version: z.number().int().positive(),
  archivedAt: z.union([z.string(), z.date()]).nullable(),
  createdAt: z.union([z.string(), z.date()]),
  updatedAt: z.union([z.string(), z.date()]),
})
export type CrmSegmentRecord = z.infer<typeof CrmSegmentRecordSchema>

export type CrmSegmentCatalog = {
  fields: ReadonlyMap<string, {
    family: z.infer<typeof CrmSegmentFieldFamilySchema>
    operators: readonly CrmSegmentOperator[]
    label?: string
    valueType?: 'text' | 'number' | 'date' | 'boolean' | 'uuid' | 'enum'
    validValues?: readonly string[]
  }>
}

export type CrmSegmentCatalogEntry = {
  family: z.infer<typeof CrmSegmentFieldFamilySchema>
  field: string
  label: string
  operators: CrmSegmentOperator[]
  valueType: 'text' | 'number' | 'date' | 'boolean' | 'uuid' | 'enum'
  validValues?: string[]
}

export type CrmSegmentCatalogIssue = {
  path: string
  message: string
  validValues: string[]
}

export function validateCrmSegmentCatalog(
  predicate: CrmSegmentPredicate,
  catalog: CrmSegmentCatalog,
): CrmSegmentCatalogIssue[] {
  const issues: CrmSegmentCatalogIssue[] = []
  const validFields = [...catalog.fields.keys()].sort().slice(0, 100)
  const walk = (group: CrmSegmentGroup, path: string) => {
    group.items.forEach((item, index) => {
      const itemPath = `${path}.items.${index}`
      if (item.type === 'group') {
        walk(item, itemPath)
        return
      }
      const definition = catalog.fields.get(`${item.family}:${item.field}`)
      if (!definition) {
        issues.push({
          path: `${itemPath}.field`,
          message: `Unknown segment field ${item.family}:${item.field}.`,
          validValues: validFields,
        })
        return
      }
      if (!definition.operators.includes(item.operator)) {
        issues.push({
          path: `${itemPath}.operator`,
          message: `Operator ${item.operator} is not valid for ${item.family}:${item.field}.`,
          validValues: [...definition.operators],
        })
        return
      }
      if (item.value === undefined) return
      const values = item.operator === 'in' || item.operator === 'not_in'
        ? Array.isArray(item.value) ? item.value : []
        : [item.value]
      if ((item.operator === 'in' || item.operator === 'not_in')
        && (!Array.isArray(item.value) || item.value.length === 0 || item.value.length > 100)) {
        issues.push({
          path: `${itemPath}.value`,
          message: `${item.operator} requires between 1 and 100 values.`,
          validValues: definition.validValues ? [...definition.validValues] : [],
        })
        return
      }
      const invalidType = values.some((value) => {
        if (definition.valueType === 'number') return typeof value !== 'number' || !Number.isFinite(value)
        if (definition.valueType === 'boolean') return typeof value !== 'boolean'
        if (definition.valueType === 'date') return typeof value !== 'string' || Number.isNaN(Date.parse(value))
        if (definition.valueType === 'uuid') return typeof value !== 'string' || !CrmOperationsUuidSchema.safeParse(value).success
        return typeof value !== 'string' || value.length > 500
      })
      if (invalidType) {
        issues.push({
          path: `${itemPath}.value`,
          message: `Value is not valid for ${item.family}:${item.field}.`,
          validValues: definition.validValues ? [...definition.validValues] : [],
        })
        return
      }
      if (definition.validValues?.length
        && values.some((value) => !definition.validValues!.includes(String(value)))) {
        issues.push({
          path: `${itemPath}.value`,
          message: `Value is outside the catalog for ${item.family}:${item.field}.`,
          validValues: [...definition.validValues],
        })
      }
    })
  }
  walk(predicate, 'predicate')
  return issues
}
