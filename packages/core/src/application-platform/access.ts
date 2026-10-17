/** App ceilings compose with the existing kernel and module/source floors. [COMP:security/application-access] */
import { ApplicationPlatformError, applicationGrantSchema, applicationGrantMaximumSchema, type ApplicationAccessGrant, type ApplicationGrantMaximum, type ApplicationPrincipal,
  type ApplicationQuery, type ApplicationResourceRef } from '@use-brian/shared'
import type { ResourceScope } from '../security/derived-scope.js'
import { canRead, minSensitivity, type Sensitivity } from '../security/sensitivity.js'
import { scopeGrantContains } from '../security/context-scope.js'

export interface ApplicationGrantLayer {
  appId: string
  principal: ApplicationPrincipal
  grants: readonly ApplicationAccessGrant[]
}
export interface ApplicationRecordAuthority {
  ref: ApplicationResourceRef
  scope: ResourceScope
  /** Canonical, immutable ownership, resolved by the registered resource adapter. */
  ownerUserId: string | null
  /** Registered relationship + anchor keys resolved by the host, never request JSON. */
  relationships: ReadonlySet<string>
}
export interface ApplicationFieldDecision {
  allowed: boolean
  readFields: readonly string[]
  writeFields: readonly string[]
  versions: readonly string[]
}

export interface ApplicationGrantPath {
  current: readonly ApplicationAccessGrant[]
  maximum: ApplicationGrantMaximum
}
/** Alternative exact releases union; credentials, subjects and consent intersect. */
export type ApplicationAuthorityLayers = readonly (readonly ApplicationGrantPath[])[]

/** Named-operation ceiling only; handlers still authorize each resource and input. */
export function applicationAuthorityAllowsOperation(layers: ApplicationAuthorityLayers, action: string, now = Date.now()): boolean {
  const appId = layers[0]?.[0]?.current[0]?.appId
  return !!appId && layers.every(alternatives => alternatives.some(path => {
    const resolved = pathLayers(path)
    if (!resolved || resolved.some(layer => layer.appId !== appId)) return false
    const first = path.current[0]
    const ref: ApplicationResourceRef = { workspaceId: first.workspaceId, origin: first.origin, typeKey: first.typeKey, id: 'operation', version: '1' }
    return resolved.every(layer => current(layer.grants[0], layer, ref, action, now))
  }))
}

function pathLayers(path: ApplicationGrantPath): ApplicationGrantLayer[] | null {
  const maximum = applicationGrantMaximumSchema.safeParse(path.maximum)
  if (!maximum.success || path.current.length !== maximum.data.grants.length) return null
  for (const [index, current] of path.current.entries()) {
    const issued = maximum.data.grants[index]
    if (!applicationGrantSchema.safeParse(current).success || current.id !== issued.id
      || current.appId !== issued.appId || current.workspaceId !== issued.workspaceId
      || current.principal.kind !== issued.principal.kind || current.principal.userId !== issued.principal.userId
      || current.parentGrantId !== issued.parentGrantId || JSON.stringify(current.origin) !== JSON.stringify(issued.origin)
      || current.typeKey !== issued.typeKey) return null
  }
  return [...path.current, ...maximum.data.grants].map(grant => ({ appId: grant.appId, principal: grant.principal, grants: [grant] }))
}

export function decideApplicationAuthority(layers: ApplicationAuthorityLayers, resource: ApplicationRecordAuthority,
  action: string, moduleReadFields: readonly string[], moduleWriteFields: readonly string[], now = Date.now()): ApplicationFieldDecision {
  let read = new Set(moduleReadFields), write = new Set(moduleWriteFields)
  const versions: string[] = []
  if (!layers.length) return { allowed: false, readFields: [], writeFields: [], versions }
  const appId = layers[0][0]?.current[0]?.appId
  if (!appId || layers.some(layer => layer.some(path => path.current[0]?.appId !== appId
    || path.maximum.grants[0]?.appId !== appId))) return { allowed: false, readFields: [], writeFields: [], versions }
  for (const alternatives of layers) {
    const decisions = alternatives.flatMap(path => {
      const resolved = pathLayers(path)
      if (!resolved) return []
      const decision = decideApplicationFields(resolved, resource, action, moduleReadFields, moduleWriteFields, now)
      return decision.allowed ? [decision] : []
    })
    if (!decisions.length) return { allowed: false, readFields: [], writeFields: [], versions: [] }
    read = intersection(read, new Set(decisions.flatMap(decision => decision.readFields)))
    write = intersection(write, new Set(decisions.flatMap(decision => decision.writeFields)))
    versions.push(...decisions.flatMap(decision => decision.versions))
  }
  return { allowed: true, readFields: [...read].sort(), writeFields: [...write].sort(), versions: [...new Set(versions)].sort() }
}

