"use client";

/**
 * Inline "Space for AI" composer — the empty-line AI affordance, in place.
 *
 * Pressing Space on an empty paragraph (`ai-space-trigger.ts`) opens THIS box
 * at the caret instead of the bottom-right chat dock. The user types a prompt
 * right where the content will land; on send it seeds an anchored autoSend
 * turn (`requestChatSeed` → the corner `FloatingChat` runs it, collapsed) and
 * the generated blocks stream into the page AFTER the anchor block via
 * `docAnchorBlockId` → the chat route's "Insertion anchor" note → `patchPage
 * add { after }`. No new send/SSE pipeline — the box is a pure UI surface that
 * delegates to the one chat the shell already mounts.
 *
 * The box is compose-only: a textarea (Enter sends, Shift+Enter newlines) + the
 * shared model-tier picker / research toggle (`ComposerControls`) + a send
 * button. On send it fires the seed and calls `onSubmit` — the editor then
 * closes this box and shows the in-flow **"Generating…" widget** at the anchor
 * (`ai-generating-decoration.ts`), so the progress indicator sits in the
 * document body, not floating over it. Esc / click-outside cancels.
 *
 * `<ComposerControls>` + `useComposerControls` are reused verbatim so the
 * picker looks and behaves identically to the corner chat and shares the
 * persisted `doc-chat-model` tier.
 *
 * [COMP:app-web/inline-ai-prompt]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import { requestChatSeed, type ChatSeed } from "@/lib/chat-seed";
import type { ModelTier } from "@/lib/chat-model";
import {
  ComposerControls,
  useComposerControls,
} from "@/components/doc/composer-controls";
import { useAutoGrowTextarea } from "@/lib/use-auto-grow-textarea";
import { useT } from "@/lib/i18n/client";

/**
 * Assemble the chat-seed for an inline Space-for-AI submit. An autoSend turn
 * anchored to the page (`docViewId`, so the dock stays collapsed) and to the
 * line (`anchorBlockId`, so the generation lands after it). Pure so the anchor
 * wiring is unit-tested without mounting the box (app-web vitest is
 * node-only). The caller guarantees a non-empty trimmed prompt.
 */
export function buildInlineAiSeed(params: {
  prompt: string;
  viewId: string | null;
  anchorBlockId: string;
  model: ModelTier;
  researchMode: boolean;
}): ChatSeed {
  return {
    prefill: params.prompt.trim(),
    autoSend: true,
    ...(params.viewId ? { docViewId: params.viewId } : {}),
    anchorBlockId: params.anchorBlockId,
    model: params.model,
    researchMode: params.researchMode,
  };
}

export type InlineAiPromptProps = {
  workspaceId: string;
  /** The page the generation is anchored to (sent as `docViewId`). */
  viewId: string | null;
  /** The empty paragraph's blockId — the generation lands after it. */
  anchorBlockId: string;
  /**
   * Initial placement (viewport coords): `top` = the caret's bottom, `left` +
   * `width` span the editor's writing column (full-width, like a Notion inline
   * AI bar). Only the first paint — the box then re-measures the anchor block
   * itself so it sticks to the line through scroll + reflow.
   */
  position: { top: number; left: number; width: number };
  /** The prompt was sent — the editor closes the box + shows the in-flow
   *  "Generating…" widget at the anchor. */
  onSubmit: () => void;
  /** Cancel (Esc / click-outside) — close the box without sending. */
  onClose: () => void;
};

