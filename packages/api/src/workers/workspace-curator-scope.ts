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
import type { WorkspaceCuratorScope } from '@sidanclaw/core'

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
        // In-place content patch + 30-day undo diff. No lease gate — the
        // weekly pass is the sole writer of this row class during its run.
        await query(
          `UPDATE workspace_skills
           SET content = $1,
               last_patch_diff = $2,
               last_patch_diff_at = now(),
               updated_at = now()
           WHERE id = $3 AND valid_to IS NULL`,
          [patch.content, patch.diff, skillId],
        )
      },

      async createUmbrella(workspaceId, draft) {
        // System-level auto-generated insert (author_id NULL — no acting
        // user). Mirrors the column list of `WorkspaceSkillStore.create`.
        const r = await query<{ id: string }>(
          `INSERT INTO workspace_skills (
             slug, name, description, when_to_use, content, category,
             requires_connectors, source, author_id, workspace_id,
             write_origin, originating_assistant_id, auto_generated_at
           )
           VALUES ($1,$2,$3,$4,$5,$6,$7,'auto-generated',NULL,$8,'background_review',$9,now())
           RETURNING id`,
          [
            draft.slug,
            draft.name,
            draft.description,
            draft.whenToUse ?? null,
            draft.content,
            draft.category ?? 'custom',
            draft.requiresConnectors ?? [],
            workspaceId,
            draft.originatingAssistantId ?? null,
          ],
        )
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
            [r.rows[0].id, draft.originatingAssistantId],
          )
        }
        return { rowId: r.rows[0].id }
      },

      async addSupportFile(params) {
        await query(
          `INSERT INTO workspace_skill_files (workspace_skill_id, kind, name, content, description)
           VALUES ($1,$2,$3,$4,$5)
           ON CONFLICT (workspace_skill_id, kind, name) DO UPDATE
             SET content = EXCLUDED.content,
                 description = EXCLUDED.description,
                 updated_at = now()`,
          [params.umbrellaRowId, params.kind, params.name, params.content, params.description ?? null],
        )
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

      async softDeprecate(skillRowId) {
        // Bi-temporal close — idempotent (the WHERE no-ops a row already past
        // valid_to). The decay reason lives in the event stream for V2.
        await query(
          `UPDATE workspace_skills
           SET valid_to = now(),
               updated_at = now()
           WHERE id = $1 AND valid_to IS NULL`,
          [skillRowId],
        )
      },
    },
  }
}
