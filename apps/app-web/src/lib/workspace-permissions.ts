/**
 * Whether the "Delete workspace" control should be offered in the UI.
 *
 * A workspace is user-deletable only by its **owner** AND only when it is not
 * the user's auto-created **Personal** workspace. Personal workspaces are tied
 * to the user lifecycle — every user always has exactly one — so the API
 * refuses to delete them: `workspaceStore.delete()` filters
 * `is_personal = false`, matches zero rows, and the route returns 404. If the
 * UI shows a Delete button anyway, the click is a silent dead 404 ("the button
 * does nothing") — the exact bug this guard prevents.
 *
 * Mirror of `apps/web/src/lib/workspace-permissions.ts` (the two web apps don't
 * share a lib). Spec: docs/architecture/platform/workspaces.md → "Workspace
 * deletion".
 */
export function canDeleteWorkspace(role: string, isPersonal: boolean): boolean {
  return role === "owner" && !isPersonal;
}
