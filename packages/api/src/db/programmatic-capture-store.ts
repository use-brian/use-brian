/**
 * Reusable assistant-level programmatic capture profiles.
 *
 * Profiles own ordered `source='programmatic'` Pipeline-C rules. Assistants
 * select a default profile; Brain credentials may override it. All operator
 * methods are RLS-gated and routes add the owner/admin gate. Runtime reads use
 * the system pool only after a Brain credential has authenticated.
 *
 * [COMP:api/programmatic-capture]
 */

import { query, queryWithRLS } from './client.js'

export type CapturePartitionBy = 'connection' | 'user' | 'session' | 'subject'
export type CaptureRoutingMode = 'realtime' | 'scheduled' | 'drop'
export type CaptureSensitivity = 'public' | 'internal' | 'confidential'

export type ProgrammaticCaptureRule = {
  id: string
  profileId: string
  ruleOrder: number
  filterType: string
  filterParams: Record<string, unknown>
  routingMode: CaptureRoutingMode
  routingSchedule: string | null
  routingTimezone: string
  episodeSensitivity: CaptureSensitivity | null
  compartments: string[]
  projectIds: string[]
}

export type ProgrammaticCaptureProfile = {
  id: string
  workspaceId: string
  name: string
  partitionBy: CapturePartitionBy
  enabled: boolean
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
  assistantIds: string[]
  rules: ProgrammaticCaptureRule[]
}

export type ProgrammaticCaptureTarget = {
  workspaceId: string
  ownerUserId: string
  assistantId: string
  assistantName: string
  assistantClearance: CaptureSensitivity
  assistantDefaultCompartments: string[]
  assistantDefaultProjectId: string | null
  profileId: string
  profileName: string
  partitionBy: CapturePartitionBy
  rules: ProgrammaticCaptureRule[]
}

export type ProgrammaticCaptureBatchTarget = Pick<
  ProgrammaticCaptureTarget,
  | 'workspaceId'
  | 'ownerUserId'
  | 'assistantId'
  | 'assistantName'
  | 'assistantClearance'
  | 'assistantDefaultCompartments'
  | 'assistantDefaultProjectId'
  | 'profileId'
  | 'profileName'
>

export type CaptureRuleInput = {
  ruleOrder?: number
  filterType: string
  filterParams?: Record<string, unknown>
  routingMode: CaptureRoutingMode
  routingSchedule?: string | null
  routingTimezone?: string
  episodeSensitivity?: CaptureSensitivity | null
  compartments?: string[]
  projectIds?: string[]
}

export type ProgrammaticCaptureStore = {
  listProfiles(actingUserId: string, workspaceId: string): Promise<ProgrammaticCaptureProfile[]>
  createProfile(input: {
    actingUserId: string
    workspaceId: string
    name: string
    partitionBy: CapturePartitionBy
    enabled: boolean
  }): Promise<ProgrammaticCaptureProfile>
  updateProfile(input: {
    actingUserId: string
    workspaceId: string
    profileId: string
    name: string
    partitionBy: CapturePartitionBy
    enabled: boolean
  }): Promise<ProgrammaticCaptureProfile | null>
  deleteProfile(actingUserId: string, workspaceId: string, profileId: string): Promise<boolean>
  addRule(input: {
    actingUserId: string
    workspaceId: string
    profileId: string
    rule: CaptureRuleInput
  }): Promise<ProgrammaticCaptureRule | null>
  updateRule(input: {
    actingUserId: string
    workspaceId: string
    profileId: string
    ruleId: string
    rule: CaptureRuleInput
  }): Promise<ProgrammaticCaptureRule | null>
  deleteRule(input: {
    actingUserId: string
    workspaceId: string
    profileId: string
    ruleId: string
  }): Promise<boolean>
  setAssistantProfile(input: {
    actingUserId: string
    workspaceId: string
    assistantId: string
    profileId: string | null
  }): Promise<boolean>
  resolveTargetSystem(input: {
    workspaceId: string
    /** Null means this connection has no routed-capture destination. */
    assistantId: string | null
    overrideProfileId: string | null
  }): Promise<ProgrammaticCaptureTarget | null>
  resolveBatchTargetSystem(
    workspaceId: string,
    assistantId: string,
    ruleId: string,
  ): Promise<ProgrammaticCaptureBatchTarget | null>
}

