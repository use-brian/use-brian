/**
 * Logic-blocks (R2-5/R2-9/R2-10): executable CODE artifacts in brain — Python
 * driving the governed runner — plus the ports the send-gate consults:
 *
 *  - `BrowserSkillStore` — the block artifact itself (open table
 *    `browser_skills`, migration 319): code + effect contract + recording,
 *    versioned, site-scoped + identity-agnostic.
 *  - `BrowserSkillGrantStore` — block+profile standing grants (R2-2; closed
 *    table, the platform impl arrives with the grants phase). A satisfied
 *    grant auto-approves a terminal send; drift voids it.
 *  - `BlockApprovalsPort` — the async `pending_approvals` bridge: un-granted
 *    sends queue (kind `browser_skill_send`), grant auto-approvals still
 *    write an `auto_approved` AUDIT row (auto ≠ invisible).
 */
import type { BrowserSkillContract } from './effect-contract.js'

// ── The block artifact ─────────────────────────────────────────

export type BrowserSkillOrigin = 'self_heal' | 'assistant' | 'external'

/** One step of the authoring recording — the storyboard reviewers see (R2-5). */
export type BrowserSkillRecordingStep = {
  step: number
  action: string
  url?: string | null
  detail?: string | null
}

export type BrowserSkill = {
  id: string
  workspaceId: string
  name: string
  /** Registrable domain the block drives (site-scoped, R2-10). */
  site: string
  description: string
  /** Python driving `runner.*` verbs only. */
  code: string
  paramsSchema: Record<string, unknown>
  contract: BrowserSkillContract
  recording: BrowserSkillRecordingStep[]
  version: number
  origin: BrowserSkillOrigin
  createdBy: string | null
  status: 'active' | 'archived'
  createdAt: string
  updatedAt: string
}

export type CreateBrowserSkillParams = {
  workspaceId: string
  name: string
  site: string
  description?: string
  code: string
  paramsSchema?: Record<string, unknown>
  contract: BrowserSkillContract
  recording: BrowserSkillRecordingStep[]
  origin: BrowserSkillOrigin
  createdBy?: string | null
}

export interface BrowserSkillStore {
  get(id: string): Promise<BrowserSkill | null>
  getByName(params: { workspaceId: string; name: string }): Promise<BrowserSkill | null>
  list(params: { workspaceId: string; site?: string }): Promise<BrowserSkill[]>
  create(params: CreateBrowserSkillParams): Promise<BrowserSkill>
  /** Bumps `version`; code updates re-extract the contract at the call site. */
  update(
    id: string,
    patch: Partial<Pick<BrowserSkill, 'description' | 'code' | 'paramsSchema' | 'contract' | 'recording' | 'status'>>,
  ): Promise<BrowserSkill | null>
}

/** In-memory store for OSS boots and tests (the DB impl is `browser_skills`). */
export function createInMemoryBrowserSkillStore(): BrowserSkillStore & {
  skills: Map<string, BrowserSkill>
} {
  const skills = new Map<string, BrowserSkill>()
  let counter = 0
  return {
    skills,
    async get(id) {
      return skills.get(id) ?? null
    },
    async getByName({ workspaceId, name }) {
      for (const s of skills.values()) {
        if (s.workspaceId === workspaceId && s.name === name) return s
      }
      return null
    },
    async list({ workspaceId, site }) {
      return [...skills.values()].filter(
        (s) => s.workspaceId === workspaceId && (!site || s.site === site),
      )
    },
    async create(params) {
      const now = new Date().toISOString()
      const skill: BrowserSkill = {
        id: `skill-${++counter}`,
        workspaceId: params.workspaceId,
        name: params.name,
        site: params.site,
        description: params.description ?? '',
        code: params.code,
        paramsSchema: params.paramsSchema ?? {},
        contract: params.contract,
        recording: params.recording,
        version: 1,
        origin: params.origin,
        createdBy: params.createdBy ?? null,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      }
      skills.set(skill.id, skill)
      return skill
    },
    async update(id, patch) {
      const existing = skills.get(id)
      if (!existing) return null
      const next: BrowserSkill = {
        ...existing,
        ...patch,
        version: existing.version + 1,
        updatedAt: new Date().toISOString(),
      }
      skills.set(id, next)
      return next
    },
  }
}

// ── Block-scoped grants (R2-2) ─────────────────────────────────

export type BrowserSkillGrant = {
  id: string
  workspaceId: string
  skillId: string
  profileId: string
  grantedBy: string
  /** Per-grant spend ceiling; null = the task budget alone bounds it. */
  budgetUsd: number | null
  /** Rate ceiling: auto-approved sends per hour; null = unlimited. */
  ratePerHour: number | null
  spentUsd: number
  expiresAt: string | null
  status: 'active' | 'revoked' | 'voided'
  createdAt: string
  lastUsedAt: string | null
}

export interface BrowserSkillGrantStore {
  /** The gate's lookup: the ACTIVE, unexpired grant for this block+profile. */
  findActive(params: {
    workspaceId: string
    skillId: string
    profileId: string
  }): Promise<BrowserSkillGrant | null>
  /**
   * Count one auto-approved use against the grant's ceilings. `withinRate`
   * false → the gate treats the send as un-granted (queues it) without
   * voiding the grant.
   */
  recordUse(id: string, params?: { costUsd?: number }): Promise<{ withinBudget: boolean; withinRate: boolean }>
  /** Drift voids the grant (R2-2): the block deviated, the review is stale. */
  void(id: string, reason: string): Promise<void>
  create(params: {
    workspaceId: string
    skillId: string
    profileId: string
    grantedBy: string
    budgetUsd?: number | null
    ratePerHour?: number | null
    expiresAt?: string | null
  }): Promise<BrowserSkillGrant>
  list(params: { workspaceId: string; profileId?: string }): Promise<BrowserSkillGrant[]>
  revoke(id: string): Promise<void>
}

