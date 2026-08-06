/**
 * The two brand chat tools: `getBrand` (read) and `updateBrandDraft` (write).
 *
 * Both carry `requiresCapability: 'brand'`, so `filterToolsByCapabilities`
 * drops them before injection for an assistant whose owner has switched the
 * primitive off — the model never sees a tool it cannot use. The capability
 * name IS the connector id, which is what makes the Studio Built-in rail's
 * toggle load-bearing (see features/builtin-primitives.md).
 *
 * ## `updateBrandDraft` can never approve
 *
 * It writes `workspace_brands.draft` and nothing else. There is no approve
 * flag, no `activate` argument, and no code path from here to
 * `workspace_brand_versions`. That is the whole point of the two-table split:
 * an assistant proposes, a human with an owner or admin role approves in
 * Studio. A tool that could do both would make the gate a prompt convention
 * rather than a structural one.
 *
 * It is also `requiresConfirmation: true`, which does double duty. It puts an
 * Approve/Deny card in front of the user on interactive surfaces, and — via
 * the confirmation strip both surfaces already run — it keeps the tool off
 * the public API and off an un-deferred A2A consult, neither of which has a
 * human in the loop. Exposure therefore mirrors the KB write tools without a
 * second allow-list to keep in sync.
 *
 * Spec: docs/architecture/features/brand.md → "Tools"
 *
 * [COMP:brand/tools]
 */

import { z } from 'zod'
import {
  BRAND_RECORD_GROUPS,
  BrandRecordPatchSchema,
  BrandRecordSchema,
  mergeBrandRecordPatch,
  type BrandRecord,
  type BrandRecordGroup,
} from '@use-brian/shared'
import { buildTool, type Tool } from '../tools/types.js'
import type { BrandDetail, BrandStore } from './types.js'

export type BrandToolEvent =
  | { type: 'brand_read'; brandId: string | null; slug: string | null }
  | { type: 'brand_draft_updated'; brandId: string; slug: string; groups: string[] }

export type BrandToolEventContext = {
  userId: string
  assistantId: string
  sessionId: string
  channelType: string
}

export type BrandToolOptions = {
  /** Receives every primitive event with its tool context. Wire to analytics at boot. */
  onEvent?: (event: BrandToolEvent, ctx: BrandToolEventContext) => void
}

/**
 * Brands require a workspace by definition. Every tool returns an honest
 * error rather than a silent empty result when one is missing — mirrors the
 * `workspaceGate` in the file tools.
 */
function workspaceGate(
  workspaceId: string | null | undefined,
): { data: string; isError: true } | null {
  if (!workspaceId) {
    return {
      data: 'This assistant is not bound to a workspace, so it has no brand record.',
      isError: true,
    }
  }
  return null
}

const slugShape = z
  .string()
  .trim()
  .min(1)
  .max(63)
  .describe('Brand slug. Omit to use the workspace default brand, which is what almost every call wants.')

/** The record as the model sees it, plus the lifecycle facts it must not guess. */
function renderBrand(brand: BrandDetail, which: 'approved' | 'draft', record: BrandRecord) {
  return {
    id: brand.id,
    slug: brand.slug,
    name: brand.name,
    is_default: brand.isDefault,
    status: brand.status,
    /** Which body this is. The model must never present a draft as settled. */
    reading: which,
    approved_version: brand.activeVersion,
    has_unapproved_draft: brand.hasDraft,
    record,
  }
}

