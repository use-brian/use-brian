/**
 * In-flow "Generating…" indicator for the inline Space-for-AI flow.
 *
 * When the user submits the inline AI box (`inline-ai-prompt.tsx`), the editor
 * activates this — a browser-only ProseMirror **widget decoration** placed
 * right after the anchor block, so the indicator sits IN the document flow (a
 * block that pushes content down) rather than floating over the page.
 *
 * It is no longer a static spinner: the same `/api/chat` turn the inline box
 * seeds streams reasoning + build steps over SSE, which `floating-chat` folds
 * into a chronological `BuildEvent[]` on the `build-activity` bus. This widget
 * subscribes to that bus and renders the **tail** of the log as a
 * height-capped, masked **rolling feed**: a fixed "Generating…" header with the
 * last few event lines below it (newest brightest, at the bottom), each new
 * line growing in from the bottom while the oldest rolls up under a top fade.
 * The height never grows past the cap — content below the indicator settles
 * once, then stays put as lines roll inside the fixed viewport. The feed paints
 * only while a turn `isStreaming`, so a stale prior-turn log never flashes.
 *
 * Like `doc-placeholder.ts` it contributes no nodes or marks and is toggled via
 * a **meta-only transaction**, so the byte-for-byte Yjs schema + sync are
 * untouched: the indicator is never persisted nor shared with collaborators —
 * a local view-only decoration that vanishes when the turn finishes.
 *
 * Toggle it from the editor (meta-only — never syncs to Yjs):
 *   editor.view.dispatch(editor.state.tr.setMeta(aiGeneratingKey, { blockId }))
 *   editor.view.dispatch(editor.state.tr.setMeta(aiGeneratingKey, { blockId: null }))
 *
 * `anchorWidgetPos` is exported pure for the node-only unit test.
 *
 * [COMP:app-web/ai-generating-decoration]
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import {
  subscribeBuildActivity,
  type BuildActivity,
} from "@/lib/build-activity";
import { windowEvents } from "@/lib/build-events";

type AiGeneratingState = { blockId: string | null };

/** Localized strings the widget needs (captured at install time per-locale). */
export type AiGeneratingLabels = {
  /** Header label, e.g. "Generating…". */
  generating: string;
  /** Prefix for a reasoning line, e.g. "Thinking" → "Thinking: …". */
  thinking: string;
};

/**
 * How many newest events the feed keeps in the DOM. The viewport shows ~4
 * lines; the oldest sits under the top fade mask, so the visible window is the
 * newest line plus 2-3 history lines — the height-cap the spec asks for.
 */
const FEED_MAX = 5;

export const aiGeneratingKey = new PluginKey<AiGeneratingState>(
  "docAiGenerating",
);

/**
 * Where the widget sits: just after the top-level block whose `blockId`
 * matches (so the indicator lands at the insertion point, above the streamed
 * content). Returns `null` when no block matches — mid-churn, or cleared — so
 * the decoration simply isn't painted.
 */
export function anchorWidgetPos(
  doc: PMNode,
  blockId: string | null,
): number | null {
  if (!blockId) return null;
  let pos: number | null = null;
  doc.descendants((node, p) => {
    if (pos !== null) return false;
    if (node.attrs?.blockId === blockId) {
      pos = p + node.nodeSize;
      return false;
    }
    return true;
  });
  return pos;
}

/**
 * Build the in-flow indicator (vanilla — widget decorations aren't React) and
 * wire it to the build-activity bus. Returns the root DOM plus a `destroy`
 * that unsubscribes; the widget spec's `destroy` calls it when the decoration
 * is removed (turn end) or the editor is torn down.
 */
