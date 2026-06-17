/**
 * Brain entity-type colour palette — the single source of truth for the
 * graph nodes, the grouped/list leading dots, the legends, and the skills
 * library row dots. Every consumer reads from here (or the `--entity-*`
 * CSS tokens this mirrors) so the ten node kinds never drift across surfaces.
 *
 * ── Design: hue ENCODES nature, not just labels ──
 * The palette is laid out as a value chain around the hue wheel so that
 * "closer in nature ⇒ closer in colour". Two families sit on opposite arcs,
 * separated by the empty yellow-green and magenta buffers so they never bleed:
 *
 *   ACTORS (cool) ............................ ARTIFACTS (warm)
 *   knowledge → company → person → skill →  deal  → project → product → repository
 *    violet      blue     teal    green    jade    amber     orange    vermilion
 *    (what the team knows / who they are)  (the bridge)  (what they make)
 *
 * Read left-to-right it tracks identity → capability → opportunity → output:
 *   - company/person are the tight CRM pair (blue↔teal, adjacent).
 *   - skill is an attribute of a person, so it stays in the cool family — but a
 *     clear GREEN, ~50° off person's teal, not a near-twin shade of it.
 *   - deal is the money bridge (green = money) where actors become work; a
 *     deeper jade so the three green-band hues (teal/green/jade) stay separable.
 *   - product/repository are the tight output pair (orange↔vermilion); a repo
 *     is the most concrete artifact, so it runs hottest.
 * `connector` (integration plumbing) and `other` (uncategorised) are
 * deliberately DESATURATED steel/slate — they ring outside the saturated
 * semantic band so they never read as a first-class knowledge entity.
 *
 * The hexes below are the LIGHT-theme values, used pre-mount / under SSR as the
 * fallback for the `--entity-*` tokens. The live, theme-aware values (light AND
 * dark) live in `apps/app-web/src/app/globals.css` (`:root` / `.dark`); the
 * graph reads them at runtime via `getComputedStyle`. Keep the two in sync —
 * this map is the `:root` mirror, dark is CSS-only.
 */

import type { BrainGraphNodeKind } from "@/lib/api/brain";

export const BRAIN_ENTITY_COLORS: Record<BrainGraphNodeKind, string> = {
  // ── Actors (cool) ──
  knowledge: "#7C5CD9", // violet — intellectual / what the team knows
  company: "#3B6FE0", // blue — institution
  person: "#0E9FB2", // teal — human
  skill: "#2EA34F", // green — capability (clearly off person's teal)
  // ── Bridge ──
  deal: "#0E7C52", // jade — money / pipeline (actors → work); deeper than skill
  // ── Artifacts (warm) ──
  project: "#C7891B", // amber — effort in progress
  product: "#E06A24", // orange — tangible output
  repository: "#D83C2E", // vermilion — code, the most concrete artifact
  // ── Content / context (desaturated, secondary to the entity ring) ──
  memory: "#9D8FB8", // muted lavender — recalled context; knowledge's softer,
  //                    more ephemeral cousin (same mind-family hue, low chroma
  //                    so the memory cloud recedes behind the entities)
  // ── Infrastructure / neutral (desaturated, outside the semantic band) ──
  connector: "#5E7CA6", // steel — integration plumbing
  other: "#64748B", // slate — uncategorised
};

/**
 * Theme-aware colour for a brain node kind. Returns the `--entity-<kind>` CSS
 * token (which adapts to light/dark) with the light hex as the inline fallback,
 * so it is safe in inline styles before the stylesheet resolves.
 */
export function entityColorVar(kind: BrainGraphNodeKind): string {
  return `var(--entity-${kind}, ${BRAIN_ENTITY_COLORS[kind]})`;
}

/**
 * Vivid variant — the `.dark` entity palette: brighter hues tuned for the
 * graph's dark-mode canvas (see the `.dark --graph-entity-*` block in
 * `globals.css`, whose values this mirrors). Light mode's graph canvas uses
 * the standard `BRAIN_ENTITY_COLORS` set above. Keep all of them in sync.
 */
export const BRAIN_ENTITY_COLORS_VIVID: Record<BrainGraphNodeKind, string> = {
  knowledge: "#9B82F0",
  company: "#5B8BF5",
  person: "#22BACE",
  skill: "#4CC06A",
  deal: "#2BA177",
  project: "#E6A93C",
  product: "#F58A44",
  repository: "#F0584A",
  memory: "#B4A7CE",
  connector: "#84A0CC",
  other: "#94A0B2",
};
