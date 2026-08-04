/**
 * Deterministic LinkedIn row -> entity/identity/edge projection. The planner is
 * pure: the worker loads exact existing identities, builds a complete plan, then
 * asks the store to persist it in bulk.
 *
 * [COMP:brain/linkedin-import]
 */

import { randomUUID } from 'node:crypto'

import type {
  ExternalIdentity,
  LinkedInLedgerRow,
  LinkedInProjection,
  ParsedLinkedInCsv,
  ProjectedEdge,
  ProjectedEntity,
  RowOutcomeUpdate,
} from './types.js'

type BuildProjectionInput = {
  runId: string
  archiveSha256: string
  selfEntityId: string
  csvs: ParsedLinkedInCsv[]
  existingIdentities: ExternalIdentity[]
  idFactory?: () => string
}

type IdentityCandidate = {
  kind: string
  normalizedValue: string
  originalValue: string
}

function normalizeKey(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '')
}

function getValue(row: LinkedInLedgerRow, ...keys: string[]): string {
  if (!row.values) return ''
  const wanted = new Set(keys.map(normalizeKey))
  for (const [key, value] of Object.entries(row.values)) {
    if (wanted.has(normalizeKey(key))) return value.trim()
  }
  return ''
}

export function normalizeLinkedInUrl(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  try {
    const url = new URL(trimmed)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.protocol = 'https:'
    url.hostname = url.hostname.toLowerCase()
    url.search = ''
    url.hash = ''
    url.pathname = url.pathname.replace(/\/+$/, '').toLowerCase() || '/'
    return url.toString().replace(/\/$/, '')
  } catch {
    return null
  }
}

export function normalizeEmail(raw: string): string | null {
  const value = raw.trim().toLowerCase()
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? value : null
}

export function normalizePhone(raw: string): string | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  const digits = trimmed.replace(/\D/g, '')
  if (digits.length < 7 || digits.length > 15) return null
  return `${trimmed.startsWith('+') ? '+' : ''}${digits}`
}

function normalizeCompanyName(raw: string): string | null {
  const value = raw.trim().toLowerCase().replace(/\s+/g, ' ')
  return value || null
}

function fullName(row: LinkedInLedgerRow): string {
  const parts = [
    getValue(row, 'First Name', 'FirstName'),
    getValue(row, 'Middle Name', 'MiddleName'),
    getValue(row, 'Last Name', 'LastName'),
  ].filter(Boolean)
  return parts.join(' ').replace(/\s+/g, ' ').trim()
}

function identityKey(kind: string, normalizedValue: string): string {
  return `${kind}\u0000${normalizedValue}`
}

function basename(path: string): string {
  return path.split('/').pop()?.toLowerCase() ?? path.toLowerCase()
}

function extractUrls(value: string): string[] {
  const matches = value.match(/https?:\/\/[^\s,;"<>]+/gi) ?? []
  const out = new Set<string>()
  for (const match of matches) {
    const normalized = normalizeLinkedInUrl(match.replace(/[)\]}]+$/, ''))
    if (normalized) out.add(normalized)
  }
  return [...out]
}

function identityCandidatesForRow(row: LinkedInLedgerRow): IdentityCandidate[] {
  const candidates: IdentityCandidate[] = []
  const urlRaw = getValue(row, 'URL', 'Profile URL', 'Public Profile URL', 'Public Profile Url')
  const url = normalizeLinkedInUrl(urlRaw)
  if (url) candidates.push({ kind: 'profile_url', normalizedValue: url, originalValue: urlRaw })
  const emailRaw = getValue(row, 'Email Address', 'Email', 'Emails', 'EmailAddress')
  const emailMatches = emailRaw.match(/[^\s,;<>"']+@[^\s,;<>"']+\.[^\s,;<>"']+/g) ?? []
  for (const raw of emailMatches) {
    const email = normalizeEmail(raw)
    if (email) candidates.push({ kind: 'email', normalizedValue: email, originalValue: raw })
  }
  const phoneRaw = getValue(row, 'Phone Number', 'Phone Numbers', 'Phone', 'PhoneNumber', 'PhoneNumbers', 'Mobile Phone')
  const phoneMatches = phoneRaw.match(/\+?\d[\d\s().-]{5,}\d/g) ?? []
  for (const raw of phoneMatches) {
    const phone = normalizePhone(raw)
    if (phone) candidates.push({ kind: 'phone', normalizedValue: phone, originalValue: raw.trim() })
  }
  return candidates
}

