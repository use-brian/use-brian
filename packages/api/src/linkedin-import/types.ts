export type LinkedInImportStatus = 'pending' | 'processing' | 'completed' | 'failed'
export type LinkedInRowOutcome = 'mapped' | 'stored' | 'unresolved' | 'malformed'
export type LinkedInRecordKind = 'preamble' | 'header' | 'data' | 'blank'

export type LinkedInImportRun = {
  id: string
  workspaceId: string
  actingUserId: string
  assistantId: string | null
  archiveFileId: string | null
  archiveName: string
  archiveSha256: string
  archiveSizeBytes: number
  status: LinkedInImportStatus
  stage: string
  attempts: number
  lastError: string | null
  leaseToken: string | null
  memberCount: number
  completedMemberCount: number
  rowCount: number
  mappedCount: number
  storedCount: number
  unresolvedCount: number
  malformedCount: number
  entityCount: number
  edgeCount: number
  createdAt: Date
  updatedAt: Date
  completedAt: Date | null
}

export type LinkedInArchiveMember = {
  path: string
  bytes: Buffer
  contentSha256: string
  compressedSize: number | null
  sizeBytes: number
  mime: string
}

export type ParsedCsvRecord = {
  rowOrdinal: number
  startLine: number
  endLine: number
  cells: string[]
  raw: string
  rawSha256: string
  malformedReason?: string
}

export type LinkedInLedgerRow = {
  memberPath: string
  rowOrdinal: number
  dataOrdinal: number | null
  recordKind: LinkedInRecordKind
  startLine: number
  endLine: number
  cells: string[]
  values: Record<string, string> | null
  rawSha256: string
  outcome: LinkedInRowOutcome
  outcomeReason: string | null
  entityIds: string[]
}

export type ParsedLinkedInCsv = {
  memberPath: string
  headerRowOrdinal: number | null
  headerCells: string[] | null
  rows: LinkedInLedgerRow[]
}

export type ExternalIdentity = {
  kind: string
  normalizedValue: string
  originalValue: string
  entityId: string
}

export type ProjectedEntity = {
  id: string
  kind: 'person' | 'company'
  displayName: string
  canonicalId: string | null
  attributes: Record<string, unknown>
}

export type ProjectedEdge = {
  sourceId: string
  targetId: string
  edgeType: 'connected_to' | 'works_at' | 'discussed_with'
  attributes: Record<string, unknown>
}

export type RowOutcomeUpdate = {
  memberPath: string
  rowOrdinal: number
  outcome: LinkedInRowOutcome
  outcomeReason: string
  entityIds: string[]
}

export type LinkedInProjection = {
  entities: ProjectedEntity[]
  identities: ExternalIdentity[]
  edges: ProjectedEdge[]
  rowOutcomes: RowOutcomeUpdate[]
}