/** Schema/catalog names only. Row/selector/native/source admission is still required. */
export function applicationAuthorityFieldCatalog(layers: ApplicationAuthorityLayers, ref: ApplicationResourceRef,
  action: string, moduleReadFields: readonly string[], moduleWriteFields: readonly string[], now = Date.now()): ApplicationFieldDecision {
  let read = new Set(moduleReadFields), write = new Set(moduleWriteFields)
  const versions: string[] = []
  const appId = layers[0]?.[0]?.current[0]?.appId
  if (!appId || layers.some(layer => layer.some(path => path.current[0]?.appId !== appId))) {
    return { allowed: false, readFields: [], writeFields: [], versions }
  }
  for (const alternatives of layers) {
    const candidates = alternatives.flatMap(path => {
      const resolved = pathLayers(path)
      if (!resolved || resolved.some(layer => !current(layer.grants[0], layer, ref, action, now))) return []
      const grants = resolved.map(layer => layer.grants[0])
      versions.push(...grants.map(grant => `${grant.id}:${grant.version}`))
      return [{ read: grants.reduce((keys, grant) => intersection(keys, new Set(grant.readFields)), new Set(moduleReadFields)),
        write: grants.reduce((keys, grant) => intersection(keys, new Set(grant.writeFields)), new Set(moduleWriteFields)) }]
    })
    if (!candidates.length) return { allowed: false, readFields: [], writeFields: [], versions: [] }
    read = intersection(read, new Set(candidates.flatMap(candidate => [...candidate.read])))
    write = intersection(write, new Set(candidates.flatMap(candidate => [...candidate.write])))
  }
  return { allowed: true, readFields: [...read].sort(), writeFields: [...write].sort(), versions: [...new Set(versions)].sort() }
}

function sameOrigin(left: ApplicationResourceRef['origin'], right: ApplicationResourceRef['origin']): boolean {
  if (left.kind !== right.kind) return false
  if (left.kind === 'native' && right.kind === 'native') return left.moduleKey === right.moduleKey
  if (left.kind === 'generic' && right.kind === 'generic') return left.entityTypeId === right.entityTypeId
  return left.kind === 'external' && right.kind === 'external'
    && left.connectorInstanceId === right.connectorInstanceId && left.sourceTenant === right.sourceTenant
}
function current(grant: ApplicationAccessGrant, layer: ApplicationGrantLayer, ref: ApplicationResourceRef, action: string, now: number) {
  return applicationGrantSchema.safeParse(grant).success && grant.status === 'active'
    && grant.appId === layer.appId && grant.workspaceId === ref.workspaceId
    && grant.principal.kind === layer.principal.kind && grant.principal.userId === layer.principal.userId
    && grant.typeKey === ref.typeKey && sameOrigin(grant.origin, ref.origin) && grant.actions.includes(action)
    && Date.parse(grant.startsAt) <= now && (grant.expiresAt === null || Date.parse(grant.expiresAt) > now)
}
const intersection = (left: Set<string>, right: Set<string>) => new Set([...left].filter(value => right.has(value)))

