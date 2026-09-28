/**
 * Website media library — the staff-managed images and PDFs an association's
 * public websites render. Bytes live in the app-default blob store (GCS,
 * Azure Blob or local disk) like every workspace file; rows live in
 * `workspace_files` under the reserved `/doc/website-media/` prefix, which
 * inherits the `/doc/` exclusion from brain retrieval (`fileSearch` and the L1
 * `# Workspace Files` block) so decorative site media never enters an
 * assistant's context.
 *
 * System-scoped reads on purpose: the member route checks workspace role
 * before calling, and the integration route checks the key's
 * `association.read` grant. Both are pinned to the prefix and the media MIME
 * allow-list here, so neither caller can reach any other workspace file.
 *
 * [COMP:api/association-media]
 */

import { query } from './client.js'

export const WEBSITE_MEDIA_PREFIX = '/doc/website-media/'

/** Image and document types a public website may render or link. SVG is
 *  excluded: it is script-capable and the sites' image pipeline refuses it. */
export const WEBSITE_MEDIA_MIME = [
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'image/avif',
  'application/pdf',
] as const

export type WebsiteMediaFile = {
  id: string
  name: string
  title: string | null
  mime: string
  sizeBytes: number
  storageUri: string
  updatedAt: string
}

type Row = {
  id: string
  name: string
  title: string | null
  mime: string
  size_bytes: string | number
  storage_uri: string
  updated_at: Date
}

const toFile = (row: Row): WebsiteMediaFile => ({
  id: row.id,
  name: row.name,
  title: row.title,
  mime: row.mime,
  sizeBytes: Number(row.size_bytes),
  storageUri: row.storage_uri,
  updatedAt: row.updated_at.toISOString(),
})

export type WebsiteMediaStore = {
  list(workspaceId: string): Promise<WebsiteMediaFile[]>
  get(workspaceId: string, id: string): Promise<WebsiteMediaFile | null>
}

const LIVE = `valid_to IS NULL AND retracted_at IS NULL AND path LIKE $2 AND mime = ANY($3::text[])`

export function createWebsiteMediaStore(run: typeof query = query): WebsiteMediaStore {
  return {
    async list(workspaceId) {
      const result = await run<Row>(
        `SELECT id, name, title, mime, size_bytes, storage_uri, updated_at FROM workspace_files
          WHERE workspace_id = $1 AND ${LIVE}
          ORDER BY updated_at DESC LIMIT 1000`,
        [workspaceId, `${WEBSITE_MEDIA_PREFIX}%`, [...WEBSITE_MEDIA_MIME]],
      )
      return result.rows.map(toFile)
    },
    async get(workspaceId, id) {
      if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) return null
      const result = await run<Row>(
        `SELECT id, name, title, mime, size_bytes, storage_uri, updated_at FROM workspace_files
          WHERE workspace_id = $1 AND ${LIVE} AND id = $4`,
        [workspaceId, `${WEBSITE_MEDIA_PREFIX}%`, [...WEBSITE_MEDIA_MIME], id],
      )
      return result.rows[0] ? toFile(result.rows[0]) : null
    },
  }
}

/** Record who added a library file through the Association service (assistant tools). */
export async function recordWebsiteMediaAdded(
  workspaceId: string,
  mediaId: string,
  actor: { credentialKind: string; credentialId: string; actingUserId?: string },
  run: typeof query = query,
): Promise<void> {
  await run(
    `INSERT INTO association_audit_log (workspace_id,action,subject_kind,subject_id,actor_kind,actor_credential_id,acting_user_id,metadata)
     VALUES ($1,'website_media.added','website_media',$2,$3,$4,$5,'{}'::jsonb)`,
    [workspaceId, mediaId, actor.credentialKind, actor.credentialId, actor.actingUserId ?? null],
  )
}
