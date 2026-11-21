/** Engineering scopes and definition contracts, not execution authority. [COMP:api/project-harness] */
import { z } from 'zod'

const uuid = z.string().uuid()
// PostgreSQL jsonb cannot store NUL or unpaired UTF-16 surrogates.
const validUnicode = (value: string) => !/\u0000|[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(value)
const boundedText = (min: number, max: number) => z.string().trim().min(min).max(max).refine(validUnicode, 'Invalid Unicode text')
const text = boundedText(1, 4000)
const key = z.string().regex(/^[a-z][a-z0-9._-]{0,99}$/)

/** Sum string-value UTF-16 units, independent of JSON serializer whitespace/key order. */
export function harnessTextUnits(value: unknown): number {
  if (typeof value === 'string') return value.length
  if (Array.isArray(value)) return value.reduce((total, item) => total + harnessTextUnits(item), 0)
  if (value !== null && typeof value === 'object') return Object.values(value).reduce<number>((total, item) => total + harnessTextUnits(item), 0)
  return 0
}
export const harnessScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('project') }).strict(),
  z.object({ kind: z.literal('product'), productId: uuid }).strict(),
  z.object({ kind: z.literal('component'), productId: uuid, componentId: uuid }).strict(),
])
export type HarnessScope = z.infer<typeof harnessScopeSchema>

export const harnessRuleSchema = z.object({
  key,
  kind: z.enum(['invariant', 'default', 'local']),
  value: text,
  /** Explicitly specialize an inherited default with the same key. */
  override: z.boolean().default(false),
}).strict()
export type HarnessRule = z.infer<typeof harnessRuleSchema>

export const codeCheckSchema = z.object({
  key,
  kind: z.enum(['unit', 'integration', 'contract']),
  instructions: text,
  /** Instruction/reference only. The foundation never executes this string. */
  command: boundedText(1, 1000).optional(),
}).strict()

export const acceptanceScenarioSchema = z.object({
  key,
  title: boundedText(1, 200),
  preconditions: z.array(text).min(1).max(30),
  steps: z.array(text).min(1).max(50),
  criteria: z.array(z.object({ key, observation: text, evidence: text }).strict()).min(1).max(50),
}).strict().superRefine((scenario, ctx) => {
  const seen = new Set<string>()
  scenario.criteria.forEach((criterion, i) => {
    if (seen.has(criterion.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['criteria', i, 'key'], message: 'Duplicate criterion key' })
    seen.add(criterion.key)
  })
})
export type AcceptanceScenario = z.infer<typeof acceptanceScenarioSchema>

/** Metadata only: repository identity is not a URL or a source-fetch capability. */
export const harnessRepositorySchema = boundedText(1, 200)
/** Canonical relative file/directory prefix. No decoding, globs or path normalization is performed. */
export const harnessSourcePathSchema = z.string().min(1).max(500).refine(validUnicode, 'Invalid Unicode text')
  .refine(value => value === value.trim() && !/[\\\\:*?\[\]{}%\u0000-\u001f\u007f]/.test(value)
    && value.split('/').every(segment => segment !== '' && segment !== '.' && segment !== '..'), 'Use a normalized relative source path')
export const harnessSourceMappingSchema = z.object({ repository: harnessRepositorySchema, pathPrefix: harnessSourcePathSchema }).strict()
export const harnessDependencySchema = z.object({ scope: harnessScopeSchema, contract: text }).strict()

export const harnessDefinitionSchema = z.object({
  schemaVersion: z.literal(1),
  rules: z.array(harnessRuleSchema).max(100),
  codeChecks: z.array(codeCheckSchema).max(50),
  acceptanceScenarios: z.array(acceptanceScenarioSchema).max(30),
  sourceMappings: z.array(harnessSourceMappingSchema).max(100).optional(),
  dependencies: z.array(harnessDependencySchema).max(100).optional(),
}).strict().superRefine((definition, ctx) => {
  for (const field of ['rules', 'codeChecks', 'acceptanceScenarios'] as const) {
    const seen = new Set<string>()
    definition[field].forEach((item, i) => {
      if (seen.has(item.key)) ctx.addIssue({ code: z.ZodIssueCode.custom, path: [field, i, 'key'], message: 'Duplicate key within scope' })
      seen.add(item.key)
    })
  }
  if (harnessTextUnits(definition) > 128_000) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Harness definition exceeds 128000 text units' })
  }
})
export type HarnessDefinition = z.infer<typeof harnessDefinitionSchema>

export const createEngineeringNodeSchema = z.object({
  name: boundedText(1, 200),
  description: boundedText(0, 2000).nullable().optional(),
}).strict()
export const updateEngineeringNodeSchema = createEngineeringNodeSchema.partial().extend({
  expectedRevision: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER),
  status: z.enum(['active', 'archived']).optional(),
}).strict().refine(input => input.name !== undefined || input.description !== undefined || input.status !== undefined,
  { message: 'At least one field must change' })
export const putHarnessDefinitionSchema = z.object({
  scope: harnessScopeSchema,
  expectedRevision: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
  definition: harnessDefinitionSchema,
}).strict()
export type CreateEngineeringNode = z.infer<typeof createEngineeringNodeSchema>
export type UpdateEngineeringNode = z.infer<typeof updateEngineeringNodeSchema>

export type ProjectProduct = {
  id: string
  workspaceId: string
  projectId: string
  name: string
  description: string | null
  status: 'active' | 'archived'
  revision: number
  createdAt: string
  updatedAt: string
}
export type ProductComponent = ProjectProduct & { productId: string }
export type HarnessRevision = {
  id: string
  workspaceId: string
  projectId: string
  scope: HarnessScope
  revision: number
  definition: HarnessDefinition
  createdBy: string | null
  createdAt: string
}

export type HarnessProjectSnapshot = {
  tree: { products: ProjectProduct[]; components: ProductComponent[] }
  /** Exactly one current head per defined scope, including archived nodes. */
  revisions: HarnessRevision[]
}

/** Every operation must authorize the complete ancestry, including reads with no definition yet. */
export interface ProjectHarnessStore {
  tree(actor: string, workspaceId: string, projectId: string): Promise<{ products: ProjectProduct[]; components: ProductComponent[] }>
  createProduct(actor: string, workspaceId: string, projectId: string, input: CreateEngineeringNode): Promise<ProjectProduct>
  updateProduct(actor: string, workspaceId: string, projectId: string, productId: string, input: UpdateEngineeringNode): Promise<ProjectProduct>
  createComponent(actor: string, workspaceId: string, projectId: string, productId: string, input: CreateEngineeringNode): Promise<ProductComponent>
  updateComponent(actor: string, workspaceId: string, projectId: string, productId: string, componentId: string, input: UpdateEngineeringNode): Promise<ProductComponent>
  definition(actor: string, workspaceId: string, projectId: string, scope: HarnessScope): Promise<HarnessRevision | null>
  history(actor: string, workspaceId: string, projectId: string, scope: HarnessScope): Promise<HarnessRevision[]>
  putDefinition(actor: string, workspaceId: string, projectId: string, input: z.infer<typeof putHarnessDefinitionSchema>): Promise<HarnessRevision>
  /** Ordered Project → Product → Component; one actor-bound consistent read, no sibling definitions. */
  lineage(actor: string, workspaceId: string, projectId: string, scope: HarnessScope): Promise<HarnessRevision[]>
}
