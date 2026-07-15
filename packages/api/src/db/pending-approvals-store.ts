/**
 * Pending approvals store — workflow `tool_call` ask-policy gate.
 *
 * Detached pattern (Phase C, Q4 §12): a row lives until approve / reject /
 * explicit expiry. No 5-minute channel-bound timeout. Web UI is always a
 * valid response surface in addition to the chosen delivery channel.
 *
 * See migration 117 + docs/architecture/features/workflow.md.
 *
 * [COMP:api/pending-approvals-store]
 */

import { query, queryWithRLS } from './client.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'

export type PendingApprovalStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'superseded'
  /**
   * R2-2 audit rows (mig 319): a browser-skill grant auto-approved the send.
   * Never a *pending* state — rows are born `auto_approved` with
   * `responded_at` stamped, so the queue UI shows them as history, not work.
   */
  | 'auto_approved'

export type ApprovalDeliveryChannel = 'web' | 'telegram' | 'slack' | 'whatsapp'

/**
 * Application-enforced taxonomy for the `kind` column (mig 137).
 * The DB intentionally has no CHECK constraint — future kinds are additive
 * without a migration. This union is the canonical source.
 */
export type ApprovalKind =
  | 'workflow_step'
  | 'tool_invocation'
  | 'staged_write'
  | 'distribution_draft'
  | 'staged_skill_creation'
  | 'staged_skill_update'
  | 'question'
  | 'browser_skill_send'
  | 'email_sender'

/**
 * Note on nullability of `workflowRunId`, `workflowStepRunId`, `toolName`,
 * `arguments`, `deliveryChannelType`: mig 137 relaxed these to nullable at
 * the DB level so non-workflow kinds (`tool_invocation`, `staged_write`, ...)
 * can omit them. They remain typed as non-null here because every existing
 * reader queries workflow-shaped rows where they're invariably set. When a
 * future reader pulls non-workflow kinds, narrow at the call site.
 */
export type PendingApproval = {
  id: string
  workspaceId: string
  workflowRunId: string
  workflowStepRunId: string
  toolName: string
  arguments: Record<string, unknown>
  approverUserId: string
  deliveryChannelType: ApprovalDeliveryChannel
  deliveryChannelId: string | null
  status: PendingApprovalStatus
  expiresAt: Date | null
  respondedAt: Date | null
  respondedBy: string | null
  rejectReason: string | null
  createdAt: Date
  /** Q10 unified surface — discriminator. Defaulted to 'workflow_step' for legacy rows. */
  kind: ApprovalKind
  /** Set when a chat-session is suspended awaiting this row (kind='tool_invocation'). Powers Path B resume (WU-6.4). */
  blockingSessionId: string | null
  /** Per-kind payload (description/displayLines for tool_invocation; richer shapes for other kinds). */
  approvalPayload: Record<string, unknown>
  /** Originating assistant for cross-assistant per-workspace queue filtering. */
  originatingAssistantId: string | null
  /** User's free-text answer for kind='question' rows. NULL until the user submits via POST /answer.
   *  Length-capped to 8000 chars at the DB. See docs/architecture/engine/askquestion-suspend-resume.md. */
  answerText: string | null
}

export type CreateApprovalParams = {
  workspaceId: string
  workflowRunId: string
  workflowStepRunId: string
  toolName: string
  arguments: Record<string, unknown>
  approverUserId: string
  deliveryChannelType: ApprovalDeliveryChannel
  deliveryChannelId?: string | null
  expiresAt?: Date | null
}

/**
 * Q10 unification — params for inserting a `kind='tool_invocation'` row when
 * a `requiresConfirmation` tool pauses (WU-6.3). The row coexists with the
 * in-memory ConfirmationResolver promise: the resolver wakes the executor on
 * fast-path resolve; the row enables the unified queue UI, audit, and
 * (under WU-6.4) restart-recovery via `blockingSessionId`.
 *
 * See docs/plans/company-brain/approvals.md → "Chat resume (Path A)".
 */
export type CreateToolInvocationParams = {
  workspaceId: string
  /** session.id — the suspended chat session. */
  blockingSessionId: string
  /** assistant.id — the assistant whose turn proposed the tool call. */
  originatingAssistantId: string
  approverUserId: string
  toolName: string
  arguments: Record<string, unknown>
  /** Description, displayLines, allowPersistentApproval — what the queue UI renders. */
  approvalPayload: {
    description?: string
    displayLines?: string[]
    allowPersistentApproval?: boolean
  }
  deliveryChannelType: ApprovalDeliveryChannel
  deliveryChannelId?: string | null
  expiresAt?: Date | null
}

/** Computer-use R2 (R2-5): a queued logic-block terminal send. */
export type CreateBrowserSkillSendParams = {
  workspaceId: string
  approverUserId: string
  /** The chat session the block run belongs to (context, not suspension). */
  sessionId?: string | null
  /** BlockSendApprovalPayload from core — skill/profile/site/ref/label/ceiling/drift. */
  payload: Record<string, unknown>
  expiresAt?: Date | null
}

/** Computer-use R2 (R2-2): the auto-approved audit row for a granted send. */
export type CreateBrowserSkillAuditParams = {
  workspaceId: string
  approverUserId: string
  sessionId?: string | null
  grantId: string
  payload: Record<string, unknown>
}

/**
 * Email channel (agentmail.md, D4) — the stranger-sender needs-you card.
 * `payload.channelIntegrationId` is what the approve action mutates (the
 * sender joins that integration's `config.allowedUserIds`).
 */
export type CreateEmailSenderCardParams = {
  workspaceId: string
  approverUserId: string
  originatingAssistantId: string | null
  payload: {
    /** The assistant inbox the stranger wrote to. */
    inboxAddress: string
    /** channel_integrations.id — the allowlist the approve action edits. */
    channelIntegrationId: string
    /** Lowercased sender address. */
    sender: string
    senderName: string | null
    subject: string | null
    /** Short body preview (truncated route-side). */
    preview: string | null
  }
}