export function InlineAiPrompt({
  workspaceId,
  viewId,
  anchorBlockId,
  position,
  onSubmit,
  onClose,
}: InlineAiPromptProps) {
  const t = useT().docPage.inlineAi;
  const controls = useComposerControls(workspaceId);
  const [input, setInput] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Grow the prompt box line-by-line as the user types (Shift+Enter for a
  // newline), capped by `max-h-32`; past that the overflow scrolls.
  useAutoGrowTextarea(textareaRef, input);

  // Live box geometry. Seeded from the caret coords at open, then continuously
  // re-measured against the anchor block so the box STICKS TO THE LINE — it
  // scrolls with the page and tracks layout shifts while the user composes,
  // instead of freezing at one viewport spot.
  const [box, setBox] = useState(position);
  useEffect(() => {
    const measure = () => {
      const node = document.querySelector<HTMLElement>(
        `.ProseMirror [data-block-id="${CSS.escape(anchorBlockId)}"]`,
      );
      if (!node) return; // mid-churn — keep the last known position
      const line = node.getBoundingClientRect();
      const column = (node.closest(".ProseMirror") ?? node).getBoundingClientRect();
      setBox({ top: line.bottom + 6, left: column.left, width: column.width });
    };
    measure();
    // Capture-phase scroll catches whichever ancestor pane actually scrolls.
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [anchorBlockId]);

  // Autofocus the prompt on open.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Click-outside cancels. Clicks inside the model-picker's portal (rendered
  // outside this subtree) are preserved so opening the dropdown doesn't close
  // the box.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element | null;
      if (!target) return;
      if (
        target.closest("[data-radix-popper-content-wrapper]") ||
        target.closest("[data-base-ui-popup]") ||
        target.closest('[role="listbox"]') ||
        target.closest('[role="menu"]')
      ) {
        return;
      }
      if (!rootRef.current?.contains(target as Node)) onClose();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [onClose]);

  const submit = useCallback(() => {
    if (!input.trim()) return;
    // Delegate to the corner chat's single send pipeline, anchored to this
    // line. autoSend with a `docViewId` keeps the dock collapsed; the
    // construction streams onto the page body via Yjs.
    requestChatSeed(
      buildInlineAiSeed({
        prompt: input,
        viewId,
        anchorBlockId,
        model: controls.model,
        researchMode: controls.researchMode,
      }),
    );
    onSubmit();
  }, [input, viewId, anchorBlockId, controls.model, controls.researchMode, onSubmit]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      onClose();
    } else if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };

  return (
    <div
      ref={rootRef}
      data-inline-ai="root"
      // The editor's area-select gesture skips elements marked this way, so a
      // drag inside the box selects its own text instead of rubber-banding the
      // page beneath it (same guard the floating chat uses).
      data-area-select-ignore
      // Full-width bar spanning the editor's writing column, glued to the
      // anchor line (`box` re-measures on scroll/reflow). The focus ring lives
      // HERE (focus-within) — the whole box lights up as one surface, not a
      // stray highlight on the inner textarea.
      className="fixed z-50 overflow-hidden rounded-xl border border-border bg-popover text-sm shadow-lg transition-shadow focus-within:border-primary/50 focus-within:ring-2 focus-within:ring-primary/30"
      style={{ top: box.top, left: box.left, width: box.width }}
    >
      <div className="p-2">
        <div className="flex items-start gap-2">
          <Sparkles className="mt-2 size-4 shrink-0 text-primary" aria-hidden />
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            placeholder={t.placeholder}
            // No inner focus treatment — the outer box owns the focus ring.
            className="min-h-9 max-h-32 flex-1 resize-none overflow-y-auto border-0 bg-transparent px-1 py-1.5 text-sm text-foreground shadow-none outline-none focus:outline-none focus:ring-0 focus-visible:outline-none focus-visible:ring-0 placeholder:text-muted-foreground/60"
          />
          <button
            type="button"
            onClick={submit}
            disabled={!input.trim()}
            className="mt-0.5 shrink-0 rounded-md bg-primary px-3 py-2 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:pointer-events-none disabled:opacity-50"
          >
            {t.send}
          </button>
        </div>
        <ComposerControls
          model={controls.model}
          onModelChange={controls.setModel}
          plan={controls.plan}
          researchMode={controls.researchMode}
          onResearchModeChange={controls.setResearchMode}
          researchQuota={controls.researchQuota}
          researchExhausted={controls.researchExhausted}
          // The Space→AI box authors straight onto the page — a prime doc
          // research surface (now functional), so it carries the toggle too.
          showResearch
          selectSide="top"
          className="mt-1.5 px-1"
        />
      </div>
    </div>
  );
}
