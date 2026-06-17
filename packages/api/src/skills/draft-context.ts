/**
 * `getSkillDraftContext` — the workspace grounding for the skill draft agent
 * (`docs/plans/brain-skill-management-ux.md` §3.2: "draft according to the
 * user's pattern and brain info").
 *
 * Three cheap RLS-gated reads, pre-truncated for the prompt:
 *   - recent workspace memories (the team's stated preferences + patterns),
 *   - the entity vocabulary (real names for examples),
 *   - existing skills (voice/granularity matching + duplicate avoidance).
 *
 * All reads go through `queryWithRLS(userId, …)` so the caller only ever sees
 * what their own clearance allows — the draft prompt can't leak rows the user
 * couldn't read in the Brain.
 *
 * [COMP:skills/draft-context]
 */

import { queryWithRLS } from '../db/client.js'
import type { SkillDraftContext } from './draft-generator.js'

const MEMORY_LIMIT = 40
const ENTITY_LIMIT = 100
const SKILL_LIMIT = 30
const MEMORY_SNIPPET_CHARS = 240

export async function getSkillDraftContext(
  userId: string,
  workspaceId: string,
): Promise<SkillDraftContext> {
  const [memories, entities, skills] = await Promise.all([
    queryWithRLS<{ summary: string | null; detail: string | null }>(
      userId,
      `SELECT summary, detail FROM memories
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT ${MEMORY_LIMIT}`,
      [workspaceId],
    ),
    queryWithRLS<{ display_name: string; kind: string }>(
      userId,
      `SELECT display_name, kind FROM entities
       WHERE workspace_id = $1
       ORDER BY created_at DESC
       LIMIT ${ENTITY_LIMIT}`,
      [workspaceId],
    ),
    queryWithRLS<{ name: string; when_to_use: string | null }>(
      userId,
      `SELECT name, when_to_use FROM workspace_skills
       WHERE workspace_id = $1 AND valid_to IS NULL AND state <> 'archived'
       ORDER BY created_at DESC
       LIMIT ${SKILL_LIMIT}`,
      [workspaceId],
    ),
  ])

  return {
    memories: memories.rows
      .map((m) => [m.summary, m.detail].filter(Boolean).join(' - ').slice(0, MEMORY_SNIPPET_CHARS))
      .filter((s) => s.length > 0),
    entities: entities.rows.map((e) => `${e.display_name} (${e.kind})`),
    existingSkills: skills.rows.map((s) => ({ name: s.name, whenToUse: s.when_to_use })),
  }
}