const PROFILE_COLS = `
  id,
  workspace_id AS "workspaceId",
  name,
  partition_by AS "partitionBy",
  enabled,
  created_by AS "createdBy",
  created_at AS "createdAt",
  updated_at AS "updatedAt"
` as const

const RULE_COLS = `
  id,
  capture_profile_id AS "profileId",
  rule_order AS "ruleOrder",
  filter_type AS "filterType",
  filter_params AS "filterParams",
  routing_mode AS "routingMode",
  routing_schedule AS "routingSchedule",
  routing_timezone AS "routingTimezone",
  episode_sensitivity AS "episodeSensitivity",
  compartments,
  project_ids AS "projectIds"
` as const

type ProfileRow = Omit<ProgrammaticCaptureProfile, 'assistantIds' | 'rules'>

async function loadProfiles(
  actingUserId: string,
  workspaceId: string,
): Promise<ProgrammaticCaptureProfile[]> {
  const [profiles, rules, assignments] = await Promise.all([
    queryWithRLS<ProfileRow>(
      actingUserId,
      `SELECT ${PROFILE_COLS}
         FROM programmatic_capture_profiles
        WHERE workspace_id = $1
        ORDER BY created_at ASC, id ASC`,
      [workspaceId],
    ),
    queryWithRLS<ProgrammaticCaptureRule>(
      actingUserId,
      `SELECT ${RULE_COLS}
         FROM ingest_rules r
         JOIN programmatic_capture_profiles p ON p.id = r.capture_profile_id
        WHERE p.workspace_id = $1
        ORDER BY r.capture_profile_id, r.rule_order, r.id`,
      [workspaceId],
    ),
    queryWithRLS<{ assistantId: string; profileId: string }>(
      actingUserId,
      `SELECT id AS "assistantId", capture_profile_id AS "profileId"
         FROM assistants
        WHERE workspace_id = $1 AND capture_profile_id IS NOT NULL
        ORDER BY created_at, id`,
      [workspaceId],
    ),
  ])

  const rulesByProfile = new Map<string, ProgrammaticCaptureRule[]>()
  for (const rule of rules.rows) {
    const list = rulesByProfile.get(rule.profileId) ?? []
    list.push({ ...rule, compartments: rule.compartments ?? [], projectIds: rule.projectIds ?? [] })
    rulesByProfile.set(rule.profileId, list)
  }
  const assistantsByProfile = new Map<string, string[]>()
  for (const assignment of assignments.rows) {
    const list = assistantsByProfile.get(assignment.profileId) ?? []
    list.push(assignment.assistantId)
    assistantsByProfile.set(assignment.profileId, list)
  }
  return profiles.rows.map((profile) => ({
    ...profile,
    assistantIds: assistantsByProfile.get(profile.id) ?? [],
    rules: rulesByProfile.get(profile.id) ?? [],
  }))
}

function validateSchedule(rule: CaptureRuleInput): void {
  if (rule.routingMode === 'scheduled' && !rule.routingSchedule) {
    throw new Error('scheduled rules require routingSchedule')
  }
  if (rule.routingMode !== 'scheduled' && rule.routingSchedule) {
    throw new Error(`${rule.routingMode} rules cannot carry routingSchedule`)
  }
}