const COLS = `
  id,
  workspace_id              AS "workspaceId",
  workflow_run_id           AS "workflowRunId",
  workflow_step_run_id      AS "workflowStepRunId",
  tool_name                 AS "toolName",
  arguments,
  approver_user_id          AS "approverUserId",
  delivery_channel_type     AS "deliveryChannelType",
  delivery_channel_id       AS "deliveryChannelId",
  status,
  expires_at                AS "expiresAt",
  responded_at              AS "respondedAt",
  responded_by              AS "respondedBy",
  reject_reason             AS "rejectReason",
  created_at                AS "createdAt",
  kind,
  blocking_session_id       AS "blockingSessionId",
  approval_payload          AS "approvalPayload",
  originating_assistant_id  AS "originatingAssistantId",
  answer_text               AS "answerText"
`

/**
 * V2 skill auto-generation — `kind='staged_skill_update'`. Inserted by the
 * background-review worker's `skill_manage` tool when the target skill is
 * user-authored / community-authored and a curator patch needs the
 * workspace owner's approval before it lands.
 *
 * The payload carries the proposed mutation as JSON; the
 * `/api/skills/approvals/:id/approve` endpoint applies the patch in a
 * single DB transaction. See `docs/architecture/engine/skill-system.md`
 * → "Approval routing — by skill authorship".
 */
export type CreateStagedSkillUpdateParams = {
  workspaceId: string
  /** workspace_skills.id of the target skill (UUID). */
  targetSkillId: string
  /** Proposed mutation. Exactly one of newContent / diff / addedFiles is
   *  meaningful per call but the shape is permissive so a single approval
   *  can carry a patch + an added file when the curator bundles them. */
  proposedPatch: {
    newContent?: string
    diff?: string
    addedFiles?: Array<{
      kind: 'reference' | 'template' | 'script'
      name: string
      content: string
      description?: string
    }>
  }
  /** Approver — defaults to the originating assistant's owner workspace
   *  primary admin; the route resolves this. The store accepts whatever
   *  the caller passes so tests can inject explicit IDs. */
  approverUserId: string
  /** Originating assistant from the worker context. */
  originatingAssistantId: string | null
}

/**
 * V2 skill auto-generation — `kind='staged_skill_creation'`. Used when the
 * curator drafts a brand-new umbrella; the `workspace_skills` row is only
 * created at approve time so a rejected proposal doesn't leave a half-built
 * row behind.
 */
export type CreateStagedSkillCreationParams = {
  workspaceId: string
  proposedUmbrella: {
    slug: string
    name: string
    description: string
    content: string
    supportFiles?: Array<{
      kind: 'reference' | 'template' | 'script'
      name: string
      content: string
      description?: string
    }>
  }
  approverUserId: string
  originatingAssistantId: string | null
  /**
   * Producer provenance (mig 308 workflow lifecycle). The session curator
   * omits both; the workflow-digest pass stamps `origin: 'workflow-digest'`
   * plus the retiring workflows the candidate was distilled from. Rides
   * `approval_payload` — additive, ignored by the approve path.
   */
  origin?: string
  sourceWorkflowIds?: string[]
}

/**
 * Agent-surface staged write — `kind='staged_write'` (the kind reserved as
 * plumbing by migration 137, now live). An Approve-band control-plane tool
 * call from an agent surface (brain MCP / assistant MCP / public-api chat)
 * lands here instead of executing; a human approves in the web Approvals
 * inbox and only then does the tool run. See
 * docs/architecture/integrations/agent-capability-surface.md §6.1 and
 * `packages/api/src/agent-surface/banding.ts`.
 */
export type CreateStagedWriteParams = {
  workspaceId: string
  /** The agent-toolset tool to execute on approval. */
  toolName: string
  /** Frozen tool input, re-validated against the tool schema at apply time. */
  toolInput: Record<string, unknown>
  approverUserId: string
  originatingAssistantId: string | null
  /** Which agent surface staged this write — rendered in the Approvals inbox. */
  surface: 'brain_mcp' | 'assistant_mcp' | 'public_api'
  /** The authenticating credential id (brain key / api key / oauth grant). */
  credentialId: string
  /** Human-readable origin, e.g. the key name — the §7.3.2 provenance stamp. */
  originLabel?: string
}

/**
 * askQuestion suspend-resume — params for inserting a `kind='question'` row
 * when the coordinator calls askQuestion as the sole tool and the chat
 * route has opted into suspend behavior. Workflow columns are NULL;
 * `tool_name='askQuestion'` carries the tool ident; `arguments` carries
 * the `{ question }` input the model proposed (same semantics as
 * tool_invocation — frozen at suspend time); `approval_payload` mirrors
 * the question into a stable shape the resume worker reads without
 * re-parsing the JSONB arguments.
 *
 * See docs/architecture/engine/askquestion-suspend-resume.md.
 */
export type CreateQuestionParams = {
  workspaceId: string
  blockingSessionId: string
  originatingAssistantId: string
  approverUserId: string
  /** The model's question text — surfaced verbatim to the user. */
  question: string
  /** The `toolUseId` of the suspended askQuestion call. The resume worker
   *  synthesizes a tool_result keyed by this id so the queryLoop pairing
   *  invariant holds when it re-enters at `session_resume_points.loop_step_index`. */
  toolUseId: string
  deliveryChannelType: ApprovalDeliveryChannel
  deliveryChannelId?: string | null
  /** Optional. Default policy: now + 24h (chat-route-side). NULL = never expire. */
  expiresAt?: Date | null
}

