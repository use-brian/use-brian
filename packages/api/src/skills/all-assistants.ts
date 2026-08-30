/**
 * Converting the `all_assistants` intent back into materialised rows.
 *
 * A workspace skill expresses "who is offered this" in one of two ways
 * (mig 491, `docs/architecture/engine/skill-system.md` → "Per-assistant
 * enablement"):
 *
 *   * `workspace_skills.all_assistants = true` — every assistant in the
 *     workspace, INCLUDING ones created later. Carries no rows.
 *   * `workspace_skill_enablement` rows — exactly the listed assistants.
 *
 * The flag exists because rows cannot express "and future ones": every write
 * path only ever seeded the assistants alive at that instant, so an assistant
 * created afterwards silently got nothing.
 *
 * The moment a user turns the skill off for ONE assistant, the flag can no
 * longer say what they mean — so it must be CONVERTED: write a row for every
 * other assistant, then clear the flag. Clearing the flag alone would drop the
 * skill for everybody, which is the failure this whole feature exists to stop.
 *
 * Three call sites do this same conversion and must not drift:
 *   1. `PUT /api/skills/:id/access`            (skill-centric, many assistants)
 *   2. `POST /api/assistants/:id/workspace-skills/:sid/disable`
 *                                              (assistant-centric, one skill)
 *   3. `skill_manage` disable                  (agent-surface write tool)
 * plus the "disable everywhere" path, which clears the flag AND drops rows.
 *
 * [COMP:api/skill-all-assistants]
 */

import type { WorkspaceSkillStore } from '../db/skill-store.js'
import type { WorkspaceSkillEnablementStore } from '../db/workspace-skill-enablement-store.js'

export type MaterialiseInput = {
  /** The skill being narrowed. Only these three fields are read. */
  skill: { rowId: string; workspaceId: string; allAssistants: boolean }
  /** Whoever is making the change — RLS subject and `enabled_by_user_id`. */
  actingUserId: string
  /**
   * Every assistant in the skill's workspace. Called ONLY when a conversion is
   * actually needed, so a no-op costs no query.
   */
  listAssistantIds: () => Promise<string[]>
  enablementStore: Pick<WorkspaceSkillEnablementStore, 'enable'>
  workspaceSkillStore: Pick<WorkspaceSkillStore, 'setAllAssistants'>
  /**
   * Assistants to leave OUT of the materialised set — the ones being turned
   * off. Omit to materialise the flag as-is (every assistant), which is what
   * "switch from all-assistants to an explicit list" wants before it applies
   * its own diff.
   */
  exclude?: readonly string[]
}

export type MaterialiseResult = {
  /** False when the skill was not flagged — the caller's normal row logic applies. */
  converted: boolean
  /** The assistants that now hold a row. Empty when `converted` is false. */
  enabledAssistantIds: string[]
}

/**
 * Turn `all_assistants = true` into explicit rows, minus `exclude`.
 *
 * No-op (and no queries) when the skill is not flagged.
 *
 * **Write order is load-bearing: rows FIRST, flag SECOND.** A crash between
 * the two leaves the flag set, so the skill stays offered to everyone —
 * redundant rows, and `enable` is idempotent, so the retry is clean. The
 * reverse order would strand the skill on a half-written row set, silently
 * revoking it from assistants the user never touched.
 */
export async function materialiseAllAssistants(
  input: MaterialiseInput,
): Promise<MaterialiseResult> {
  const { skill, actingUserId, enablementStore, workspaceSkillStore } = input
  if (!skill.allAssistants) return { converted: false, enabledAssistantIds: [] }

  const excluded = new Set(input.exclude ?? [])
  const ids = await input.listAssistantIds()
  const wanted = ids.filter((id) => !excluded.has(id))

  // 1. Rows first.
  for (const assistantId of wanted) {
    await enablementStore.enable(skill.rowId, assistantId, actingUserId)
  }
  // 2. Flag second.
  await workspaceSkillStore.setAllAssistants(
    actingUserId,
    skill.workspaceId,
    skill.rowId,
    false,
  )

  return { converted: true, enabledAssistantIds: wanted }
}

/**
 * "Disable everywhere": drop every row AND clear the flag.
 *
 * `disableAll` alone is not enough — on a flagged skill it deletes zero rows
 * and leaves the flag standing, so the UI reports the skill disabled while the
 * runtime keeps offering it to every assistant. Order is the mirror of the
 * conversion above: clear the FLAG first, so a crash leaves the skill offered
 * to strictly fewer assistants rather than more.
 */
export async function disableForAllAssistants(input: {
  skill: { rowId: string; workspaceId: string; allAssistants: boolean }
  actingUserId: string
  enablementStore: Pick<WorkspaceSkillEnablementStore, 'disableAll'>
  workspaceSkillStore: Pick<WorkspaceSkillStore, 'setAllAssistants'>
}): Promise<void> {
  const { skill, actingUserId, enablementStore, workspaceSkillStore } = input
  if (skill.allAssistants) {
    await workspaceSkillStore.setAllAssistants(
      actingUserId,
      skill.workspaceId,
      skill.rowId,
      false,
    )
  }
  await enablementStore.disableAll(skill.rowId)
}
