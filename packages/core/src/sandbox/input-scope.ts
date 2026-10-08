import { z } from 'zod'
import { maxSensitivity } from '../security/sensitivity.js'
import type { ScopeEvidence } from '../security/context-scope.js'

const sensitivity = z.enum(['public', 'internal', 'confidential'])
const labels = z.array(z.string().min(1))
const source = z.object({
  workspaceId: z.string().min(1), resourceKind: z.string().min(1), resourceId: z.string().min(1), version: z.string().min(1),
  userId: z.string().min(1).nullable(), assistantId: z.string().min(1).nullable(),
  sensitivity, compartments: labels, projectIds: labels,
}).strict()
const schema = z.object({ sensitivity, compartments: labels, projectIds: labels, sources: z.array(source) }).strict()
export type BrowserInputScope = z.infer<typeof schema>
const unavailable = () => Object.assign(new Error('Browser input protection changed. Start a new task.'), { code: 'profile_authority_denied' })
const union = (...sets: string[][]) => [...new Set(sets.flat())].sort()

export function parseBrowserInputScope(value: unknown, workspaceId: string): BrowserInputScope {
  const parsed = schema.safeParse(value)
  if (!parsed.success) throw unavailable()
  return browserInputScope(parsed.data, workspaceId)
}

/** Normalize a trusted turn accumulator, not a model/HTTP argument. */
export function browserInputScope(evidence: ScopeEvidence, workspaceId: string): BrowserInputScope {
  const parsed = schema.safeParse({ sensitivity: evidence.sensitivity ?? 'public', compartments: evidence.compartments ?? [],
    projectIds: evidence.projectIds ?? [], sources: evidence.sources ?? [] })
  if (!parsed.success || parsed.data.sources.some(s => s.workspaceId !== workspaceId)) throw unavailable()
  const value = parsed.data
  const sources = new Map<string, typeof value.sources[number]>()
  for (const item of value.sources) {
    const normalized = { ...item, compartments: union(item.compartments), projectIds: union(item.projectIds) }
    const key = `${item.resourceKind}:${item.resourceId}`
    const previous = sources.get(key)
    if (previous && JSON.stringify(previous) !== JSON.stringify(normalized)) throw unavailable()
    sources.set(key, normalized)
  }
  return { sensitivity: maxSensitivity(value.sensitivity, ...value.sources.map(s => s.sensitivity)),
    compartments: union(value.compartments, ...value.sources.map(s => s.compartments)),
    projectIds: union(value.projectIds, ...value.sources.map(s => s.projectIds)),
    sources: [...sources.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, s]) => s) }
}

/** Unknown history stays unknown; known history only grows and never changes versions. */
export function mergeBrowserInputScope(previous: BrowserInputScope | null | undefined,
  incoming: BrowserInputScope | null | undefined, workspaceId: string): BrowserInputScope | null {
  const right = incoming == null ? null : parseBrowserInputScope(incoming, workspaceId)
  if (previous == null) return null
  const left = parseBrowserInputScope(previous, workspaceId)
  if (right == null) return left
  return browserInputScope({ sensitivity: maxSensitivity(left.sensitivity, right.sensitivity),
    compartments: union(left.compartments, right.compartments), projectIds: union(left.projectIds, right.projectIds),
    sources: [...left.sources, ...right.sources] }, workspaceId)
}