export function buildLinkedInProjection(input: BuildProjectionInput): LinkedInProjection {
  const idFactory = input.idFactory ?? randomUUID
  const identityMap = new Map<string, Set<string>>()
  const addIdentityEntity = (key: string, entityId: string) => {
    const entityIds = identityMap.get(key) ?? new Set<string>()
    entityIds.add(entityId)
    identityMap.set(key, entityIds)
  }
  for (const identity of input.existingIdentities) {
    addIdentityEntity(identityKey(identity.kind, identity.normalizedValue), identity.entityId)
  }

  const entities = new Map<string, ProjectedEntity>()
  const identities = new Map<string, ExternalIdentity>()
  const edges = new Map<string, ProjectedEdge>()
  const rowOutcomes = new Map<string, RowOutcomeUpdate>()

  const recordOutcome = (
    row: LinkedInLedgerRow,
    outcome: RowOutcomeUpdate['outcome'],
    outcomeReason: string,
    entityIds: string[] = [],
  ) => {
    rowOutcomes.set(`${row.memberPath}\u0000${row.rowOrdinal}`, {
      memberPath: row.memberPath,
      rowOrdinal: row.rowOrdinal,
      outcome,
      outcomeReason,
      entityIds: [...new Set(entityIds)],
    })
  }

  const bindIdentities = (entityId: string, candidates: IdentityCandidate[]) => {
    for (const candidate of candidates) {
      const key = identityKey(candidate.kind, candidate.normalizedValue)
      addIdentityEntity(key, entityId)
      identities.set(key, { ...candidate, entityId })
    }
  }

  const resolvePerson = (
    row: LinkedInLedgerRow,
    candidates: IdentityCandidate[],
    displayName: string,
    allowSourceScoped: boolean,
  ): { entityId: string | null; conflict: boolean } => {
    const matched = new Set(candidates.flatMap((candidate) =>
      [...(identityMap.get(identityKey(candidate.kind, candidate.normalizedValue)) ?? [])],
    ))
    if (matched.size > 1) return { entityId: null, conflict: true }

    let entityId = [...matched][0]
    if (!entityId) {
      if (candidates.length === 0 && (!displayName || !allowSourceScoped)) {
        return { entityId: null, conflict: false }
      }
      entityId = idFactory()
      const synthetic = candidates.length === 0
        ? [{
            kind: 'source_record',
            normalizedValue: `${input.archiveSha256}:${row.memberPath}:${row.rowOrdinal}`,
            originalValue: `${row.memberPath}:${row.rowOrdinal}`,
          }]
        : []
      const allCandidates = [...candidates, ...synthetic]
      const email = candidates.find((candidate) => candidate.kind === 'email')?.normalizedValue ?? null
      const phone = candidates.find((candidate) => candidate.kind === 'phone')?.normalizedValue ?? null
      entities.set(entityId, {
        id: entityId,
        kind: 'person',
        displayName: displayName || candidates[0]?.originalValue || 'LinkedIn contact',
        canonicalId: email,
        attributes: {
          email,
          phone,
          linkedin: {
            imported: true,
            first_import_run_id: input.runId,
            source_member: row.memberPath,
            source_row_ordinal: row.rowOrdinal,
            latest_record: row.values,
          },
        },
      })
      bindIdentities(entityId, allCandidates)
    } else {
      bindIdentities(entityId, candidates)
    }
    return { entityId, conflict: false }
  }

  const resolveCompany = (row: LinkedInLedgerRow, companyName: string): string => {
    const normalized = normalizeCompanyName(companyName)!
    const candidate = {
      kind: 'organization_name',
      normalizedValue: normalized,
      originalValue: companyName,
    }
    const key = identityKey(candidate.kind, candidate.normalizedValue)
    let entityId = [...(identityMap.get(key) ?? [])][0]
    if (!entityId) {
      entityId = idFactory()
      entities.set(entityId, {
        id: entityId,
        kind: 'company',
        displayName: companyName.trim(),
        canonicalId: `linkedin-company:${normalized}`,
        attributes: {
          linkedin: {
            imported: true,
            first_import_run_id: input.runId,
            source_member: row.memberPath,
            source_row_ordinal: row.rowOrdinal,
          },
        },
      })
    }
    bindIdentities(entityId, [candidate])
    return entityId
  }

  const addEdge = (edge: ProjectedEdge) => {
    if (edge.sourceId === edge.targetId) return
    const key = `${edge.sourceId}\u0000${edge.targetId}\u0000${edge.edgeType}`
    const existing = edges.get(key)
    if (!existing) {
      edges.set(key, edge)
      return
    }
    const observations = Number(existing.attributes.observation_count ?? 1) + 1
    existing.attributes = { ...existing.attributes, ...edge.attributes, observation_count: observations }
  }

  const bindSelfProfileUrl = (row: LinkedInLedgerRow | null, candidate: IdentityCandidate): boolean => {
    const key = identityKey(candidate.kind, candidate.normalizedValue)
    const existing = identityMap.get(key) ?? new Set<string>()
    const conflicting = [...existing].filter((entityId) => entityId !== input.selfEntityId)
    if (conflicting.length > 0) {
      if (row) recordOutcome(row, 'unresolved', 'conflicting_self_profile_identity', conflicting)
      return false
    }
    bindIdentities(input.selfEntityId, [candidate])
    return true
  }

  // Profile is processed first so message participants can exclude the self URL.
  const profileRows = input.csvs
    .filter((csv) => basename(csv.memberPath) === 'profile.csv')
    .flatMap((csv) => csv.rows)
    .filter((row) => row.recordKind === 'data' && row.outcome !== 'malformed')
  for (const row of profileRows) {
    const candidates = identityCandidatesForRow(row).filter((candidate) => candidate.kind === 'profile_url')
    const bound = candidates.filter((candidate) => bindSelfProfileUrl(row, candidate))
    if (bound.length > 0 || candidates.length === 0) {
      recordOutcome(row, 'mapped', 'self_profile', [input.selfEntityId])
    }
  }

  // Some LinkedIn exports omit/alter the public URL in Profile.csv while every
  // message row still contains the same self participant URL. Intersecting ALL
  // message records is deterministic and high-confidence; zero or multiple
  // candidates means no inference.
  if (![...identityMap.entries()].some(([key, entityIds]) =>
    key.startsWith('profile_url\u0000') && entityIds.has(input.selfEntityId))) {
    const messageRows = input.csvs
      .filter((csv) => basename(csv.memberPath) === 'messages.csv')
      .flatMap((csv) => csv.rows)
      .filter((row) => row.recordKind === 'data' && row.outcome !== 'malformed')
    let intersection: Set<string> | null = null
    for (const row of messageRows) {
      const urls = new Set(
        Object.entries(row.values ?? {})
          .filter(([key]) => normalizeKey(key).includes('profileurl'))
          .flatMap(([, value]) => extractUrls(value)),
      )
      if (intersection === null) {
        intersection = urls
      } else {
        const previous: Set<string> = intersection
        intersection = new Set([...previous].filter((url) => urls.has(url)))
      }
      if (intersection.size === 0) break
    }
    if (intersection?.size === 1) {
      const inferred = [...intersection][0]
      bindSelfProfileUrl(null, {
        kind: 'profile_url',
        normalizedValue: inferred,
        originalValue: inferred,
      })
    }
  }

  const selfProfileUrls = new Set(
    [...identityMap.entries()]
      .filter(([key, entityIds]) => key.startsWith('profile_url\u0000') && entityIds.has(input.selfEntityId))
      .map(([key]) => key.slice('profile_url\u0000'.length)),
  )

  for (const csv of input.csvs) {
    const file = basename(csv.memberPath)
    if (file !== 'connections.csv' && file !== 'importedcontacts.csv' && file !== 'contacts.csv') continue
    for (const row of csv.rows) {
      if (row.recordKind !== 'data' || row.outcome === 'malformed') continue
      const candidates = identityCandidatesForRow(row)
      const name = fullName(row)
      const resolved = resolvePerson(row, candidates, name, file === 'connections.csv')
      if (resolved.conflict) {
        recordOutcome(row, 'unresolved', 'conflicting_strong_identities')
        continue
      }
      if (!resolved.entityId) {
        recordOutcome(row, 'unresolved', name ? 'no_stable_identity' : 'no_identity_or_name')
        continue
      }
      if (resolved.entityId === input.selfEntityId) {
        recordOutcome(row, 'unresolved', 'source_row_resolves_to_self', [input.selfEntityId])
        continue
      }

      const entityIds = [resolved.entityId]
      if (file === 'connections.csv') {
        addEdge({
          sourceId: input.selfEntityId,
          targetId: resolved.entityId,
          edgeType: 'connected_to',
          attributes: {
            provider: 'linkedin',
            connected_on: getValue(row, 'Connected On') || null,
            source_run_id: input.runId,
            source_member: row.memberPath,
            source_row_ordinal: row.rowOrdinal,
            observation_count: 1,
          },
        })
        const companyName = getValue(row, 'Company')
        if (companyName) {
          const companyId = resolveCompany(row, companyName)
          entityIds.push(companyId)
          addEdge({
            sourceId: resolved.entityId,
            targetId: companyId,
            edgeType: 'works_at',
            attributes: {
              provider: 'linkedin',
              position: getValue(row, 'Position', 'Title') || null,
              source_run_id: input.runId,
              source_member: row.memberPath,
              source_row_ordinal: row.rowOrdinal,
              observation_count: 1,
            },
          })
        }
        recordOutcome(row, 'mapped', 'direct_connection', entityIds)
      } else {
        recordOutcome(row, 'mapped', 'imported_contact', entityIds)
      }
    }
  }

  type DiscussionAggregate = {
    entityId: string
    messageCount: number
    conversationIds: Set<string>
    firstMessageAt: string | null
    lastMessageAt: string | null
  }
  const discussions = new Map<string, DiscussionAggregate>()

  type MessageConversation = {
    conversationId: string | null
    rows: LinkedInLedgerRow[]
    profileUrls: Set<string>
  }
  const conversations = new Map<string, MessageConversation>()
  for (const csv of input.csvs.filter((candidate) => basename(candidate.memberPath) === 'messages.csv')) {
    for (const row of csv.rows) {
      if (row.recordKind !== 'data' || row.outcome === 'malformed') continue
      const conversationId = getValue(row, 'Conversation ID') || null
      // Blank ids carry no join semantics: keeping them row-local avoids
      // manufacturing one giant conversation from unrelated records.
      const conversationKey = conversationId
        ? `conversation:${conversationId}`
        : `row:${row.memberPath}:${row.rowOrdinal}`
      const conversation = conversations.get(conversationKey) ?? {
        conversationId,
        rows: [],
        profileUrls: new Set<string>(),
      }
      const profileValues = Object.entries(row.values ?? {})
        .filter(([key]) => normalizeKey(key).includes('profileurl'))
        .flatMap(([, value]) => extractUrls(value))
      for (const url of profileValues) conversation.profileUrls.add(url)
      conversation.rows.push(row)
      conversations.set(conversationKey, conversation)
    }
  }

  for (const conversation of conversations.values()) {
    if (selfProfileUrls.size === 0) {
      for (const row of conversation.rows) {
        recordOutcome(row, 'stored', 'self_profile_url_unavailable')
      }
      continue
    }
    const externalUrls = [...conversation.profileUrls].filter((url) => !selfProfileUrls.has(url))
    if (externalUrls.length === 0) {
      for (const row of conversation.rows) {
        recordOutcome(row, 'stored', 'no_external_profile_url')
      }
      continue
    }
    if (externalUrls.length > 1) {
      for (const row of conversation.rows) {
        recordOutcome(row, 'stored', 'group_message_preserved_without_person_clique')
      }
      continue
    }

    const url = externalUrls[0]
    const representative = conversation.rows.find((row) =>
      extractUrls(getValue(row, 'Sender Profile URL')).includes(url),
    ) ?? conversation.rows[0]
    const inbound = extractUrls(getValue(representative, 'Sender Profile URL')).includes(url)
    const displayName = inbound
      ? getValue(representative, 'From')
      : getValue(representative, 'To')
    const resolved = resolvePerson(
      representative,
      [{ kind: 'profile_url', normalizedValue: url, originalValue: url }],
      displayName,
      false,
    )
    if (!resolved.entityId || resolved.entityId === input.selfEntityId) {
      for (const row of conversation.rows) {
        recordOutcome(row, 'unresolved', 'message_participant_resolution_failed')
      }
      continue
    }

    const aggregate = discussions.get(resolved.entityId) ?? {
      entityId: resolved.entityId,
      messageCount: 0,
      conversationIds: new Set<string>(),
      firstMessageAt: null,
      lastMessageAt: null,
    }
    for (const row of conversation.rows) {
      recordOutcome(row, 'mapped', 'one_to_one_message', [resolved.entityId])
      aggregate.messageCount += 1
      const date = getValue(row, 'Date') || null
      if (date && (!aggregate.firstMessageAt || date < aggregate.firstMessageAt)) aggregate.firstMessageAt = date
      if (date && (!aggregate.lastMessageAt || date > aggregate.lastMessageAt)) aggregate.lastMessageAt = date
    }
    if (conversation.conversationId) aggregate.conversationIds.add(conversation.conversationId)
    discussions.set(resolved.entityId, aggregate)
  }

  for (const aggregate of discussions.values()) {
    addEdge({
      sourceId: input.selfEntityId,
      targetId: aggregate.entityId,
      edgeType: 'discussed_with',
      attributes: {
        provider: 'linkedin',
        message_count: aggregate.messageCount,
        conversation_ids: [...aggregate.conversationIds].sort(),
        first_message_at: aggregate.firstMessageAt,
        last_message_at: aggregate.lastMessageAt,
        source_run_id: input.runId,
        observation_count: aggregate.messageCount,
      },
    })
  }

  return {
    entities: [...entities.values()],
    identities: [...identities.values()],
    edges: [...edges.values()],
    rowOutcomes: [...rowOutcomes.values()],
  }
}
