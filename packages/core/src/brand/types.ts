/**
 * Brand primitive — store port and row shapes.
 *
 * Structural mirror of `packages/core/src/workspace-files/types.ts`: the core
 * package declares the interface, the API layer implements it against pg
 * (`packages/api/src/db/brand-store.ts`). Core stays DB-free so the digest
 * builder and the chat tools can be tested with a fake store.
 *
 * The record body itself is `BrandRecord` from `@use-brian/shared` — one Zod
 * schema for every writer (Studio form, chat tool, brain MCP, routes).
 *
 * Lifecycle (decision D4, mirroring Office template admission):
 *
 *   draft (mutable)  ──Approve──▶  immutable version N, active_version_id = N
 *        ▲                                         │
 *        └────────────── next edit ◀────────────────┘
 *
 * Assistant writes touch `draft` only. Approval is a Studio action by an
 * owner or admin. That split is what stops "the approved brand" from meaning
 * "whatever the model last wrote".
 *
 * Spec: docs/architecture/features/brand.md
 */

import type { BrandRecord } from '@use-brian/shared'

export const BRAND_SENSITIVITIES = ['public', 'internal', 'confidential'] as const
export type BrandSensitivity = (typeof BRAND_SENSITIVITIES)[number]

/**
 * Denormalized row state. `active` means an approved version is live;
 * `draft` means one has never been approved; `superseded` means the row was
 * active and has since been retired without a replacement. The authority is
 * `activeVersionId` — this is the convenience mirror the list view reads.
 */
export const BRAND_STATUSES = ['draft', 'active', 'superseded'] as const
export type BrandStatus = (typeof BRAND_STATUSES)[number]

/** Compact projection for list views and the Studio rail. */
export type BrandSummary = {
  id: string
  workspaceId: string
  slug: string
  name: string
  isDefault: boolean
  status: BrandStatus
  activeVersionId: string | null
  /** `version` of the active row, or null when never approved. */
  activeVersion: number | null
  /** Whether an unapproved draft is waiting. */
  hasDraft: boolean
  sensitivity: BrandSensitivity
  createdBy: string | null
  createdAt: Date
  updatedAt: Date
}

/** A brand with both bodies resolved — what the detail view and tools read. */
export type BrandDetail = BrandSummary & {
  /** The mutable working copy, or null when nothing is in flight. */
  draft: BrandRecord | null
  /** The live approved record, or null when never approved. */
  activeRecord: BrandRecord | null
}

export type BrandVersionSummary = {
  id: string
  brandId: string
  version: number
  approvedBy: string | null
  approvedAt: Date
}

export type BrandVersion = BrandVersionSummary & { record: BrandRecord }

/**
 * How a caller names a brand. All fields optional: an empty ref means "the
 * workspace default", which is what every v1 consumer wants (decision D5 —
 * multi-brand-shaped schema, single-brand UX).
 */
export type BrandRef = {
  id?: string
  slug?: string
}

export type BrandCreateInput = {
  /** Lowercase, hyphenated. Unique per workspace. */
  slug: string
  name: string
  /**
   * Make this the workspace default. The store demotes any existing default
   * in the same transaction, so the partial unique index cannot trip.
   * Defaults to true when the workspace has no brands yet.
   */
  isDefault?: boolean
  sensitivity?: BrandSensitivity
  /** Seed draft. Omitted → `emptyBrandRecord(name)`. */
  draft?: BrandRecord
}

/**
 * What an approval produced. `brand` carries the post-approval row (status
 * `active`, draft cleared); `version` is the immutable row that was inserted.
 */
export type BrandApproval = {
  brand: BrandDetail
  version: BrandVersion
}

export type BrandStore = {
  /** Every brand in the workspace, default first, then most recently updated. */
  list(userId: string, workspaceId: string): Promise<BrandSummary[]>

  /**
   * Resolve one brand. An empty `ref` returns the workspace default (or null
   * when the workspace has no brands). Returns null when the ref names
   * nothing the user can see.
   */
  get(userId: string, workspaceId: string, ref?: BrandRef): Promise<BrandDetail | null>

  create(userId: string, workspaceId: string, input: BrandCreateInput): Promise<BrandDetail>

  /**
   * Replace the draft body. The ONLY write an assistant can reach. Returns
   * null when the brand does not exist (or is not visible).
   */
  saveDraft(
    userId: string,
    workspaceId: string,
    brandId: string,
    record: BrandRecord,
  ): Promise<BrandDetail | null>

  /**
   * Approve the current draft, in ONE transaction: insert the next immutable
   * version, point `active_version_id` at it, clear the draft, set status
   * `active`. Returns null when the brand does not exist or has no draft to
   * approve — approving twice is a no-op, not a duplicate version.
   *
   * Role gating (owner/admin) lives in the route, not here: "who may
   * approve" is a question about the actor's role, which a row predicate
   * cannot express.
   */
  approve(
    userId: string,
    workspaceId: string,
    brandId: string,
    approverUserId: string,
  ): Promise<BrandApproval | null>

  /** Version history, newest first. Bodies omitted — use `getVersion`. */
  listVersions(
    userId: string,
    workspaceId: string,
    brandId: string,
  ): Promise<BrandVersionSummary[]>

  /** One historical version with its record body. */
  getVersion(
    userId: string,
    workspaceId: string,
    brandId: string,
    version: number,
  ): Promise<BrandVersion | null>
}
