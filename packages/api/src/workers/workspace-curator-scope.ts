/**
 * Workspace curator scope — the wiring adapter that lets the consolidation
 * worker run the weekly skill-hygiene passes (S10 umbrella absorption + CL-8
 * decay) per workspace.
 *
 * `createConsolidationWorker` takes an optional `workspaceCuratorScope`; when
 * present, every consolidation tick checks each workspace's umbrella/decay
 * cadence and runs the passes. This factory builds that scope from the API
 * stores. The pass-facing `SkillUmbrellaStore` / `SkillDecayStore` contracts
 * need a few mutations that no shared store method exposes (umbrella content
 * patch, support-file insert, absorption archive, bi-temporal soft-deprecate),
 * so those run here as system-level `query()` writes.
 *
 * RLS note: these writes use the bare `query()` helper (no user context) —
 * the curator is a privileged background pass with no acting user. The
 * `workspace_skills` / `workspace_skill_files` policies gate on
 * `app.current_user_id ∈ workspace_members`; with no user context set the
 * app-role (table owner) bypass applies, exactly as the sibling
 * `skill_curator_digest` store's system writes already rely on.
 *
 * Read eligibility (`listCuratorEligible`) is delegated to the canonical
 * `WorkspaceSkillStore` (background_review-origin, non-pinned, active/stale,
 * valid_to IS NULL) — its `WorkspaceSkill` rows are a structural superset of
 * the pass-facing `UmbrellaSkill`, so they flow through unchanged.
 *
 * Gated at the call site on `SKILLS_AUTO_GEN_ENABLED` (passed only when the
 * flag is on), so the hygiene passes ship dark with the rest of V2.
 *
 * [COMP:workers/workspace-curator-scope]
 */

import { query } from '../db/client.js'
import type { WorkspaceSkillStore } from '../db/skill-store.js'
import type { SkillCuratorDigestStore } from '../db/skill-curator-digest-store.js'
import type { WorkspaceCuratorScope } from '@use-brian/core'
import {
  applyDerivedSkillPatch,
  applyDerivedSkillSupportFile,
  createDerivedWorkspaceSkill,
  softDeprecateScopedSkill,
} from '../db/skill-derived-store.js'

export type WorkspaceCuratorScopeDeps = {
  /** Canonical read surface — supplies `listCuratorEligible`. */
  workspaceSkillStore: WorkspaceSkillStore
  /** Weekly digest sink (already system-level). Structurally satisfies the
   *  pass's `SkillUmbrellaDigestStore` contract. */
  digestStore: SkillCuratorDigestStore
  /** Batch embedder for S10 cluster detection. */
  getEmbeddings: (texts: string[]) => Promise<number[][]>
  onUmbrellaEvent?: WorkspaceCuratorScope['onUmbrellaEvent']
  onDecayEvent?: WorkspaceCuratorScope['onDecayEvent']
}

export function buildWorkspaceCuratorScope(
  deps: WorkspaceCuratorScopeDeps,
): WorkspaceCuratorScope {
  const listCuratorEligible = (workspaceId: string) =>
    // WorkspaceSkill is a structural superset of UmbrellaSkill.
    deps.workspaceSkillStore.listCuratorEligible(workspaceId)

  return {
    listWorkspaces: async () => {
      const r = await query<{ id: string; created_at: Date }>(
        `SELECT id, created_at FROM workspaces ORDER BY created_at ASC`,
        [],
      )
      return r.rows.map((w) => ({ workspaceId: w.id, createdAt: w.created_at }))
    },

    getEmbeddings: deps.getEmbeddings,
    digestStore: deps.digestStore,
    onUmbrellaEvent: deps.onUmbrellaEvent,
    onDecayEvent: deps.onDecayEvent,

    umbrellaStore: {
      listCuratorEligible,

      async patchUmbrella(skillId, patch) {
        await applyDerivedSkillPatch({
          workspaceId: patch.derivation.sources[0]!.workspaceId,
          skillId,
          content: patch.content,
          diff: patch.diff,
          evidence: patch.derivation,
        })
      },

      async createUmbrella(workspaceId, draft) {
        // System-level auto-generated insert (author_id NULL — no acting
        // user). Mirrors the column list of `WorkspaceSkillStore.create`.
        // `induction_source = 'self'`: a curator umbrella is a consolidation of the
        // team's OWN auto-learned skills — self-induced, not authored by a human.
        // Confidence + activated_at are left to their column defaults (0.0, NULL) so
        // the umbrella is born SUGGESTED: unlike the approval-admitted `self` path,
        // no human gated this consolidation, so it waits for review before running.
        const r = await createDerivedWorkspaceSkill({
          workspaceId,
          authorUserId: null,
          slug: draft.slug,
          name: draft.name,
          description: draft.description,
          whenToUse: draft.whenToUse,
          content: draft.content,
          category: draft.category,
          requiresConnectors: draft.requiresConnectors,
          source: 'auto-generated',
          writeOrigin: 'background_review',
          originatingAssistantId: draft.originatingAssistantId,
          inductionSource: 'self',
          humanApproved: false,
          evidence: draft.derivation,
        })
        // Seed the proposer's enablement row — the allowlist is the single
        // source of truth for offering scope (mig 264), so without this the
        // new suggested umbrella would be offered to nobody. enabled_by NULL
        // marks it system-seeded; the Access matrix can toggle it off.
        if (draft.originatingAssistantId) {
          await query(
            `INSERT INTO workspace_skill_enablement
               (workspace_skill_id, assistant_id, enabled_by_user_id)
             VALUES ($1, $2, NULL)
             ON CONFLICT (workspace_skill_id, assistant_id) DO NOTHING`,
            [r.rowId, draft.originatingAssistantId],
          )
        }
        return { rowId: r.rowId }
      },

      async addSupportFile(params) {
        await applyDerivedSkillSupportFile({
          workspaceId: params.derivation.sources[0]!.workspaceId,
          skillId: params.umbrellaRowId,
          kind: params.kind,
          name: params.name,
          content: params.content,
          description: params.description,
          evidence: params.derivation,
        })
      },

      async recordAbsorption(memberRowId, umbrellaRowId) {
        await query(
          `UPDATE workspace_skills
           SET state = 'archived',
               state_transitioned_at = now(),
               absorbed_into = $2,
               absorbed_at = now(),
               updated_at = now()
           WHERE id = $1`,
          [memberRowId, umbrellaRowId],
        )
      },
    },

    decayStore: {
      listCuratorEligible,

      async softDeprecate(skillRowId, _reason, source) {
        // Bi-temporal close — idempotent (the WHERE no-ops a row already past
        // valid_to). The decay reason lives in the event stream for V2.
        await softDeprecateScopedSkill({
          workspaceId: source.workspaceId,
          skillId: skillRowId,
          source,
        })
      },
    },
  }
}
