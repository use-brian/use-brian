/**
 * Workspace directory — read-only member-roster lookup.
 *
 * A workspace assistant needs the roster to do task assignment:
 * `tasks.assignee_id` is a `workspace_members.id`, so the model must be
 * able to turn "assign it to Dana" into that id. Without this surface the
 * id is undiscoverable from chat and assignment silently breaks.
 *
 * Injected by the API layer into `createWorkspaceTools`. The core package
 * has no DB dependency — the concrete impl lives in `packages/api/src/db`.
 * See docs/architecture/platform/workspaces.md → "Member directory tool".
 */

export type WorkspaceMemberInfo = {
  /** `workspace_members.id` — the value `tasks.assignee_id` references. */
  memberId: string
  /** Display name from the joined user row; null if the user has none. */
  name: string | null
  /** Email from the joined user row; null if absent. */
  email: string | null
  /** Avatar URL from the joined user row; null/undefined if absent. */
  avatarUrl?: string | null
  role: 'owner' | 'admin' | 'member'
  /**
   * `true` on exactly the row that belongs to the caller of `listMembers`
   * (the person currently talking to the assistant); absent elsewhere. Lets
   * the model turn "me" / "my tasks" / "assign it to me" into an
   * `assignee_id` deterministically instead of name-matching itself against
   * the roster — a nameless member (`name: null`) has nothing to match on,
   * and a guess picks a teammate (2026-08-19, Slack). Set only by
   * `listMembers`; `get` / `batchGet` have no caller to mark.
   */
  isCurrentUser?: true
}

export type WorkspaceDirectoryStore = {
  /**
   * List every member of `workspaceId` — but only when `userId` is itself
   * a member of it. A non-member caller gets an empty array (defence in
   * depth; a workspace assistant's caller is always a member in practice).
   * The caller's own row carries `isCurrentUser: true`.
   */
  listMembers(userId: string, workspaceId: string): Promise<WorkspaceMemberInfo[]>
  /**
   * Look up a single member by id, scoped to `workspaceId`. Returns null
   * if the id isn't a member of that workspace (handles cross-workspace
   * stale references defensively).
   *
   * Intended for view bindings (Phase 1 — Notion-feel) which resolve
   * `tasks.assignee_id` → display name for PersonWidget cells.
   */
  get(workspaceId: string, memberId: string): Promise<WorkspaceMemberInfo | null>
  /**
   * Batch variant of `get` — resolves a set of member ids in one round
   * trip. Avoids the N+1 trap in view bindings that emit a PersonWidget
   * per row. Map keys are the input `memberIds`; ids not in this
   * workspace are omitted from the result.
   */
  batchGet(workspaceId: string, memberIds: string[]): Promise<Map<string, WorkspaceMemberInfo>>
}
