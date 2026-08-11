/**
 * Uploaded workspace-icon pointer persistence.
 *
 * The route owns authorization; this module owns the system-pool row pointer
 * because `workspaces` has no RLS. Replacements and clears compare-and-swap on
 * `icon_storage_key`, so a slower concurrent request cannot overwrite a newer
 * icon choice. See docs/architecture/platform/workspaces.md -> "Workspace icon".
 *
 * [COMP:api/workspace-icon]
 */

import { query } from './client.js'

export type WorkspaceIconPointer = {
  iconUrl: string | null
  iconStorageKey: string | null
  iconStorageUri: string | null
}

const ICON_COLUMNS = `
  icon_url AS "iconUrl",
  icon_storage_key AS "iconStorageKey",
  icon_storage_uri AS "iconStorageUri"
` as const

/** System read used by the public byte proxy and authorized write routes. */
export async function getWorkspaceIconPointer(
  workspaceId: string,
): Promise<WorkspaceIconPointer | null> {
  const result = await query<WorkspaceIconPointer>(
    `SELECT ${ICON_COLUMNS} FROM workspaces WHERE id = $1`,
    [workspaceId],
  )
  return result.rows[0] ?? null
}

/**
 * Install a new pointer only if `expectedStorageKey` is still current.
 * `null` matches a workspace that has no uploaded icon.
 */
export async function replaceWorkspaceIconPointer(
  workspaceId: string,
  expectedStorageKey: string | null,
  next: { iconUrl: string; iconStorageKey: string; iconStorageUri: string },
): Promise<WorkspaceIconPointer | null> {
  const result = await query<WorkspaceIconPointer>(
    `UPDATE workspaces
        SET icon_url = $1,
            icon_storage_key = $2,
            icon_storage_uri = $3,
            updated_at = now()
      WHERE id = $4
        AND icon_storage_key IS NOT DISTINCT FROM $5
      RETURNING ${ICON_COLUMNS}`,
    [
      next.iconUrl,
      next.iconStorageKey,
      next.iconStorageUri,
      workspaceId,
      expectedStorageKey,
    ],
  )
  return result.rows[0] ?? null
}

/** Clear the current pointer without clobbering a concurrent replacement. */
export async function clearWorkspaceIconPointer(
  workspaceId: string,
  expectedStorageKey: string,
): Promise<boolean> {
  const result = await query(
    `UPDATE workspaces
        SET icon_url = NULL,
            icon_storage_key = NULL,
            icon_storage_uri = NULL,
            updated_at = now()
      WHERE id = $1
        AND icon_storage_key = $2`,
    [workspaceId, expectedStorageKey],
  )
  return (result.rowCount ?? 0) > 0
}
