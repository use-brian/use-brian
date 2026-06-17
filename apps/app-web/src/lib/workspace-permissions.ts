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

/**
 * Whether a workspace is *shared* — it has more than one member. Connector
 * sharing keys on this, **never** on `is_personal` (which is only a label): a
 * solo workspace already auto-loads the owner's personal connectors, so the
 * "Share with this workspace" control + auto-expose only make sense once a
 * teammate exists. An absent count reads as solo (1) — fail to "not shared" so
 * the share control never flashes before the member list resolves. Spec:
 * docs/architecture/platform/workspaces.md → "Personal connectors auto-load
 * only while solo".
 */
export function isSharedWorkspace(memberCount?: number): boolean {
  return (memberCount ?? 1) > 1;
}
