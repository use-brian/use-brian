/**
 * Memory-scope classifier rules (P4).
 *
 * Pipeline B's memory-write path was fixed in PR 0 to translate model-
 * facing `'user' | 'team'` into DB-vocabulary `'shared' | 'workspace'`
 * via `toDbScope`. The actual scope decision in v1 is deterministic
 * from assistant context (chat-tool layer at memory/tools.ts:255-271):
 *
 *   if assistant.kind === 'app' && workspaceId present:
 *     default = 'team' (DB: 'workspace')
 *   else:
 *     default = 'user' (DB: 'shared')
 *
 * This file formalises that as a small rule surface for the framework.
 * The rules don't (yet) plug into a per-write hook — the chat tool's
 * existing logic remains the canonical write path — but they document
 * the contract and serve as a regression target.
 *
 * Spec: docs/architecture/brain/classification/memory-scope.md
 */

export type MemoryScopeContext = {
  assistantKind: 'primary' | 'standard' | 'app'
  workspaceId: string | null | undefined
  sensitivity?: 'public' | 'internal' | 'confidential'
  emittedScope?: 'user' | 'team'
}

export type MemoryScopeDecision = {
  scope: 'user' | 'team'
  ruleId: string
  forced: boolean
}

/**
 * Apply the four-rule decision tree.
 *
 *   1. confidential-blocks-team: confidential + team → force 'user'
 *      (workspace-shared confidential silently leaks per-user secrets)
 *   2. no-workspace-blocks-team: emitted 'team' without workspaceId
 *      → force 'user'
 *   3. app-assistant-team-default: app kind + workspaceId → default
 *      to 'team' when no emission provided
 *   4. personal-assistant-user-default: everything else → 'user'
 */
export function decideMemoryScope(ctx: MemoryScopeContext): MemoryScopeDecision {
  // Rule 1 — confidential blocks team
  if (ctx.emittedScope === 'team' && ctx.sensitivity === 'confidential') {
    return { scope: 'user', ruleId: 'memory-scope-confidential-blocks-team', forced: true }
  }
  // Rule 2 — no workspace blocks team
  if (ctx.emittedScope === 'team' && !ctx.workspaceId) {
    return { scope: 'user', ruleId: 'memory-scope-no-workspace-blocks-team', forced: true }
  }
  // Rules 3/4 — pick the default
  if (ctx.emittedScope) {
    return { scope: ctx.emittedScope, ruleId: 'memory-scope-emitted', forced: false }
  }
  if (ctx.assistantKind === 'app' && ctx.workspaceId) {
    return { scope: 'team', ruleId: 'memory-scope-app-assistant-team-default', forced: false }
  }
  return { scope: 'user', ruleId: 'memory-scope-personal-assistant-user-default', forced: false }
}
