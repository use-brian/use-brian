/** Edition-local eligibility for model-backed background work. */
export type BackgroundInferencePolicy = {
  /** A trusted, parameter-free query returning one `workspace_id` column. */
  excludedWorkspaceIdsSql: string
  assertAllowed(workspaceId: string): Promise<void>
}

/** Safe for nullable workspace IDs. Both SQL fragments come from composition. */
export function backgroundWorkspaceFilter(workspaceColumn: string, excludedWorkspaceIdsSql?: string): string {
  if (!excludedWorkspaceIdsSql) return ''
  return `AND NOT EXISTS (
    SELECT 1 FROM (${excludedWorkspaceIdsSql}) excluded_background
     WHERE excluded_background.workspace_id = ${workspaceColumn}
  )`
}