/** Defaults for a new canonical row, never a substitute for current SQL admission. */
export function applicationAuthorityCreationScope(layers: ApplicationAuthorityLayers, ref: ApplicationResourceRef, fields: readonly string[],
  native: { clearance: Sensitivity; mutationCompartments?: string[] | null; projectIds?: string[] | null }, now = Date.now()) {
  type Candidate = { compartments: string[]; projectIds: string[]; sensitivity: Sensitivity; writeFields: Set<string> }
  let choices: Map<string, Candidate> | undefined
  const appId = layers[0]?.[0]?.current[0]?.appId
  if (!appId || layers.some(layer => layer.some(path => path.current[0]?.appId !== appId))) {
    throw new ApplicationPlatformError('access_unavailable', 'Creation is unavailable.')
  }
  for (const alternatives of layers) {
    const candidates = new Map<string, Candidate>()
    for (const path of alternatives) {
      const resolved = pathLayers(path)
      if (!resolved || resolved.some(layer => !current(layer.grants[0], layer, ref, 'create', now))) continue
      const grants = resolved.map(layer => layer.grants[0]), leaf = path.current[0], issued = path.maximum.grants[0]
      const compartments = [...grants.reduce((keys, grant) => intersection(keys, new Set(grant.compartments)), new Set(leaf.compartments))].sort()
      const projectIds = [...grants.reduce((keys, grant) => intersection(keys, new Set(grant.projectIds)), new Set(leaf.projectIds))].sort()
      // Two protected leaves whose ceilings no longer overlap cannot silently
      // manufacture a General classification. An explicit empty leaf may.
      if (!compartments.length && leaf.compartments.length && issued.compartments.length
        || !projectIds.length && leaf.projectIds.length && issued.projectIds.length
        || !scopeGrantContains(native.mutationCompartments ?? null, compartments)
        || !scopeGrantContains(native.projectIds ?? null, projectIds)) continue
      const writeFields = grants.reduce((keys, grant) => intersection(keys, new Set(grant.writeFields)), new Set(fields))
      const sensitivity = minSensitivity('internal', native.clearance, ...grants.map(grant => grant.clearance))
      const key = JSON.stringify([compartments, projectIds]), prior = candidates.get(key)
      candidates.set(key, { compartments, projectIds, sensitivity: prior ? minSensitivity(prior.sensitivity, sensitivity) : sensitivity,
        writeFields: new Set([...(prior?.writeFields ?? []), ...writeFields]) })
    }
    for (const [key, candidate] of candidates) if (fields.some(field => !candidate.writeFields.has(field))) candidates.delete(key)
    if (!choices) choices = candidates
    else for (const [key, candidate] of choices) {
      const next = candidates.get(key)
      if (!next) choices.delete(key)
      else choices.set(key, { ...candidate, sensitivity: minSensitivity(candidate.sensitivity, next.sensitivity),
        writeFields: intersection(candidate.writeFields, next.writeFields) })
    }
  }
  if (!choices?.size) throw new ApplicationPlatformError('access_unavailable', 'Creation is unavailable.')
  if (choices.size !== 1) throw new ApplicationPlatformError('invalid_value', 'Creation requires one explicit application scope.')
  const { writeFields: _writeFields, ...scope } = [...choices.values()][0]
  return scope
}

/** This decides only the app ceiling. It cannot authenticate or replace native/source authority. */
export function decideApplicationFields(layers: readonly ApplicationGrantLayer[], resource: ApplicationRecordAuthority,
  action: string, moduleReadFields: readonly string[], moduleWriteFields: readonly string[], now = Date.now()): ApplicationFieldDecision {
  let read = new Set(moduleReadFields), write = new Set(moduleWriteFields)
  const versions: string[] = []
  if (!layers.length || layers.some(layer => layer.appId !== layers[0].appId)
    || resource.scope.workspaceId !== resource.ref.workspaceId) return { allowed: false, readFields: [], writeFields: [], versions: [] }
  for (const layer of layers) {
    const admitted = layer.grants.filter(grant => {
      if (!current(grant, layer, resource.ref, action, now)
        || !canRead(grant.clearance, resource.scope.sensitivity)
        || resource.scope.compartments.some(key => !grant.compartments.includes(key))
        || resource.scope.projectIds.some(id => !grant.projectIds.includes(id))) return false
      const selector = grant.selector
      return selector.kind === 'ids' ? selector.ids.includes(resource.ref.id)
        : selector.kind === 'self' ? resource.ownerUserId === layer.principal.userId
        : resource.relationships.has(JSON.stringify([selector.resolverKey, selector.anchorId]))
    })
    if (!admitted.length) return { allowed: false, readFields: [], writeFields: [], versions: [] }
    read = intersection(read, new Set(admitted.flatMap(grant => grant.readFields)))
    write = intersection(write, new Set(admitted.flatMap(grant => grant.writeFields)))
    versions.push(...admitted.map(grant => `${grant.id}:${grant.version}`))
  }
  return { allowed: true, readFields: [...read].sort(), writeFields: [...write].sort(), versions: [...new Set(versions)].sort() }
}

