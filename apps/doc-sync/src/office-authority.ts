/** Current-authority gate for every Office room recipient and mutation.
 * [COMP:doc-sync/office-collab] */
import type { ResolvedOfficeAccess } from '@use-brian/api/office/access.js'
import { parseSyncDocumentName } from './document-router.js'

export type OfficeConnectionContext = {
  service?: true
  userId?: string
  sessionId?: string
  authVersion?: number
  workspaceId?: string
  role?: string
  office?: true
}

export type OfficeRoomConnection = {
  context?: OfficeConnectionContext
  readOnly: boolean
  sendStateless(message: string): void
  close(event?: { code: number; reason: string }): void
}

export type OfficeRoomDocument = {
  getConnections(): OfficeRoomConnection[]
}

export type OfficeAuthorityDeps = {
  validateSession(claims: { userId: string; sessionId?: string; authVersion?: number }): Promise<boolean>
  resolveAccess(userId: string, artifactId: string): Promise<ResolvedOfficeAccess | null>
}

export type OfficeConnectionAuthority = 'read-write' | 'read-only' | 'denied'

function deny(connection: OfficeRoomConnection): OfficeConnectionAuthority {
  connection.readOnly = true
  connection.sendStateless('office-access-denied')
  connection.close({ code: 4403, reason: 'Office access denied' })
  return 'denied'
}

/** Re-resolve one human connection immediately before it can consume or emit
 * another protected room update. Any resolver/session failure is denial. */
export async function revalidateOfficeConnection(params: {
  artifactId: string
  connection: OfficeRoomConnection
  deps: OfficeAuthorityDeps
}): Promise<OfficeConnectionAuthority> {
  const { connection } = params
  const context = connection.context
  if (!context?.userId || context.service) return deny(connection)
  try {
    const validSession = await params.deps.validateSession({
      userId: context.userId,
      sessionId: context.sessionId,
      authVersion: context.authVersion,
    })
    if (!validSession) return deny(connection)
    const access = await params.deps.resolveAccess(context.userId, params.artifactId)
    if (!access) return deny(connection)
    const wasReadOnly = connection.readOnly
    connection.readOnly = !access.canEdit
    context.workspaceId = access.workspaceId
    context.role = access.role
    context.office = true
    if (wasReadOnly !== connection.readOnly) {
      connection.sendStateless(connection.readOnly ? 'office-write-denied' : 'office-write-allowed')
    }
    return connection.readOnly ? 'read-only' : 'read-write'
  } catch {
    return deny(connection)
  }
}

/** Audit every recipient before a Yjs transaction can synchronously broadcast. */
export async function revalidateOfficeRoom(params: {
  artifactId: string
  document: OfficeRoomDocument
  deps: OfficeAuthorityDeps
}): Promise<Map<OfficeRoomConnection, OfficeConnectionAuthority>> {
  const connections = params.document.getConnections()
  const results = await Promise.all(connections.map(async connection => [
    connection,
    await revalidateOfficeConnection({ ...params, connection }),
  ] as const))
  return new Map(results)
}

/** Idle rooms get the same current-access behavior as active broadcast paths. */
export async function sweepOfficeRooms(params: {
  documents: ReadonlyMap<string, OfficeRoomDocument>
  deps: OfficeAuthorityDeps
}): Promise<number> {
  let audited = 0
  for (const [name, document] of params.documents) {
    let target
    try { target = parseSyncDocumentName(name) } catch { continue }
    if (target.kind !== 'office') continue
    audited += document.getConnections().length
    await revalidateOfficeRoom({ artifactId: target.id, document, deps: params.deps })
  }
  return audited
}