export type PendingApprovalsStore = {
  /** System-level write — caller is the workflow executor on pause. */
  create(params: CreateApprovalParams): Promise<PendingApproval>

  /**
   * System-level write — Q10 unification (WU-6.3). Inserts a
   * `kind='tool_invocation'` row when a `requiresConfirmation` tool pauses
   * in chat. Workflow columns are NULL; `approval_payload` carries the
   * queue-UI render data; `blocking_session_id` powers Path B resume.
   */
  createToolInvocation(params: CreateToolInvocationParams): Promise<PendingApproval>

  /**
   * V2 skill auto-generation — stage a curator patch against a user- or
   * community-authored skill. Returns the new row's id; the row's status
   * starts as `pending`.
   */
  createStagedSkillUpdate(params: CreateStagedSkillUpdateParams): Promise<PendingApproval>

  /**
   * V2 skill auto-generation — stage a curator-drafted new umbrella. The
   * `workspace_skills` row is NOT created here; it's inserted at approve
   * time by the route handler. Returns the new approval row.
   */
  createStagedSkillCreation(params: CreateStagedSkillCreationParams): Promise<PendingApproval>

  /**
   * Agent surface — stage an Approve-band control-plane write
   * (`kind='staged_write'`). The tool does NOT execute here; the unified
   * approvals route applies it on approve via the agent-surface staged-write
   * executor. System-level write (the caller is API-key authed).
   */
  createStagedWrite(params: CreateStagedWriteParams): Promise<PendingApproval>

  /**
   * askQuestion suspend-resume — System-level write. Inserts a
   * `kind='question'` row when the engine suspends a chat session awaiting
   * a user-typed answer. Workflow columns NULL; `tool_name='askQuestion'`;
   * `arguments = { question }`; `approval_payload = { question, toolUseId }`.
   *
   * The resume worker reads `tool_use_id` from the payload to synthesize a
   * matching tool_result on resume. See
   * docs/architecture/engine/askquestion-suspend-resume.md.
   */
  createQuestion(params: CreateQuestionParams): Promise<PendingApproval>

  /**
   * Computer-use R2 — queue a logic-block's terminal send
   * (`kind='browser_skill_send'`, R2-5). The block's host-side gate polls
   * this row (`getByIdSystem`) while the sandbox waits; the approvals route
   * offers Deny / Allow once / Allow always for this block+profile.
   */
  createBrowserSkillSend(params: CreateBrowserSkillSendParams): Promise<PendingApproval>

  /**
   * Computer-use R2 — the R2-2 AUDIT row for a grant auto-approval: born
   * `status='auto_approved'` with `responded_at` stamped. Auto-approve is
   * never invisible.
   */
  createBrowserSkillAudit(params: CreateBrowserSkillAuditParams): Promise<PendingApproval>

  /**
   * Email channel (agentmail.md, D4) — the "stranger mailed the assistant"
   * needs-you card (`kind='email_sender'`). Created by the webhook route when
   * a non-allowlisted sender's mail arrives (the mail itself files through
   * ingest; the card carries the "allowlist this sender" action). Deduped:
   * an existing pending card for the same inbox + sender is returned instead
   * of inserting a duplicate. System-level write (webhook is pre-auth).
   */
  createEmailSenderCard(params: CreateEmailSenderCardParams): Promise<PendingApproval>

  /**
   * Expire ONE pending row (the block runner's send-wait deadline). The
   * periodic `expireDue()` sweep also catches it; this makes the state flip
   * immediate so the queue never shows a send the sandbox stopped waiting on.
   */
  expireById(id: string): Promise<void>

  /**
   * Atomic answer — flips a `kind='question'` row from 'pending' to
   * 'approved', writes `answer_text`, stamps `responded_at` + `responded_by`.
   * Returns the updated row, or `null` if already non-pending (idempotency).
   * Caller (the /answer route) enqueues the session-resume job after a
   * successful flip.
   */
  recordAnswer(
    id: string,
    answerText: string,
    responderUserId: string,
  ): Promise<PendingApproval | null>

  /** RLS-gated — pending skill approvals (both kinds) for a workspace. */
  listSkillApprovals(userId: string, workspaceId: string): Promise<PendingApproval[]>

  /**
   * System read — newest pending `staged_skill_update` targeting a skill.
   * The dedupe gate for the curator: while a proposal for a skill sits
   * unresolved, a busy session would otherwise re-stage a near-identical
   * one every review tick until a human acts. See
   * `docs/architecture/engine/skill-system.md` → "Approval routing".
   */
  findPendingStagedSkillUpdate(
    workspaceId: string,
    targetSkillId: string,
  ): Promise<PendingApproval | null>

  /**
   * System read — newest pending `staged_skill_creation` proposing a slug.
   * Same dedupe gate as `findPendingStagedSkillUpdate`, keyed on the
   * proposed umbrella's slug.
   */
  findPendingStagedSkillCreation(
    workspaceId: string,
    slug: string,
  ): Promise<PendingApproval | null>

  /** RLS-gated — workspace members only. Used by web UI and route. */
  listPendingForWorkspace(userId: string, workspaceId: string): Promise<PendingApproval[]>

  /** RLS-gated — used by the workspace-pending-count badge. */
  countPendingForUser(userId: string): Promise<number>

  /** RLS-gated single-row lookup for the approve/reject route. */
  getById(userId: string, id: string): Promise<PendingApproval | null>

  /** System-level read for the executor's resume path. */
  getByIdSystem(id: string): Promise<PendingApproval | null>

  /**
   * Atomic respond — flips a pending row to approved/rejected and stamps
   * the responder. Returns the updated row, or `null` if the row was
   * already non-pending (idempotency: double-click on Approve/Reject is a
   * no-op the second time).
   */
  respond(
    id: string,
    decision: 'approved' | 'rejected',
    responderUserId: string,
    rejectReason?: string,
  ): Promise<PendingApproval | null>

  /**
   * Sweep: mark every row whose expires_at has elapsed as 'expired'.
   * Called periodically by the scheduling poll worker. Returns the rows
   * that flipped, so the caller can resume the parent runs into 'failed'.
   */
  expireDue(): Promise<PendingApproval[]>

  /**
   * askQuestion suspend-resume (Phase 5) — sweep ONLY `kind='question'`
   * rows past their TTL. Kept distinct from the catch-all `expireDue()`
   * because the post-expire actions differ: workflow rows fail their
   * parent step+run; question rows trigger a chat-resume so the user
   * gets a final "the question expired" synthesis turn. The two sweeps
   * race-safely because they target different kinds. See
   * docs/architecture/engine/askquestion-suspend-resume.md.
   */
  expireDueQuestions(): Promise<PendingApproval[]>

  // ── Wave 3 admin methods (ADM-A — Surface #2 cross-tenant approvals) ──
  // All four bypass RLS; the route layer is gated by `requireAdminKey`.
  // None of these returns `arguments` or the full `approval_payload` —
  // the detail view returns a `payloadSummary` shape with only safe keys
  // (description / displayLineCount / allowPersistentApproval). See
  // docs/plans/company-brain/admin-ui-revamp.md → "No reading message
  // bodies cross-tenant".

  /**
   * Admin cross-tenant list — bypasses RLS. Metadata-only (no message
   * bodies, no arguments — see `listForAdmin`'s row shape).
   *
   * Pagination is opaque-cursor on (createdAt, id) — the response carries
   * the next cursor if there are more rows.
   */
  listForAdmin(params: AdminListApprovalsParams): Promise<AdminListApprovalsResult>

  /**
   * Workspace ranking — cross-tenant queue depth + oldest pending.
   * Powers the top-of-page "which workspaces are stuck?" view.
   * One row per workspace with at least one pending approval, ordered by
   * pendingCount DESC, oldestPendingAt ASC.
   */
  rankWorkspacesForAdmin(opts?: { limit?: number; kind?: ApprovalKind }): Promise<AdminWorkspaceRankRow[]>

  /**
   * Admin single-row fetch — bypasses RLS, returns metadata only.
   * Used by the per-approval drill-in page. Argument values are NOT
   * returned (cross-tenant privacy boundary).
   */
  getByIdForAdmin(id: string): Promise<AdminApprovalDetail | null>

  /**
   * Force-expire a pending approval. Bypasses RLS. Returns the row that
   * flipped, or `null` if the approval was already non-pending. The route
   * is responsible for writing the audit `analytics_events` row on top of
   * this — the store stays pure.
   */
  forceExpireForAdmin(id: string): Promise<PendingApproval | null>
}