/** A query predicate cannot depend on a field hidden on another candidate row. */
export function applicationQueryFieldCeiling(layers: readonly ApplicationGrantLayer[], ref: ApplicationResourceRef,
  moduleReadFields: readonly string[], now = Date.now()): ApplicationFieldDecision {
  if (!layers.length || layers.some(layer => layer.appId !== layers[0].appId)) return { allowed: false, readFields: [], writeFields: [], versions: [] }
  let read = new Set(moduleReadFields)
  const versions: string[] = []
  for (const layer of layers) {
    const grants = layer.grants.filter(grant => current(grant, layer, ref, 'query', now))
    if (!grants.length) return { allowed: false, readFields: [], writeFields: [], versions: [] }
    for (const grant of grants) read = intersection(read, new Set(grant.readFields))
    versions.push(...grants.map(grant => `${grant.id}:${grant.version}`))
  }
  return { allowed: true, readFields: [...read].sort(), writeFields: [], versions: [...new Set(versions)].sort() }
}

/** Predicates must be safe for every candidate release, including captured parents. */
export function applicationAuthorityQueryFieldCeiling(layers: ApplicationAuthorityLayers, ref: ApplicationResourceRef,
  moduleReadFields: readonly string[], now = Date.now()): ApplicationFieldDecision {
  const appId = layers[0]?.[0]?.current[0]?.appId
  let read = new Set(moduleReadFields)
  const versions: string[] = []
  if (!appId || layers.some(layer => layer.some(path => path.current[0]?.appId !== appId))) {
    return { allowed: false, readFields: [], writeFields: [], versions }
  }
  for (const alternatives of layers) {
    let admitted = false
    for (const path of alternatives) {
      const resolved = pathLayers(path)
      if (!resolved || resolved.some(layer => !current(layer.grants[0], layer, ref, 'query', now))) continue
      admitted = true
      for (const layer of resolved) {
        read = intersection(read, new Set(layer.grants[0].readFields))
        versions.push(`${layer.grants[0].id}:${layer.grants[0].version}`)
      }
    }
    if (!admitted) return { allowed: false, readFields: [], writeFields: [], versions: [] }
  }
  return { allowed: true, readFields: [...read].sort(), writeFields: [], versions: [...new Set(versions)].sort() }
}

export function assertApplicationQueryFields(query: ApplicationQuery, decision: ApplicationFieldDecision): void {
  const fields = [...(query.fields ?? []), ...query.filters.map(filter => filter.field), ...query.sort.map(sort => sort.field), ...query.aggregate.map(aggregate => aggregate.field)]
  if (!decision.allowed || fields.some(field => !decision.readFields.includes(field))) {
    throw new ApplicationPlatformError('access_unavailable', 'The requested query is unavailable.')
  }
}
export function assertApplicationWriteFields(fields: readonly string[], decision: ApplicationFieldDecision): void {
  if (!decision.allowed || fields.some(field => !decision.writeFields.includes(field))) {
    throw new ApplicationPlatformError('access_unavailable', 'The requested change is unavailable.')
  }
}
export function projectApplicationFields<T>(values: Record<string, T>, decision: ApplicationFieldDecision): Record<string, T> {
  if (!decision.allowed) throw new ApplicationPlatformError('access_unavailable', 'The record is unavailable.')
  return Object.fromEntries(Object.entries(values).filter(([key]) => decision.readFields.includes(key)))
}