export function createBrandTools(
  store: BrandStore,
  opts?: BrandToolOptions,
): { getBrand: Tool; updateBrandDraft: Tool } {
  const eventCtx = (context: BrandToolEventContext): BrandToolEventContext => ({
    userId: context.userId,
    assistantId: context.assistantId,
    sessionId: context.sessionId,
    channelType: context.channelType,
  })

  const getBrand = buildTool({
    name: 'getBrand',
    requiresCapability: 'brand',
    isConcurrencySafe: true,
    isReadOnly: true,
    description:
      'Read this workspace\'s brand record: naming and legal usage, strategy, messaging and voice, color tokens, typography, logo variants, applications, claims, rights, governance, and provenance sources. ' +
      'The ambient brand summary in the system prompt covers writing rules only - call this whenever a decision needs a color value, a font, a logo binding, an approved claim, or a licence. ' +
      'Returns the APPROVED record by default. Pass `include_draft: true` to see unapproved changes as well; a draft is a proposal, never present it as what the company has settled on. ' +
      'Omit `slug` for the workspace default brand.',
    inputSchema: z.object({
      slug: slugShape.optional(),
      include_draft: z
        .boolean()
        .optional()
        .describe('Return the unapproved draft instead of the approved record, when one exists. Default false.'),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const brand = await store.get(context.userId, context.workspaceId!, input.slug ? { slug: input.slug } : undefined)
      opts?.onEvent?.(
        { type: 'brand_read', brandId: brand?.id ?? null, slug: brand?.slug ?? null },
        eventCtx(context),
      )
      if (!brand) {
        return {
          data: input.slug
            ? `No brand "${input.slug}" in this workspace.`
            : 'This workspace has no brand record yet. A workspace owner creates one in Studio; do not invent brand values.',
          isError: true,
        }
      }

      if (input.include_draft && brand.draft) {
        return { data: renderBrand(brand, 'draft', brand.draft) }
      }
      if (brand.activeRecord) {
        return { data: renderBrand(brand, 'approved', brand.activeRecord) }
      }
      if (brand.draft) {
        // Never approved. Say so plainly rather than handing back a draft that
        // reads like settled brand.
        return { data: renderBrand(brand, 'draft', brand.draft) }
      }
      return {
        data: `Brand "${brand.slug}" exists but has no record body yet.`,
        isError: true,
      }
    },
  })

  const updateBrandDraft = buildTool({
    name: 'updateBrandDraft',
    requiresCapability: 'brand',
    requiresConfirmation: true,
    description:
      'Propose a change to this workspace\'s brand record. The change lands in the DRAFT only - it does not take effect until a workspace owner or admin approves it in Studio, which creates a new approved version. You cannot approve; do not tell the user the brand has changed. ' +
      'Each field group you pass REPLACES that group whole - it is not merged field by field. To add one voice trait, call getBrand first and send the complete messaging group back with the new trait included. Groups you omit are left untouched. ' +
      `Groups: ${BRAND_RECORD_GROUPS.join(', ')}. ` +
      'Bind assets by workspace file id, never by path or filename. Do not invent color values, licences, or claims - record only what someone has actually decided.',
    inputSchema: z.object({
      slug: slugShape.optional(),
      changes: BrandRecordPatchSchema.describe(
        'The field groups to replace. At least one required. Same shape as the `record` returned by getBrand.',
      ),
      /** Free text the confirmation card shows the human who has to approve. */
      change_summary: z
        .string()
        .min(1)
        .max(500)
        .optional()
        .describe('One line describing what changed and why, shown to the person approving.'),
    }),

    async describeConfirmation(input) {
      const args = input as { slug?: string; changes?: Record<string, unknown>; change_summary?: string }
      const groups = Object.keys(args.changes ?? {}).filter((g) =>
        (BRAND_RECORD_GROUPS as readonly string[]).includes(g),
      )
      if (groups.length === 0) return null
      const lines = [
        `Update the ${args.slug ? `"${args.slug}"` : 'default'} brand DRAFT`,
        `Replaces in full: ${groups.join(', ')}`,
        'Stays a draft - it takes effect only when an owner or admin approves it in Studio.',
      ]
      if (args.change_summary) lines.push(`Change: ${args.change_summary}`)
      return lines
    },

    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const groups = (Object.keys(input.changes) as BrandRecordGroup[]).filter(
        (g) => input.changes[g] !== undefined,
      )
      if (groups.length === 0) {
        return {
          data: `No field groups supplied. Pass at least one of: ${BRAND_RECORD_GROUPS.join(', ')}.`,
          isError: true,
        }
      }

      const brand = await store.get(
        context.userId,
        context.workspaceId!,
        input.slug ? { slug: input.slug } : undefined,
      )
      if (!brand) {
        return {
          data: input.slug
            ? `No brand "${input.slug}" in this workspace.`
            : 'This workspace has no brand record yet. A workspace owner creates one in Studio before it can be edited.',
          isError: true,
        }
      }

      // The base is the draft in flight if there is one, otherwise the
      // approved record — which is exactly D4's "the next edit opens a new
      // draft". Patching the approved record directly would silently discard
      // a colleague's in-flight draft.
      const base = brand.draft ?? brand.activeRecord ?? null
      const merged = mergeBrandRecordPatch(base, input.changes)
      const parsed = BrandRecordSchema.safeParse(merged)
      if (!parsed.success) {
        // Validate the MERGED record, not the patch: a patch can be
        // individually valid and still leave the draft incoherent. Report
        // the field paths so the model can fix its own input rather than
        // retrying the same shape.
        const issues = parsed.error.issues
          .slice(0, 5)
          .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
          .join('; ')
        return {
          data: `The change would leave the brand record invalid and was not saved. ${issues}`,
          isError: true,
        }
      }

      const saved = await store.saveDraft(context.userId, context.workspaceId!, brand.id, parsed.data)
      if (!saved) {
        return { data: `Could not update the "${brand.slug}" brand draft.`, isError: true }
      }
      opts?.onEvent?.(
        { type: 'brand_draft_updated', brandId: saved.id, slug: saved.slug, groups },
        eventCtx(context),
      )
      return {
        data:
          `Updated the "${saved.slug}" brand DRAFT (replaced: ${groups.join(', ')}). ` +
          'It is not live yet - a workspace owner or admin approves it in Studio, which creates the next approved version.',
      }
    },
  })

  return { getBrand, updateBrandDraft }
}
