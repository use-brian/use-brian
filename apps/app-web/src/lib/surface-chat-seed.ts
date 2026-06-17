/**
 * Surface-scoped chat seed bus (app-web).
 *
 * A surface (Brain / Studio / Workflow / …) hands the user into the ONE
 * hoisted assistant chat dock (`<FloatingChat>` mounted by `WorkspaceChrome`)
 * with a pre-written prompt and optional research flags. In apps/web the
 * equivalent targets the app-chrome `FloatingChat` (`requestChatSeed` over
 * `sidan:chat-seed`).
 *
 * Why a SECOND bus alongside `chat-seed.ts` (`doc:chat-seed`): a `doc:chat-seed`
 * seed means "build / edit the open page" (renderPage / patchPage / anchor
 * block) and rides the desktop-vs-mobile routing. A surface nudge means "open a
 * general conversation about X" — it prefills + (optionally) arms research, no
 * page anchoring. The dock listens to BOTH buses now that one unified dock
 * serves every surface (the surface-seed effect in floating-chat.tsx is no
 * longer origin-gated).
 *
 * This generalizes the former brain-only `brain-chat-seed.ts` (event
 * `doc:brain-chat-seed`) — any surface can seed the one shared dock. The brain
 * pristine-nudge CTAs still drive it; the `requestBrainChatSeed` alias is
 * preserved for those callsites.
 *
 * Spec: docs/architecture/features/doc.md → "One dock, every surface".
 *
 * [COMP:app-web/surface-chat-seed]
 */

export type SurfaceChatSeed = {
  /** Composer prefill text. Required — empty seeds are dropped. */
  prefill: string;
  /**
   * Run this turn in research mode (routes to the deep-research
   * coordinator + max-tier model — the brain ingestion pipeline).
   * Quota-gated server-side. Mutually exclusive with `deferResearch`;
   * if both are set, `researchMode` (this-turn) wins.
   */
  researchMode?: boolean;
  /**
   * Defer research mode to the *next* turn: the first turn sends in
   * standard mode (a cheap clarifying question like "which company?"),
   * then research auto-arms once the assistant replies — so the lifetime
   * research credit lands on the turn that actually researches. Used by
   * the brain "Research my company" nudge.
   */
  deferResearch?: boolean;
};

export const SURFACE_CHAT_SEED_EVENT = "doc:surface-chat-seed";

/**
 * Ask the shared surface chat dock to open and apply the given seed. No-op
 * on SSR. Returns immediately — the panel handles the rest on the next
 * tick. An empty `prefill` is dropped.
 */
export function requestSurfaceChatSeed(seed: SurfaceChatSeed): void {
  if (typeof window === "undefined") return;
  if (!seed.prefill.trim()) return;
  window.dispatchEvent(
    new CustomEvent<SurfaceChatSeed>(SURFACE_CHAT_SEED_EVENT, { detail: seed }),
  );
}

/**
 * Backwards-compatible alias for the brain pristine-nudge CTAs (and any
 * other former brain-bus callsite). The brain surface now shares the one
 * dock, so a brain seed is just a surface seed.
 */
export const requestBrainChatSeed = requestSurfaceChatSeed;