// ── Admin types ──────────────────────────────────────────────────

/** Cross-tenant list params. */
export type AdminListApprovalsParams = {
  workspaceId?: string
  kind?: ApprovalKind
  status?: PendingApprovalStatus
  /** Opaque cursor returned by the previous page. Decoded as `${createdAtIso}_${id}`. */
  cursor?: string
  limit?: number
}

/** A row in the admin list — metadata only (no arguments, no payload bodies). */
export type AdminApprovalRow = {
  id: string
  workspaceId: string
  kind: ApprovalKind
  status: PendingApprovalStatus
  toolName: string | null
  workflowRunId: string | null
  workflowStepRunId: string | null
  blockingSessionId: string | null
  originatingAssistantId: string | null
  approverUserId: string
  deliveryChannelType: ApprovalDeliveryChannel | null
  expiresAt: Date | null
  respondedAt: Date | null
  createdAt: Date
  /** Seconds between createdAt and now() (or respondedAt, if responded). */
  ageSeconds: number
}

export type AdminListApprovalsResult = {
  rows: AdminApprovalRow[]
  /** Next-page cursor; null when no more rows. */
  nextCursor: string | null
}

/** One row per workspace in the ranking card. */
export type AdminWorkspaceRankRow = {
  workspaceId: string
  pendingCount: number
  oldestPendingAt: Date
}

/** Detail view — same as AdminApprovalRow plus the per-kind payload metadata. */
export type AdminApprovalDetail = AdminApprovalRow & {
  /** Per-kind shallow payload — only safe keys (description / displayLines headers / allowPersistentApproval). */
  payloadSummary: {
    description: string | null
    displayLineCount: number
    allowPersistentApproval: boolean | null
  }
}

function rowToApproval(row: Record<string, unknown>): PendingApproval {
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    workflowRunId: row.workflowRunId as string,
    workflowStepRunId: row.workflowStepRunId as string,
    toolName: row.toolName as string,
    arguments: (row.arguments as Record<string, unknown>) ?? {},
    approverUserId: row.approverUserId as string,
    deliveryChannelType: row.deliveryChannelType as ApprovalDeliveryChannel,
    deliveryChannelId: (row.deliveryChannelId as string | null) ?? null,
    status: row.status as PendingApprovalStatus,
    expiresAt: (row.expiresAt as Date | null) ?? null,
    respondedAt: (row.respondedAt as Date | null) ?? null,
    respondedBy: (row.respondedBy as string | null) ?? null,
    rejectReason: (row.rejectReason as string | null) ?? null,
    createdAt: row.createdAt as Date,
    kind: (row.kind as ApprovalKind) ?? 'workflow_step',
    blockingSessionId: (row.blockingSessionId as string | null) ?? null,
    approvalPayload: (row.approvalPayload as Record<string, unknown>) ?? {},
    originatingAssistantId: (row.originatingAssistantId as string | null) ?? null,
    answerText: (row.answerText as string | null) ?? null,
  }
}

