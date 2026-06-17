/**
 * Tiny event bus for handing the user into the doc chat with a
 * pre-written prompt. Mirrors apps/web + apps/feed-web's `chat-seed`
 * pattern: a callsite deep in the tree (here, the default-viewer
 * landing's chatter) fires a one-shot CustomEvent; the chrome — the
 * `doc-shell` — subscribes, stamps a fresh nonce, and routes the seed
 * to whichever chat surface is actually visible at this viewport (the
 * desktop dock or the mobile drawer) so exactly one chat acts on it.
 *
 * Why an event instead of a shared ref: the chat is mounted by the shell
 * as chrome (a floating dock at `lg:`, a lazy drawer below), so a callsite
 * inside the centre pane would otherwise need a global context just to
 * talk to it. A one-shot CustomEvent keeps the coupling loose — anyone can
 * `requestChatSeed()`, only the shell subscribes.
 *
 * Doc extends the shared shape with `autoSend`: the landing's chatter
 * is itself a send affordance, so a prompt from there should mint the turn
 * immediately (the renderPage → new-draft + auto-navigate path) rather than
 * only prefilling the composer.
 */

import type { ModelTier } from "@/lib/chat-model";

export type ChatSeed = {
  /** Composer prefill text. Required — empty seeds are dropped. */
  prefill: string;
  /**
   * Send the prompt immediately instead of only prefilling the composer.
   * The landing's chatter uses this so "send" there means "build a page".
   */
  autoSend?: boolean;
  /** Model tier for this turn (the landing's picker). Overrides the chat's. */
  model?: ModelTier;
  /** Run this turn in research mode (the landing's toggle). */
  researchMode?: boolean;
  /**
   * Ready attachment ids staged on the seeding surface (the landing's file
   * picker / drop). Ride the autoSend turn as `/api/chat` `fileIds`, so a
   * page can be built from an uploaded file. `fileId`s are session-agnostic
   * on the read path, so they can be uploaded before the draft exists.
   */
  fileIds?: string[];
  /**
   * Anchor the turn to a specific doc page (sent as `docViewId`), so
   * the model edits THAT page via `patchPage` and the construction streams
   * onto its body — instead of minting an unrelated draft. The landing
   * pre-creates a draft, navigates to it, then seeds with its id. With this
   * set, `autoSend` keeps the corner chat collapsed: the page is the show.
   */
  docViewId?: string;
  /**
   * Empty-line "Space for AI" anchor. The block the inline AI box
   * (`inline-ai-prompt.tsx`) was opened on; it rides the autoSend turn as
   * `docAnchorBlockId` so the AI generates AFTER that line instead of at the
   * page end (the chat route injects an "Insertion anchor" note → `patchPage
   * add { after }`). Paired with `autoSend` + `docViewId`.
   */
  anchorBlockId?: string;
};

export const CHAT_SEED_EVENT = "doc:chat-seed";

/**
 * Ask the doc chat to apply the given seed. No-op on SSR. Returns
 * immediately — the shell handles routing + delivery on the next tick. An
 * empty `prefill` is dropped (every seed now carries prompt text, including
 * the inline Space-for-AI box, which seeds an `autoSend` turn on submit).
 */
export function requestChatSeed(seed: ChatSeed): void {
  if (typeof window === "undefined") return;
  if (!seed.prefill.trim()) return;
  window.dispatchEvent(new CustomEvent<ChatSeed>(CHAT_SEED_EVENT, { detail: seed }));
}