export function createProgrammaticCaptureStore(): ProgrammaticCaptureStore {
  return {
    listProfiles: loadProfiles,

    async createProfile(input) {
      const result = await queryWithRLS<ProfileRow>(
        input.actingUserId,
        `INSERT INTO programmatic_capture_profiles
           (workspace_id, name, partition_by, enabled, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${PROFILE_COLS}`,
        [input.workspaceId, input.name, input.partitionBy, input.enabled, input.actingUserId],
      )
      return { ...result.rows[0]!, assistantIds: [], rules: [] }
    },

    async updateProfile(input) {
      const result = await queryWithRLS<ProfileRow>(
        input.actingUserId,
        `UPDATE programmatic_capture_profiles
            SET name = $3, partition_by = $4, enabled = $5, updated_at = now()
          WHERE id = $1 AND workspace_id = $2
          RETURNING ${PROFILE_COLS}`,
        [input.profileId, input.workspaceId, input.name, input.partitionBy, input.enabled],
      )
      const row = result.rows[0]
      if (!row) return null
      const full = (await loadProfiles(input.actingUserId, input.workspaceId))
        .find((profile) => profile.id === row.id)
      return full ?? { ...row, assistantIds: [], rules: [] }
    },

    async deleteProfile(actingUserId, workspaceId, profileId) {
      const result = await queryWithRLS(
        actingUserId,
        `DELETE FROM programmatic_capture_profiles WHERE id = $1 AND workspace_id = $2`,
        [profileId, workspaceId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async addRule(input) {
      validateSchedule(input.rule)
      let ruleOrder = input.rule.ruleOrder
      if (ruleOrder === undefined) {
        const tail = await queryWithRLS<{ max: number | null }>(
          input.actingUserId,
          `SELECT MAX(r.rule_order) AS max
             FROM ingest_rules r
             JOIN programmatic_capture_profiles p ON p.id = r.capture_profile_id
            WHERE r.capture_profile_id = $1 AND p.workspace_id = $2`,
          [input.profileId, input.workspaceId],
        )
        ruleOrder = (tail.rows[0]?.max ?? -1) + 1
      }
      const result = await queryWithRLS<ProgrammaticCaptureRule>(
        input.actingUserId,
        `INSERT INTO ingest_rules
           (connector_instance_id, capture_profile_id, source, rule_order,
            filter_type, filter_params, routing_mode, routing_schedule,
            routing_timezone, alert, episode_sensitivity, compartments, project_ids)
         SELECT NULL, p.id, 'programmatic', $3, $4, $5::jsonb, $6, $7, $8,
                false, $9, $10, $11
           FROM programmatic_capture_profiles p
          WHERE p.id = $1 AND p.workspace_id = $2
         RETURNING ${RULE_COLS}`,
        [
          input.profileId,
          input.workspaceId,
          ruleOrder,
          input.rule.filterType,
          JSON.stringify(input.rule.filterParams ?? {}),
          input.rule.routingMode,
          input.rule.routingSchedule ?? null,
          input.rule.routingTimezone ?? 'UTC',
          input.rule.episodeSensitivity ?? null,
          input.rule.compartments ?? [],
          input.rule.projectIds ?? [],
        ],
      )
      const row = result.rows[0]
      return row ? { ...row, compartments: row.compartments ?? [], projectIds: row.projectIds ?? [] } : null
    },

    async updateRule(input) {
      validateSchedule(input.rule)
      const result = await queryWithRLS<ProgrammaticCaptureRule>(
        input.actingUserId,
        `UPDATE ingest_rules r
            SET rule_order = $4,
                filter_type = $5,
                filter_params = $6::jsonb,
                routing_mode = $7,
                routing_schedule = $8,
                routing_timezone = $9,
                episode_sensitivity = $10,
                compartments = $11,
                project_ids = $12
           FROM programmatic_capture_profiles p
          WHERE r.id = $1
            AND r.capture_profile_id = $2
            AND p.id = r.capture_profile_id
            AND p.workspace_id = $3
         RETURNING ${RULE_COLS}`,
        [
          input.ruleId,
          input.profileId,
          input.workspaceId,
          input.rule.ruleOrder ?? 0,
          input.rule.filterType,
          JSON.stringify(input.rule.filterParams ?? {}),
          input.rule.routingMode,
          input.rule.routingSchedule ?? null,
          input.rule.routingTimezone ?? 'UTC',
          input.rule.episodeSensitivity ?? null,
          input.rule.compartments ?? [],
          input.rule.projectIds ?? [],
        ],
      )
      const row = result.rows[0]
      return row ? { ...row, compartments: row.compartments ?? [], projectIds: row.projectIds ?? [] } : null
    },

    async deleteRule(input) {
      const result = await queryWithRLS(
        input.actingUserId,
        `DELETE FROM ingest_rules r
          USING programmatic_capture_profiles p
          WHERE r.id = $1 AND r.capture_profile_id = $2
            AND p.id = r.capture_profile_id AND p.workspace_id = $3`,
        [input.ruleId, input.profileId, input.workspaceId],
      )
      return (result.rowCount ?? 0) > 0
    },

    async setAssistantProfile(input) {
      const result = await queryWithRLS<{ id: string }>(
        input.actingUserId,
        `UPDATE assistants a
            SET capture_profile_id = $3, updated_at = now()
          WHERE a.id = $1 AND a.workspace_id = $2
            AND (
              $3::uuid IS NULL
              OR EXISTS (
                SELECT 1 FROM programmatic_capture_profiles p
                 WHERE p.id = $3 AND p.workspace_id = $2
              )
            )
          RETURNING a.id`,
        [input.assistantId, input.workspaceId, input.profileId],
      )
      return result.rows.length > 0
    },

    async resolveTargetSystem(input) {
      if (!input.assistantId) return null
      type TargetRow = Omit<ProgrammaticCaptureTarget, 'rules'>
      const result = await query<TargetRow>(
        `SELECT a.workspace_id AS "workspaceId",
                w.owner_user_id AS "ownerUserId",
                a.id AS "assistantId",
                a.name AS "assistantName",
                a.clearance AS "assistantClearance",
                a.default_compartments AS "assistantDefaultCompartments",
                a.default_project_id AS "assistantDefaultProjectId",
                p.id AS "profileId",
                p.name AS "profileName",
                p.partition_by AS "partitionBy"
           FROM workspaces w
           JOIN assistants a ON a.workspace_id = w.id AND a.id = $1
           JOIN programmatic_capture_profiles p
             ON p.id = COALESCE($3::uuid, a.capture_profile_id)
            AND p.workspace_id = a.workspace_id
            AND p.enabled = true
          WHERE w.id = $2
          LIMIT 1`,
        [input.assistantId, input.workspaceId, input.overrideProfileId],
      )
      const target = result.rows[0]
      if (!target) return null
      const rules = await query<ProgrammaticCaptureRule>(
        `SELECT ${RULE_COLS}
           FROM ingest_rules
          WHERE capture_profile_id = $1 AND source = 'programmatic'
          ORDER BY rule_order ASC, id ASC`,
        [target.profileId],
      )
      return {
        ...target,
        assistantDefaultCompartments: target.assistantDefaultCompartments ?? [],
        rules: rules.rows.map((rule) => ({
          ...rule,
          compartments: rule.compartments ?? [],
          projectIds: rule.projectIds ?? [],
        })),
      }
    },

    async resolveBatchTargetSystem(workspaceId, assistantId, ruleId) {
      const result = await query<ProgrammaticCaptureBatchTarget>(
        `SELECT a.workspace_id AS "workspaceId",
                w.owner_user_id AS "ownerUserId",
                a.id AS "assistantId",
                a.name AS "assistantName",
                a.clearance AS "assistantClearance",
                a.default_compartments AS "assistantDefaultCompartments",
                a.default_project_id AS "assistantDefaultProjectId",
                p.id AS "profileId",
                p.name AS "profileName"
           FROM assistants a
           JOIN workspaces w ON w.id = a.workspace_id
           JOIN ingest_rules r ON r.id = $3 AND r.source = 'programmatic'
           JOIN programmatic_capture_profiles p
             ON p.id = r.capture_profile_id AND p.workspace_id = a.workspace_id
          WHERE a.workspace_id = $1 AND a.id = $2
          LIMIT 1`,
        [workspaceId, assistantId, ruleId],
      )
      const target = result.rows[0]
      return target
        ? { ...target, assistantDefaultCompartments: target.assistantDefaultCompartments ?? [] }
        : null
    },
  }
}