/** In-memory grants for OSS/tests (the platform impl is `browser_skill_grants`). */
export function createInMemoryBrowserSkillGrantStore(opts?: {
  now?: () => number
}): BrowserSkillGrantStore & { grants: Map<string, BrowserSkillGrant & { usesLastHour: number[] }> } {
  const now = opts?.now ?? Date.now
  const grants = new Map<string, BrowserSkillGrant & { usesLastHour: number[] }>()
  let counter = 0
  return {
    grants,
    async findActive({ workspaceId, skillId, profileId }) {
      for (const g of grants.values()) {
        if (
          g.workspaceId === workspaceId &&
          g.skillId === skillId &&
          g.profileId === profileId &&
          g.status === 'active' &&
          (!g.expiresAt || Date.parse(g.expiresAt) > now())
        ) {
          return g
        }
      }
      return null
    },
    async recordUse(id, params) {
      const g = grants.get(id)
      if (!g) return { withinBudget: false, withinRate: false }
      const hourAgo = now() - 3600_000
      g.usesLastHour = g.usesLastHour.filter((t) => t > hourAgo)
      g.usesLastHour.push(now())
      g.spentUsd += params?.costUsd ?? 0
      g.lastUsedAt = new Date(now()).toISOString()
      return {
        withinBudget: g.budgetUsd === null || g.spentUsd <= g.budgetUsd,
        withinRate: g.ratePerHour === null || g.usesLastHour.length <= g.ratePerHour,
      }
    },
    async void(id) {
      const g = grants.get(id)
      if (g) g.status = 'voided'
    },
    async create(params) {
      const grant: BrowserSkillGrant & { usesLastHour: number[] } = {
        id: `grant-${++counter}`,
        workspaceId: params.workspaceId,
        skillId: params.skillId,
        profileId: params.profileId,
        grantedBy: params.grantedBy,
        budgetUsd: params.budgetUsd ?? null,
        ratePerHour: params.ratePerHour ?? null,
        spentUsd: 0,
        expiresAt: params.expiresAt ?? null,
        status: 'active',
        createdAt: new Date(now()).toISOString(),
        lastUsedAt: null,
        usesLastHour: [],
      }
      grants.set(grant.id, grant)
      return grant
    },
    async list({ workspaceId, profileId }) {
      return [...grants.values()].filter(
        (g) => g.workspaceId === workspaceId && (!profileId || g.profileId === profileId),
      )
    },
    async revoke(id) {
      const g = grants.get(id)
      if (g) g.status = 'revoked'
    },
  }
}

// ── The async approvals bridge ─────────────────────────────────

export type BlockApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'superseded'
  | 'auto_approved'

export type BlockSendApprovalPayload = {
  skillId: string
  skillName: string
  profileId: string
  profileName: string
  site: string
  ref?: string | null
  label?: string | null
  description?: string | null
  /** Verb-ceiling hit — never grant-satisfiable (R2-1). */
  ceiling?: string | null
  /** Drift that re-gated (and voided) a granted send (R2-2). */
  drift?: string | null
  contractSummary?: string
}

export interface BlockApprovalsPort {
  /** Queue an un-granted terminal send (kind `browser_skill_send`). */
  createSendApproval(params: {
    workspaceId: string
    approverUserId: string
    sessionId?: string | null
    payload: BlockSendApprovalPayload
    expiresAt?: string | null
  }): Promise<{ id: string }>
  getStatus(id: string): Promise<BlockApprovalStatus | null>
  expire(id: string): Promise<void>
  /** The R2-2 audit row for a grant auto-approval — auto ≠ invisible. */
  recordAutoApproved(params: {
    workspaceId: string
    approverUserId: string
    sessionId?: string | null
    grantId: string
    payload: BlockSendApprovalPayload
  }): Promise<void>
}

/** In-memory approvals bridge for OSS/tests. */
export function createInMemoryBlockApprovals(): BlockApprovalsPort & {
  rows: Map<
    string,
    { status: BlockApprovalStatus; payload: BlockSendApprovalPayload; grantId?: string }
  >
  respond(id: string, status: 'approved' | 'rejected'): void
} {
  const rows = new Map<
    string,
    { status: BlockApprovalStatus; payload: BlockSendApprovalPayload; grantId?: string }
  >()
  let counter = 0
  return {
    rows,
    respond(id, status) {
      const row = rows.get(id)
      if (row && row.status === 'pending') row.status = status
    },
    async createSendApproval({ payload }) {
      const id = `approval-${++counter}`
      rows.set(id, { status: 'pending', payload })
      return { id }
    },
    async getStatus(id) {
      return rows.get(id)?.status ?? null
    },
    async expire(id) {
      const row = rows.get(id)
      if (row && row.status === 'pending') row.status = 'expired'
    },
    async recordAutoApproved({ grantId, payload }) {
      rows.set(`audit-${++counter}`, { status: 'auto_approved', payload, grantId })
    },
  }
}
