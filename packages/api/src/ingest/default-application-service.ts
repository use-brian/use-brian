/** Composition helpers shared by OSS boot and the hosted adapter. */
import type { AccessContext, Sensitivity } from '@use-brian/core'

import { resolveTurnScopeSystem, type TurnScopeAssistant } from '../context-scope/resolve-turn-scope.js'
import { query } from '../db/client.js'
import { createDbEpisodesStore } from '../db/episodes-store.js'
import { createExtractionApplicationStore } from '../db/extraction-application-store.js'
import { createWorkspaceStore } from '../db/workspace-store.js'
import { createIngestApplicationService } from './application-service.js'
import { createPipelineBApplicationMutationPort } from './pipeline-b-application-adapter.js'

type AssistantRow = {
  id: string
  workspaceId: string
  kind: TurnScopeAssistant['kind']
  clearance: Sensitivity
  compartments: string[] | null
  defaultCompartments: string[] | null
  teamScopeMode: 'legacy' | 'all' | 'assigned'
  defaultWorkspaceGroupId: string | null
  projectScopeMode: 'all' | 'assigned'
  defaultProjectId: string | null
}

export function createDefaultIngestApplicationService() {
  const workspaceStore = createWorkspaceStore()
  return createIngestApplicationService({
    store: createExtractionApplicationStore(),
    episodes: createDbEpisodesStore(),
    mutateCandidate: createPipelineBApplicationMutationPort(),
    getWorkspaceRole: (userId, workspaceId) => workspaceStore.getRole(userId, workspaceId),
  })
}

export async function resolveIngestApplicationAccess(
  userId: string,
  workspaceId: string | undefined,
  episodeId?: string,
): Promise<AccessContext> {
  const result = await query<AssistantRow>(
    `SELECT a.id,a.workspace_id AS "workspaceId",a.kind,a.clearance,
            a.compartments,a.default_compartments AS "defaultCompartments",
            a.team_scope_mode AS "teamScopeMode",
            a.default_workspace_group_id AS "defaultWorkspaceGroupId",
            a.project_scope_mode AS "projectScopeMode",
            a.default_project_id AS "defaultProjectId"
       FROM assistants a
      WHERE a.workspace_id=coalesce($1::uuid,(
        SELECT e.workspace_id FROM episodes e WHERE e.id=$2
      ))
        AND ($2::uuid IS NULL OR coalesce((
          SELECT e.assistant_id=a.id FROM episodes e WHERE e.id=$2
        ),a.kind='primary'))
      ORDER BY CASE WHEN a.kind='primary' THEN 0 ELSE 1 END,a.created_at
      LIMIT 1`,
    [workspaceId ?? null, episodeId ?? null],
  )
  const assistant = result.rows[0]
  if (!assistant) throw Object.assign(new Error('Application source is not available'), { code: 'not_found' })
  return (await resolveTurnScopeSystem({
    userId,
    workspaceId: assistant.workspaceId,
    assistant: {
      id: assistant.id,
      workspaceId: assistant.workspaceId,
      kind: assistant.kind,
      clearance: assistant.clearance,
      compartments: assistant.compartments,
      defaultCompartments: assistant.defaultCompartments,
      teamScopeMode: assistant.teamScopeMode,
      defaultWorkspaceGroupId: assistant.defaultWorkspaceGroupId,
      projectScopeMode: assistant.projectScopeMode,
      defaultProjectId: assistant.defaultProjectId,
    },
  })).access
}