function buildIndicator(labels: AiGeneratingLabels): {
  dom: HTMLElement;
  destroy: () => void;
} {
  const wrap = document.createElement("div");
  // Block-level so it reserves space in the flow. Tailwind classes are picked
  // up by the JIT scanner from these string literals.
  wrap.className =
    "doc-ai-generating my-2 rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-xs text-muted-foreground";
  wrap.contentEditable = "false";
  wrap.setAttribute("data-area-select-ignore", "");

  // Header — persistent spinner + "Generating…" label.
  const header = document.createElement("div");
  header.className = "flex items-center gap-2";
  const spinner = document.createElement("span");
  spinner.className =
    "size-3.5 shrink-0 animate-spin rounded-full border-2 border-primary/30 border-t-primary";
  spinner.setAttribute("aria-hidden", "true");
  const label = document.createElement("span");
  label.textContent = labels.generating;
  header.append(spinner, label);

  // Feed — fixed-height masked viewport; hidden until the first event arrives.
  const feed = document.createElement("div");
  feed.className = "doc-ai-feed";
  feed.setAttribute("role", "status");
  feed.setAttribute("aria-live", "polite");
  const list = document.createElement("div");
  list.className = "doc-ai-feed-list";
  feed.append(list);

  wrap.append(header, feed);

  // id → row element, so each bus update diffs (animate the new line in, drop
  // the line that rolled off) instead of rebuilding the list.
  const rowById = new Map<string, HTMLElement>();

  const lineText = (kind: string, text: string): string =>
    kind === "reasoning" ? `${labels.thinking}: ${text}` : text;

  function render(activity: BuildActivity): void {
    // Only paint while a turn is live — on mount the bus may still hold a
    // stale prior-turn log (isStreaming false); show the bare header until the
    // new turn starts streaming with a fresh (empty) log.
    if (!activity.isStreaming) {
      if (rowById.size > 0) {
        list.replaceChildren();
        rowById.clear();
      }
      feed.classList.remove("is-active");
      return;
    }

    const visible = windowEvents(activity.events, FEED_MAX);
    const visibleIds = new Set(visible.map((e) => e.id));

    // Drop rows that rolled out of the window (they sit under the top fade
    // mask, so the removal is not visible).
    for (const [id, el] of rowById) {
      if (!visibleIds.has(id)) {
        el.remove();
        rowById.delete(id);
      }
    }

    // Add new rows / update the advancing reasoning line, keeping DOM order
    // aligned with the window (oldest first, newest last).
    for (const ev of visible) {
      const text = lineText(ev.kind, ev.text);
      let el = rowById.get(ev.id);
      if (!el) {
        el = document.createElement("div");
        el.className = "doc-ai-feed-line";
        if (ev.kind === "reasoning") el.classList.add("is-reasoning");
        el.textContent = text;
        list.appendChild(el);
        rowById.set(ev.id, el);
      } else {
        if (el.textContent !== text) el.textContent = text;
        // Moving an existing node to the end keeps order without restarting
        // its CSS enter animation (only freshly-created nodes animate in).
        list.appendChild(el);
      }
    }

    // Brighten the newest (bottom) line; dim the history above it.
    const newestId =
      visible.length > 0 ? visible[visible.length - 1]!.id : null;
    for (const [id, el] of rowById) {
      el.classList.toggle("is-newest", id === newestId);
    }
    feed.classList.toggle("is-active", visible.length > 0);
  }

  let everConnected = false;
  let unsubscribe: () => void = () => {};
  unsubscribe = subscribeBuildActivity((activity) => {
    // Self-heal if `destroy` somehow didn't fire (e.g. an odd redraw): once
    // we've been in the DOM, a disconnected node means the widget is gone.
    if (wrap.isConnected) everConnected = true;
    else if (everConnected) {
      unsubscribe();
      return;
    }
    render(activity);
  });

  return { dom: wrap, destroy: () => unsubscribe() };
}

/**
 * Build the extension. `labels` is captured per-locale at install time (the
 * editor rebuilds its extension set on locale change), matching how
 * `createDocPlaceholderExtension` takes its strings.
 */
export function createAiGeneratingExtension(labels: AiGeneratingLabels) {
  return Extension.create({
    name: "docAiGenerating",
    addProseMirrorPlugins() {
      return [
        new Plugin<AiGeneratingState>({
          key: aiGeneratingKey,
          state: {
            init: () => ({ blockId: null }),
            apply(tr, value) {
              const meta = tr.getMeta(aiGeneratingKey) as
                | AiGeneratingState
                | undefined;
              return meta ?? value;
            },
          },
          props: {
            decorations(state) {
              const { blockId } = aiGeneratingKey.getState(state) ?? {
                blockId: null,
              };
              const pos = anchorWidgetPos(state.doc, blockId);
              if (pos === null) return null;
              // The widget reuses one DOM node across redraws (stable `key`),
              // so the bus subscription is created once and torn down via
              // `destroy`. `toDOM` stashes the unsubscribe on the node for it.
              return DecorationSet.create(state.doc, [
                Decoration.widget(
                  pos,
                  () => {
                    const inst = buildIndicator(labels);
                    (inst.dom as HTMLElement & { _destroy?: () => void })._destroy =
                      inst.destroy;
                    return inst.dom;
                  },
                  {
                    // Sit just after the anchor line, before streamed content.
                    side: -1,
                    key: "doc-ai-generating",
                    ignoreSelection: true,
                    destroy: (node: Node) => {
                      (node as HTMLElement & { _destroy?: () => void })._destroy?.();
                    },
                  },
                ),
              ]);
            },
          },
        }),
      ];
    },
  });
}
