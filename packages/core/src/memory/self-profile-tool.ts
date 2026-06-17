/**
 * `updateSelfProfile` chat tool — Identity Phase 2 groundwork.
 *
 * Writes user-self facts (name, role, location, birthday, etc.) to
 * the user's self entity instead of to a `type='preference'` memory
 * with `tags @> ['self-profile']`. Forward-only: existing self-profile
 * preferences continue to render in `## Identity`; new self-facts
 * captured via this tool live on the entity.
 *
 * Replaces the soft-deprecated `type:'identity'` `saveMemory` path
 * over time. The tool stays available in normal chat (not gated to
 * the inspection drawer); the model picks it up from its tool list
 * when capturing user-self facts becomes the right move.
 *
 * Spec: docs/architecture/brain/corrections.md.
 *
 * [COMP:brain/self-profile-tool]
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../tools/types.js'
import type { EntityLinksStore, EntityStore } from '../entities/types.js'
import {
  applyExplicitCloses,
  applyExplicitLinks,
  explicitClosesField,
  explicitLinksField,
  formatClosesSummary,
  formatLinksSummary,
} from '../entities/explicit-links.js'

const PROFILE_SCHEMA = z.object({
  // The model passes typed top-level fields. Anything not listed here
  // can ride on `extra` as a freeform JSONB blob — most user-self
  // facts will fit the named slots.
  name: z.string().optional().describe("User's display name."),
  role: z.string().optional().describe("User's professional role / title."),
  company: z.string().optional().describe("User's primary employer / company."),
  location: z.string().optional().describe("Where the user is based (city / region / country)."),
  birthday: z.string().optional().describe("User's birthday (ISO 8601 date preferred, free-text accepted)."),
  pronouns: z.string().optional().describe("User's pronouns."),
  extra: z
    .record(z.string(), z.unknown())
    .optional()
    .describe(
      'Free-form additional self-profile attributes. Use for facts ' +
        "that don't fit the named fields (e.g., licenses, " +
        'certifications, allergies). Keys land verbatim on the ' +
        "self entity's attributes JSONB.",
    ),
  sources: z
    .array(z.string().url())
    .optional()
    .describe(
      'Source URLs backing this update — used when the fact was ' +
        'verified through web research rather than stated by the user. ' +
        'Merged into the entity\'s `sources` attribute (array of unique ' +
        'URLs). Omit when the user stated the fact themselves. Always ' +
        'pass when the fact came from webSearch / urlReader / xSearch ' +
        'results so future turns can audit provenance.',
    ),
  links: explicitLinksField,
  closeLinks: explicitClosesField,
})

export function createSelfProfileTool(entityStore: EntityStore, entityLinks?: EntityLinksStore): Tool {
  return buildTool({
    name: 'updateSelfProfile',
    description:
      "Set or update facts about the USER themselves on their self " +
      'entity in the company brain — name, role, company, location, ' +
      'birthday, pronouns, or any other self-profile attribute. ' +
      'This is the primary anchor for everything you know about the ' +
      'user — strongly prefer it over loose `saveMemory` for any ' +
      "fact that fits one of the named slots, and use `extra` for " +
      "facts that don't. Two cases when to call: (a) the user " +
      'explicitly stated a fact about themselves, (b) you verified a ' +
      'fact through web research (webSearch / urlReader / xSearch) — ' +
      'in that case ALWAYS pass the source URLs in `sources` so ' +
      "future turns can audit where the claim came from. Don't " +
      'fabricate or guess; every attribute must trace to either a ' +
      'direct user statement or a cited source. Merges over existing ' +
      "attributes; pass only the fields you're updating. Empty / " +
      "null values are ignored — to clear a field, use the model's " +
      'normal correction flow rather than overwriting blindly.',
    inputSchema: PROFILE_SCHEMA,
    isReadOnly: false,
    isConcurrencySafe: true,
    async execute(input, context) {
      if (!context.workspaceId) {
        return {
          data:
            'updateSelfProfile requires workspace context. The user must be in a workspace; ' +
            'self-profile facts on personal assistants without a workspace go through saveMemory ' +
            "with tags=['self-profile'] as the Phase 1 holding pen.",
          isError: true,
        }
      }
      // Compose the attributes patch from the typed fields plus extras.
      // Drop empty / null / undefined values so a partial-update call
      // doesn't accidentally clear existing keys with empty strings.
      // `sources` is held back from the loop — it's an array field that
      // needs append-and-dedupe semantics, not the default JSONB overwrite.
      const incoming: Record<string, unknown> = {}
      const { extra, sources, links, closeLinks, ...rest } = input
      for (const [k, v] of Object.entries(rest)) {
        if (v !== undefined && v !== null && v !== '') incoming[k] = v
      }
      if (extra) {
        for (const [k, v] of Object.entries(extra)) {
          if (v !== undefined && v !== null && v !== '') incoming[k] = v
        }
      }

      const hasLinks = (links?.length ?? 0) > 0
      const hasCloses = (closeLinks?.length ?? 0) > 0
      if (Object.keys(incoming).length === 0 && !(sources && sources.length > 0) && !hasLinks && !hasCloses) {
        return {
          data: 'No attributes provided. Pass at least one field, link, or closeLink to update.',
          isError: true,
        }
      }

      // Resolve a display name for first-time materialisation. Prefer
      // an incoming `name`; fall back to a placeholder the user can
      // edit later.
      const displayName =
        typeof input.name === 'string' && input.name.trim().length > 0
          ? input.name.trim()
          : 'You'

      // Sources: append + dedupe against existing attributes.sources.
      // The store does JSONB `||` concatenation which overwrites top-level
      // keys — passing the merged array preserves prior research provenance.
      if (sources && sources.length > 0) {
        const current = await entityStore.getOrCreateSelf({
          userId: context.userId,
          workspaceId: context.workspaceId,
          displayName,
        })
        const existingSources = Array.isArray(current.attributes.sources)
          ? (current.attributes.sources as unknown[]).filter(
              (s): s is string => typeof s === 'string',
            )
          : []
        const merged = Array.from(new Set([...existingSources, ...sources]))
        incoming.sources = merged
      }

      try {
        // When the call is links-only, attribute payload is empty —
        // ensure the self entity exists before writing edges so we
        // have a stable entityId to anchor.
        const entity =
          Object.keys(incoming).length === 0
            ? await entityStore.getOrCreateSelf({
                userId: context.userId,
                workspaceId: context.workspaceId,
                displayName,
              })
            : await entityStore.updateSelfProfile({
                userId: context.userId,
                workspaceId: context.workspaceId,
                displayName,
                attributes: incoming,
              })
        const linksSummary = await applyExplicitLinks({
          entityLinks,
          workspaceId: context.workspaceId,
          userId: context.userId,
          assistantId: context.assistantId,
          sourceKind: 'entity',
          sourceId: entity.id,
          source: 'user',
          links,
        })
        const closesSummary = await applyExplicitCloses({
          entityLinks,
          userId: context.userId,
          sourceKind: 'entity',
          sourceId: entity.id,
          closes: closeLinks,
        })
        const updatedKeys = Object.keys(incoming).join(', ')
        const fieldsPart = updatedKeys.length > 0 ? ` (${updatedKeys})` : ''
        return {
          data: `Updated self-profile on entity ${entity.id.slice(0, 8)}${fieldsPart}${formatLinksSummary(linksSummary)}${formatClosesSummary(closesSummary)}.`,
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        return {
          data: `Could not update self-profile: ${msg}`,
          isError: true,
        }
      }
    },
  })
}