export function createPendingApprovalsStore(): PendingApprovalsStore {
  return {
    async create(params) {
      const result = await query(
        `INSERT INTO pending_approvals (
           workspace_id, workflow_run_id, workflow_step_run_id, tool_name,
           arguments, approver_user_id, delivery_channel_type,
           delivery_channel_id, expires_at
         )
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         RETURNING ${COLS}`,
        [
          params.workspaceId,
          params.workflowRunId,
          params.workflowStepRunId,
          params.toolName,
          JSON.stringify(params.arguments),
          params.approverUserId,
          params.deliveryChannelType,
          params.deliveryChannelId ?? null,
          params.expiresAt ?? null,
        ],
      )
      const approval = rowToApproval(result.rows[0] as Record<string, unknown>)
      notifyWorkspaceChange(approval.workspaceId, 'approval', 'create', approval.id)
      return approval
    },

    async createStagedSkillUpdate(params) {
      // `arguments` is the canonical place for the proposed mutation so the
      // unified-queue UI can render the diff without a special-case path
      // through `approval_payload`. Workflow columns are NULL; the
      // application enforces the kind taxonomy.
      const result = await query(
        `INSERT INTO pending_approvals (
           workspace_id, kind, approver_user_id, tool_name, arguments,
           approval_payload, delivery_channel_type, delivery_channel_id,
           originating_assistant_id, workflow_run_id, workflow_step_run_id,
           blocking_session_id, expires_at
         )
         VALUES ($1, 'staged_skill_update', $2, 'skill_manage', $3, $4,
                 'web', NULL, $5, NULL, NULL, NULL, NULL)
         RETURNING ${COLS}`,
        [
          params.workspaceId,
          params.approverUserId,
          JSON.stringify({
            targetSkillId: params.targetSkillId,
            patch: params.proposedPatch,
          }),
          JSON.stringify({
            kind: 'staged_skill_update',
            targetSkillId: params.targetSkillId,
            originatingAssistantId: params.originatingAssistantId,
          }),
          params.originatingAssistantId ?? null,
        ],
      )
      const approval = rowToApproval(result.rows[0] as Record<string, unknown>)
      notifyWorkspaceChange(approval.workspaceId, 'approval', 'create', approval.id)
      return approval
    },

    async createStagedSkillCreation(params) {
      const result = await query(
        `INSERT INTO pending_approvals (
           workspace_id, kind, approver_user_id, tool_name, arguments,
           approval_payload, delivery_channel_type, delivery_channel_id,
           originating_assistant_id, workflow_run_id, workflow_step_run_id,
           blocking_session_id, expires_at
         )
         VALUES ($1, 'staged_skill_creation', $2, 'skill_manage', $3, $4,
                 'web', NULL, $5, NULL, NULL, NULL, NULL)
         RETURNING ${COLS}`,
        [
          params.workspaceId,
          params.approverUserId,
          JSON.stringify({ umbrella: params.proposedUmbrella }),
          JSON.stringify({
            kind: 'staged_skill_creation',
            originatingAssistantId: params.originatingAssistantId,
            ...(params.origin ? { origin: params.origin } : {}),
            ...(params.sourceWorkflowIds?.length
              ? { sourceWorkflowIds: params.sourceWorkflowIds }
              : {}),
          }),
          params.originatingAssistantId ?? null,
        ],
      )
      const approval = rowToApproval(result.rows[0] as Record<string, unknown>)
      notifyWorkspaceChange(approval.workspaceId, 'approval', 'create', approval.id)
      return approval
    },

    async createStagedWrite(params) {
      const result = await query(
        `INSERT INTO pending_approvals (
           workspace_id, kind, approver_user_id, tool_name, arguments,
           approval_payload, delivery_channel_type, delivery_channel_id,
           originating_assistant_id, workflow_run_id, workflow_step_run_id,
           blocking_session_id, expires_at
         )
         VALUES ($1, 'staged_write', $2, $3, $4, $5,
                 'web', NULL, $6, NULL, NULL, NULL, NULL)
         RETURNING ${COLS}`,
        [
          params.workspaceId,
          params.approverUserId,
          params.toolName,
          JSON.stringify(params.toolInput),
          JSON.stringify({
            kind: 'staged_write',
            surface: params.surface,
            credentialId: params.credentialId,
            originLabel: params.originLabel ?? null,
            originatingAssistantId: params.originatingAssistantId,
          }),
          params.originatingAssistantId ?? null,
        ],
      )
      const approval = rowToApproval(result.rows[0] as Record<string, unknown>)
      notifyWorkspaceChange(approval.workspaceId, 'approval', 'create', approval.id)
      return approval
    },

    async createEmailSenderCard(params) {
      // Dedupe: one pending card per (workspace, inbox, sender). Repeat mail
      // from the same stranger returns the existing card instead of stacking.
      const existing = await query(
        `SELECT ${COLS} FROM pending_approvals
         WHERE workspace_id = $1
           AND kind = 'email_sender'
           AND status = 'pending'
           AND approval_payload->>'sender' = $2
           AND approval_payload->>'inboxAddress' = $3
         LIMIT 1`,
        [params.workspaceId, params.payload.sender, params.payload.inboxAddress],
      )
      if (existing.rows[0]) {
        return rowToApproval(existing.rows[0] as Record<string, unknown>)
      }
      const result = await query(
        `INSERT INTO pending_approvals (
           workspace_id, kind, approver_user_id, tool_name, arguments,
           approval_payload, delivery_channel_type, delivery_channel_id,
           originating_assistant_id, workflow_run_id, workflow_step_run_id,
           blocking_session_id, expires_at
         )
         VALUES ($1, 'email_sender', $2, 'emailSenderReview', $3, $4,
                 'web', NULL, $5, NULL, NULL, NULL, NULL)
         RETURNING ${COLS}`,
        [
          params.workspaceId,
          params.approverUserId,
          JSON.stringify({ sender: params.payload.sender }),
          JSON.stringify({ kind: 'email_sender', ...params.payload }),
          params.originatingAssistantId ?? null,
        ],
      )
      const approval = rowToApproval(result.rows[0] as Record<string, unknown>)
      notifyWorkspaceChange(approval.workspaceId, 'approval', 'create', approval.id)
      return approval
    },

    async listSkillApprovals(userId, workspaceId) {
      const result = await queryWithRLS(
        userId,
        `SELECT ${COLS} FROM pending_approvals
         WHERE workspace_id = $1
           AND kind IN ('staged_skill_update', 'staged_skill_creation')
           AND status = 'pending'
         ORDER BY created_at DESC`,
        [workspaceId],
      )
      return result.rows.map((r) => rowToApproval(r as Record<string, unknown>))
    },

    async findPendingStagedSkillUpdate(workspaceId, targetSkillId) {
      const result = await query(
        `SELECT ${COLS} FROM pending_approvals
         WHERE workspace_id = $1
           AND kind = 'staged_skill_update'
           AND status = 'pending'
           AND approval_payload->>'targetSkillId' = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [workspaceId, targetSkillId],
      )
      const row = result.rows[0]
      return row ? rowToApproval(row as Record<string, unknown>) : null
    },

    async findPendingStagedSkillCreation(workspaceId, slug) {
      const result = await query(
        `SELECT ${COLS} FROM pending_approvals
         WHERE workspace_id = $1
           AND kind = 'staged_skill_creation'
           AND status = 'pending'
           AND arguments->'umbrella'->>'slug' = $2
         ORDER BY created_at DESC
         LIMIT 1`,
        [workspaceId, slug],
      )
      const row = result.rows[0]
      return row ? rowToApproval(row as Record<string, unknown>) : null
    },

    async createToolInvocation(params) {
      // Strip undefined keys so JSONB queries stay symmetric — `{}` vs
      // `{description: undefined}` are different at the wire layer.
      const payload: Record<string, unknown> = {}
      if (params.approvalPayload.description !== undefined) {
        payload.description = params.approvalPayload.description
      }
      if (params.approvalPayload.displayLines !== undefined) {
        payload.displayLines = params.approvalPayload.displayLines
      }
      if (params.approvalPayload.allowPersistentApproval !== undefined) {
        payload.allowPersistentApproval = params.approvalPayload.allowPersistentApproval
      }

      const result = await query(
        `INSERT INTO pending_approvals (
           workspace_id, kind, blocking_session_id, originating_assistant_id,
           approver_user_id, tool_name, arguments, approval_payload,
           delivery_channel_type, delivery_channel_id, expires_at,
           workflow_run_id, workflow_step_run_id
         )
         VALUES ($1, 'tool_invocation', $2, $3, $4, $5, $6, $7, $8, $9, $10, NULL, NULL)
         RETURNING ${COLS}`,
        [
          params.workspaceId,
          params.blockingSessionId,
          params.originatingAssistantId,
          params.approverUserId,
          params.toolName,
          JSON.stringify(params.arguments),
          JSON.stringify(payload),
          params.deliveryChannelType,
          params.deliveryChannelId ?? null,
          params.expiresAt ?? null,
        ],
      )
      const approval = rowToApproval(result.rows[0] as Record<string, unknown>)
      notifyWorkspaceChange(approval.workspaceId, 'approval', 'create', approval.id)
      return approval
    },

    async createBrowserSkillSend(params) {
      const result = await query(
        `INSERT INTO pending_approvals (
           workspace_id, kind, blocking_session_id, approver_user_id,
           tool_name, arguments, approval_payload,
           delivery_channel_type, expires_at,
           workflow_run_id, workflow_step_run_id
         )
         VALUES ($1, 'browser_skill_send', $2, $3, 'runBrowserSkill', $4, $4, 'web', $5, NULL, NULL)
         RETURNING ${COLS}`,
        [
          params.workspaceId,
          params.sessionId ?? null,
          params.approverUserId,
          JSON.stringify(params.payload),
          params.expiresAt ?? null,
        ],
      )
      const approval = rowToApproval(result.rows[0] as Record<string, unknown>)
      notifyWorkspaceChange(approval.workspaceId, 'approval', 'create', approval.id)
      return approval
    },

    async createBrowserSkillAudit(params) {
      // Born auto_approved (R2-2): history, never work. responded_by is the
      // grant's beneficiary — the human whose standing grant fired.
      const result = await query(
        `INSERT INTO pending_approvals (
           workspace_id, kind, blocking_session_id, approver_user_id,
           tool_name, arguments, approval_payload,
           delivery_channel_type, status, responded_at, responded_by,
           workflow_run_id, workflow_step_run_id
         )
         VALUES ($1, 'browser_skill_send', $2, $3, 'runBrowserSkill', $4, $5, 'web', 'auto_approved', now(), $3, NULL, NULL)
         RETURNING ${COLS}`,
        [
          params.workspaceId,
          params.sessionId ?? null,
          params.approverUserId,
          JSON.stringify(params.payload),
          JSON.stringify({ ...params.payload, grantId: params.grantId }),
        ],
      )
      const approval = rowToApproval(result.rows[0] as Record<string, unknown>)
      notifyWorkspaceChange(approval.workspaceId, 'approval', 'create', approval.id)
      return approval
    },

    async expireById(id) {
      const result = await query(
        `UPDATE pending_approvals SET status = 'expired', responded_at = now()
          WHERE id = $1 AND status = 'pending'
          RETURNING workspace_id AS "workspaceId"`,
        [id],
      )
      const row = result.rows[0] as { workspaceId: string } | undefined
      if (row) notifyWorkspaceChange(row.workspaceId, 'approval', 'update', id)
    },

    async createQuestion(params) {
      // Store the question in BOTH `arguments` (so the resume worker's
      // synthesized tool_use carries the original input) and
      // `approval_payload` (so the queue UI + answer route can read it
      // without parsing arguments). `toolUseId` lives in payload only —
      // it's an engine ident, not a user-visible argument.
      const payload = {
        question: params.question,
        toolUseId: params.toolUseId,
      }
      const result = await query(
        `INSERT INTO pending_approvals (
           workspace_id, kind, blocking_session_id, originating_assistant_id,
           approver_user_id, tool_name, arguments, approval_payload,
           delivery_channel_type, delivery_channel_id, expires_at,
           workflow_run_id, workflow_step_run_id
         )
         VALUES ($1, 'question', $2, $3, $4, 'askQuestion', $5, $6, $7, $8, $9, NULL, NULL)
         RETURNING ${COLS}`,
        [
          params.workspaceId,
          params.blockingSessionId,
          params.originatingAssistantId,
          params.approverUserId,
          JSON.stringify({ question: params.question }),
          JSON.stringify(payload),
          params.deliveryChannelType,
          params.deliveryChannelId ?? null,
          params.expiresAt ?? null,
        ],
      )
      const approval = rowToApproval(result.rows[0] as Record<string, unknown>)
      notifyWorkspaceChange(approval.workspaceId, 'approval', 'create', approval.id)
      return approval
    },

    async recordAnswer(id, answerText, responderUserId) {
      // Atomic: only flip if pending AND kind='question'. The second guard
      // is paranoia — the route already checks kind, but a transient
      // double-submit on a stale UI shouldn't be able to mutate the wrong
      // approval row. Returns null on re-submit or non-pending.
      const result = await query(
        `UPDATE pending_approvals
         SET status = 'approved',
             responded_at = now(),
             responded_by = $3,
             answer_text = $2
         WHERE id = $1 AND status = 'pending' AND kind = 'question'
         RETURNING ${COLS}`,
        [id, answerText, responderUserId],
      )
      return result.rows[0] ? rowToApproval(result.rows[0] as Record<string, unknown>) : null
    },

    async listPendingForWorkspace(userId, workspaceId) {
      const result = await queryWithRLS(
        userId,
        `SELECT ${COLS} FROM pending_approvals
         WHERE workspace_id = $1 AND status = 'pending'
         ORDER BY created_at DESC`,
        [workspaceId],
      )
      return result.rows.map((r) => rowToApproval(r as Record<string, unknown>))
    },

    async countPendingForUser(userId) {
      const result = await queryWithRLS<{ count: string }>(
        userId,
        `SELECT COUNT(*)::text AS count FROM pending_approvals
         WHERE approver_user_id = $1 AND status = 'pending'`,
        [userId],
      )
      return parseInt(result.rows[0]?.count ?? '0', 10)
    },

    async getById(userId, id) {
      const result = await queryWithRLS(
        userId,
        `SELECT ${COLS} FROM pending_approvals WHERE id = $1`,
        [id],
      )
      return result.rows[0] ? rowToApproval(result.rows[0] as Record<string, unknown>) : null
    },

    async getByIdSystem(id) {
      const result = await query(
        `SELECT ${COLS} FROM pending_approvals WHERE id = $1`,
        [id],
      )
      return result.rows[0] ? rowToApproval(result.rows[0] as Record<string, unknown>) : null
    },

    async respond(id, decision, responderUserId, rejectReason) {
      // Atomic: only flip if currently pending. Returns null on second
      // call (idempotent under double-click) or expired/superseded rows.
      const result = await query(
        `UPDATE pending_approvals
         SET status = $2,
             responded_at = now(),
             responded_by = $3,
             reject_reason = $4
         WHERE id = $1 AND status = 'pending'
         RETURNING ${COLS}`,
        [id, decision, responderUserId, rejectReason ?? null],
      )
      if (!result.rows[0]) return null
      const responded = rowToApproval(result.rows[0] as Record<string, unknown>)
      notifyWorkspaceChange(responded.workspaceId, 'approval', 'update', responded.id)
      return responded
    },

    async expireDue() {
      const result = await query(
        `UPDATE pending_approvals
         SET status = 'expired', responded_at = now()
         WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= now()
         RETURNING ${COLS}`,
      )
      const expired = result.rows.map((r) => rowToApproval(r as Record<string, unknown>))
      // One signal per touched row; the coalescer folds same-workspace bursts.
      for (const row of expired) notifyWorkspaceChange(row.workspaceId, 'approval', 'update', row.id)
      return expired
    },

    async expireDueQuestions() {
      const result = await query(
        `UPDATE pending_approvals
         SET status = 'expired', responded_at = now()
         WHERE status = 'pending'
           AND kind = 'question'
           AND expires_at IS NOT NULL
           AND expires_at <= now()
         RETURNING ${COLS}`,
      )
      const expired = result.rows.map((r) => rowToApproval(r as Record<string, unknown>))
      for (const row of expired) notifyWorkspaceChange(row.workspaceId, 'approval', 'update', row.id)
      return expired
    },

    // ── Wave 3 admin methods (ADM-A) ────────────────────────────────────
    // All four bypass RLS (the route layer is gated by `requireAdminKey`).
    // The detail view returns a `payloadSummary` shape with only safe keys.

    async listForAdmin(params) {
      const limit = Math.min(Math.max(params.limit ?? 50, 1), 200)

      // Build the WHERE clause with positional params.
      const where: string[] = []
      const values: unknown[] = []
      let idx = 1
      if (params.workspaceId) {
        where.push(`workspace_id = $${idx++}`)
        values.push(params.workspaceId)
      }
      if (params.kind) {
        where.push(`kind = $${idx++}`)
        values.push(params.kind)
      }
      if (params.status) {
        where.push(`status = $${idx++}`)
        values.push(params.status)
      }
      // Default to pending if no status filter — the operator-cares-most slice.
      if (!params.status) {
        where.push(`status = 'pending'`)
      }

      // Opaque cursor: `${createdAtIso}_${id}` — strict-less keyset for
      // stable DESC ordering. Same shape we hand back as `nextCursor`.
      if (params.cursor) {
        const decoded = decodeCursor(params.cursor)
        if (decoded) {
          where.push(`(created_at, id) < ($${idx++}, $${idx++})`)
          values.push(decoded.createdAt, decoded.id)
        }
      }

      // Fetch limit+1 so we can detect "more pages" without a count query.
      values.push(limit + 1)
      const result = await query(
        `SELECT
           id,
           workspace_id              AS "workspaceId",
           kind,
           status,
           tool_name                 AS "toolName",
           workflow_run_id           AS "workflowRunId",
           workflow_step_run_id      AS "workflowStepRunId",
           blocking_session_id       AS "blockingSessionId",
           originating_assistant_id  AS "originatingAssistantId",
           approver_user_id          AS "approverUserId",
           delivery_channel_type     AS "deliveryChannelType",
           expires_at                AS "expiresAt",
           responded_at              AS "respondedAt",
           created_at                AS "createdAt"
         FROM pending_approvals
         ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
         ORDER BY created_at DESC, id DESC
         LIMIT $${idx}`,
        values,
      )

      const rows = result.rows.slice(0, limit).map((r) => rowToAdminRow(r as Record<string, unknown>))
      const hasMore = result.rows.length > limit
      const last = rows.length > 0 ? rows[rows.length - 1] : null
      const nextCursor = hasMore && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null

      return { rows, nextCursor }
    },

    async rankWorkspacesForAdmin(opts) {
      const limit = Math.min(Math.max(opts?.limit ?? 50, 1), 200)
      const values: unknown[] = []
      let where = `status = 'pending'`
      if (opts?.kind) {
        values.push(opts.kind)
        where += ` AND kind = $${values.length}`
      }
      values.push(limit)
      const result = await query<{
        workspaceId: string
        pendingCount: string
        oldestPendingAt: Date
      }>(
        `SELECT
           workspace_id        AS "workspaceId",
           COUNT(*)::text      AS "pendingCount",
           MIN(created_at)     AS "oldestPendingAt"
         FROM pending_approvals
         WHERE ${where}
         GROUP BY workspace_id
         ORDER BY COUNT(*) DESC, MIN(created_at) ASC
         LIMIT $${values.length}`,
        values,
      )
      return result.rows.map((r) => ({
        workspaceId: r.workspaceId,
        pendingCount: parseInt(r.pendingCount, 10),
        oldestPendingAt: r.oldestPendingAt,
      }))
    },

    async getByIdForAdmin(id) {
      const result = await query(
        `SELECT
           id,
           workspace_id              AS "workspaceId",
           kind,
           status,
           tool_name                 AS "toolName",
           workflow_run_id           AS "workflowRunId",
           workflow_step_run_id      AS "workflowStepRunId",
           blocking_session_id       AS "blockingSessionId",
           originating_assistant_id  AS "originatingAssistantId",
           approver_user_id          AS "approverUserId",
           delivery_channel_type     AS "deliveryChannelType",
           expires_at                AS "expiresAt",
           responded_at              AS "respondedAt",
           created_at                AS "createdAt",
           approval_payload          AS "approvalPayload"
         FROM pending_approvals WHERE id = $1`,
        [id],
      )
      if (!result.rows[0]) return null
      const row = result.rows[0] as Record<string, unknown>
      const base = rowToAdminRow(row)
      // Per-kind shallow payload extraction. Whole-payload is never
      // returned cross-tenant; the detail page only renders the safe
      // fields below.
      const payload = (row.approvalPayload as Record<string, unknown> | null) ?? {}
      const displayLines = Array.isArray(payload.displayLines) ? payload.displayLines : null
      return {
        ...base,
        payloadSummary: {
          description: typeof payload.description === 'string' ? payload.description : null,
          displayLineCount: displayLines ? displayLines.length : 0,
          allowPersistentApproval:
            typeof payload.allowPersistentApproval === 'boolean'
              ? payload.allowPersistentApproval
              : null,
        },
      }
    },

    async forceExpireForAdmin(id) {
      // Same atomic guard as `respond` — flips pending → expired exactly
      // once. A double-click returns null. The caller is responsible for
      // emitting the audit analytics event after a successful flip.
      const result = await query(
        `UPDATE pending_approvals
         SET status = 'expired',
             responded_at = now()
         WHERE id = $1 AND status = 'pending'
         RETURNING ${COLS}`,
        [id],
      )
      return result.rows[0] ? rowToApproval(result.rows[0] as Record<string, unknown>) : null
    },
  }
}

// ── Admin row mapping + cursor helpers (Wave 3 / ADM-A) ──────────────

function rowToAdminRow(row: Record<string, unknown>): AdminApprovalRow {
  const createdAt = row.createdAt as Date
  const respondedAt = (row.respondedAt as Date | null) ?? null
  const endTimeMs = respondedAt ? respondedAt.getTime() : Date.now()
  const ageSeconds = Math.max(0, Math.floor((endTimeMs - createdAt.getTime()) / 1000))
  return {
    id: row.id as string,
    workspaceId: row.workspaceId as string,
    kind: (row.kind as ApprovalKind) ?? 'workflow_step',
    status: row.status as PendingApprovalStatus,
    toolName: (row.toolName as string | null) ?? null,
    workflowRunId: (row.workflowRunId as string | null) ?? null,
    workflowStepRunId: (row.workflowStepRunId as string | null) ?? null,
    blockingSessionId: (row.blockingSessionId as string | null) ?? null,
    originatingAssistantId: (row.originatingAssistantId as string | null) ?? null,
    approverUserId: row.approverUserId as string,
    deliveryChannelType: (row.deliveryChannelType as ApprovalDeliveryChannel | null) ?? null,
    expiresAt: (row.expiresAt as Date | null) ?? null,
    respondedAt,
    createdAt,
    ageSeconds,
  }
}

/**
 * Encode the (createdAt, id) keyset cursor as URL-safe base64. Opaque to
 * callers — the API only round-trips it.
 */
export function encodeCursor(c: { createdAt: Date; id: string }): string {
  const raw = `${c.createdAt.toISOString()}_${c.id}`
  return Buffer.from(raw, 'utf8').toString('base64url')
}

/** Decode an opaque cursor; returns null on any parse failure. */
export function decodeCursor(cursor: string): { createdAt: Date; id: string } | null {
  try {
    const raw = Buffer.from(cursor, 'base64url').toString('utf8')
    const idx = raw.lastIndexOf('_')
    if (idx <= 0) return null
    const createdAtIso = raw.slice(0, idx)
    const id = raw.slice(idx + 1)
    const createdAt = new Date(createdAtIso)
    if (Number.isNaN(createdAt.getTime()) || id.length === 0) return null
    return { createdAt, id }
  } catch {
    return null
  }
}
