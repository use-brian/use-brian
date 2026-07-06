"use client";

/**
 * The single whole-page collaborative Tiptap editor (replaces the per-block
 * `page-renderer` once wired into the shell). One `useEditor` bound to a Yjs
 * doc via `Collaboration` + `CollaborationCursor`, so every keystroke and the
 * AI's edits merge live with no clobbering. The 18 block kinds are the shared
 * `@sidanclaw/doc-model` schema; data/chart/media/etc. render through React
 * node-views.
 *
 * Editing affordances layered on the live editor:
 *   - **Slash menu** (`createSlashMenuExtension`) — typing `/` opens the
 *     Notion-identical block picker; most items run `executeSlashItem`, while
 *     Page / Link-to-page are intercepted here (createDraft + child_page link /
 *     `PagePicker`).
 *   - **Empty-line placeholder + Space→AI** (`createDocPlaceholderExtension`
 *     + `createAiSpaceTriggerExtension`) — "Press 'space' for AI or '/' for
 *     commands" on an empty line; Space hands into the chat anchored to it.
 *   - **Floating toolbar** (`<FloatingToolbar>`) — the bubble menu over a
 *     selection: turn-into + bold / italic / code / link (+ Cmd-K).
 *   - **`@`-mentions** (`createPersonMentionExtension` +
 *     `createPageMentionExtension`) — `@person` → workspace members,
 *     `@page` → drafts + saved pages, both inline nodes from the shared
 *     schema so they round-trip through Yjs.
 *
 * The Yjs doc + provider are **owned by `doc-shell`** (one
 * `useCollabProvider` per active page) and passed in via `collab`, so the
 * chrome and the editor share one socket. This component no longer dials its
 * own connection. The editor body renders a skeleton until the initial sync
 * lands.
 *
 * [COMP:app-web/collab-page-editor]
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";
import { useEditor, EditorContent } from "@tiptap/react";
import { markdownPasteToPMDoc } from "@/lib/markdown-paste";
import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import type { AnyExtension, Editor } from "@tiptap/core";
import type * as Y from "yjs";
import {
  FRAGMENT_FIELD,
  blocksToPMDoc,
  instantiatePageTemplate,
  withFreshBlockIds,
  type CustomPageTemplateSummary,
} from "@sidanclaw/doc-model";
import type { CollabHandle } from "@/lib/collab/use-collab-provider";
import { colorForUserId } from "@/lib/collab/cursor-color";
import { useT } from "@/lib/i18n/client";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { fetchMembers, fetchPages } from "@/lib/api/mentions";
import {
  createDraft,
  newBlockId,
  getAssistantIdentity,
  listCustomPageTemplates,
  getCustomPageTemplate,
  deleteCustomPageTemplate,
  type AssistantIdentity,
} from "@/lib/api/views";
import { browserDocExtensions } from "./doc-schema";
import { FloatingToolbar } from "./floating-toolbar";
import { DocDragHandle } from "./drag-handle";
import { findBlockPos, ensureBlockId } from "./block-actions";
import { blockIdFromHash } from "@/lib/doc-page-url";
import {
  createSlashMenuExtension,
  type SlashMenuCategory,
  type SlashMenuItem,
} from "./slash-menu";
import { executeSlashItem } from "./slash-execute";
import {
  createDocPlaceholderExtension,
  createToggleSummaryPlaceholderExtension,
} from "./doc-placeholder";
import { createAiSpaceTriggerExtension } from "./ai-space-trigger";
import {
  createAiGeneratingExtension,
  aiGeneratingKey,
} from "./ai-generating-decoration";
import { subscribeBuildActivity } from "@/lib/build-activity";
import { PagePicker } from "./page-picker";
import { TemplateGallery } from "./template-gallery";
import { InlineAiPrompt } from "./inline-ai-prompt";
import type { PageMentionItem, PersonMentionItem } from "./mentions/mention-popup";
import { createPersonMentionExtension } from "./mentions/person-mention";
import { createPageMentionExtension } from "./mentions/page-mention";
import { useAutoTitle } from "@/lib/collab/use-auto-title";
import {
  createCommentDecorationsExtension,
  syncCommentThreads,
  syncCommentDraft,
  getCommentDraftRange,
  findStaleCommentMarkRanges,
  resolvedMarkThreadIds,
  type DecorationThread,
} from "./comment-decorations";
import { CommentThreadPopover } from "./comment-thread-popover";
import { NewCommentPopover, type NewCommentSubmit } from "./new-comment-popover";
import { type CommentSeed } from "./comment-thread-body";
import { CommentRail, useRailGeometry } from "./comment-rail";
import { CommentThreadList } from "./comment-thread-list";
import { useCommentThreadHover } from "./comment-hover";
import { PageComments } from "./page-comments";
import {
  listPageThreads,
  createCommentThread,
  listEmptyThreadIds,
  type CommentThread,
} from "@/lib/api/comments";
import { recordDocMention } from "@/lib/api/inbox";
import { DOC_COMMENTS_CHANGED_EVENT } from "@/lib/comment-events";

export type CollabPageEditorProps = {
  /** Shared Yjs doc + provider, owned by `doc-shell`. */
  collab: CollabHandle;
  canEdit?: boolean;
  /** Display name + stable id for this user's collaboration cursor; `avatarUrl`
   *  rides along for the comment-thread author rows. */
  user?: { id: string; name: string; avatarUrl?: string | null };
  /** Active page id — drives the human auto-title trigger (migration 218). */
  viewId?: string;
  /** Title provenance; auto-title is armed only while `"placeholder"`. */
  nameOrigin?: string;
  /** Reflect an auto-generated title + suggested icon back into page metadata (no REST rename). */
  onAutoTitled?: (title: string, icon: string | null) => void;
  /** The workspace's doc assistant — backs comment-thread sessions
   *  (creating a thread + streaming the AI's reply). When absent, comments
   *  are read-only (no new threads, no AI replies). */
  assistantId?: string;
  /**
   * Optional node rendered between the page comment composer and the content
   * (top of the body). Used by the shell to drop the `<PageBuildIndicator>`
   * where the AI's blocks stream in, while a landing build runs.
   */
  buildSlot?: ReactNode;
  /**
   * Reports whether this page currently has at least one inline (in-doc)
   * comment anchor. The shell uses it to reserve a right gutter — shifting the
   * page content left so the comment rail has somewhere to dock (Notion-style).
   */
  onCommentsPresenceChange?: (present: boolean) => void;
  /**
   * Start the "author a template from scratch" flow (the gallery's "New
   * template" button). Owned by the shell — it mints a transient draft and
   * routes to it. When absent the button is hidden.
   */
  onNewTemplate?: () => void;
  /**
   * A template to seed into THIS (empty) draft once the editor goes live. The
   * empty-page landing's "Start from a template" hands it here instead of
   * minting a *new* page, so the open blank draft is filled in place (it is
   * always an existing empty draft — see `doc-shell`'s `isDraftLanding`).
   * Inserted once, at the top of the page, through the same Yjs insert path the
   * "/template" slash item uses; the shell clears it via `onTemplateSeeded`.
   */
  seedTemplate?: { kind: "builtin" | "custom"; id: string } | null;
  /** Fired once the `seedTemplate` blocks have been inserted (or skipped). */
  onTemplateSeeded?: () => void;
  /**
   * Fired on every document edit (Tiptap `update`). The shell uses it to drive
   * the deferred `created` page-event commit (migration 283): debounced typing
   * fires the event for a freshly-created draft. Cheap + high-frequency — the
   * handler must debounce.
   */
  onContentChange?: () => void;
};

export function CollabPageEditor({
  collab,
  canEdit,
  user,
  viewId,
  nameOrigin,
  onAutoTitled,
  assistantId,
  buildSlot,
  onCommentsPresenceChange,
  onNewTemplate,
  seedTemplate,
  onTemplateSeeded,
  onContentChange,
}: CollabPageEditorProps) {
  const { doc, provider, synced } = collab;
  if (!doc || !provider) {
    return (
      <>
        {buildSlot}
        <EditorSkeleton />
      </>
    );
  }
  return (
    <CollabEditorInner
      doc={doc}
      provider={provider}
      canEdit={canEdit !== false}
      synced={synced}
      user={user}
      viewId={viewId}
      nameOrigin={nameOrigin}
      onAutoTitled={onAutoTitled}
      assistantId={assistantId}
      buildSlot={buildSlot}
      onCommentsPresenceChange={onCommentsPresenceChange}
      onNewTemplate={onNewTemplate}
      seedTemplate={seedTemplate}
      onTemplateSeeded={onTemplateSeeded}
      onContentChange={onContentChange}
    />
  );
}

function CollabEditorInner({
  doc,
  provider,
  canEdit,
  synced,
  user,
  viewId,
  nameOrigin,
  onAutoTitled,
  assistantId,
  buildSlot,
  onCommentsPresenceChange,
  onNewTemplate,
  seedTemplate,
  onTemplateSeeded,
  onContentChange,
}: {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  canEdit: boolean;
  synced: boolean;
  user?: { id: string; name: string; avatarUrl?: string | null };
  viewId?: string;
  nameOrigin?: string;
  onAutoTitled?: (title: string, icon: string | null) => void;
  assistantId?: string;
  buildSlot?: ReactNode;
  onCommentsPresenceChange?: (present: boolean) => void;
  onNewTemplate?: () => void;
  seedTemplate?: { kind: "builtin" | "custom"; id: string } | null;
  onTemplateSeeded?: () => void;
  onContentChange?: () => void;
}) {
  const t = useT().docPage;
  const ws = useWorkspaceContext();

  // ── Comments (chat-as-threads) ──────────────────────────────────────
  // React owns the thread list; the decoration plugin reads it via a
  // meta-only transaction (see comment-decorations.ts). The plugin's
  // onOpenThread reads the latest threads through a ref so the extension
  // stays stable (rebuilding it would reinstall the PM plugin every paint).
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const threadsRef = useRef<CommentThread[]>([]);
  threadsRef.current = threads;
  // Notion-style linked hover: hovering a highlight, gutter badge, or rail card
  // brightens every run of that thread at once (see comment-hover.ts).
  useCommentThreadHover();
  const [activeThread, setActiveThread] = useState<{
    thread: CommentThread;
    el: HTMLElement;
    /** A page-composer hand-off — set only when opening a freshly-posted page
     *  comment, so the popover's body auto-sends + streams the first turn. */
    seed?: CommentSeed;
  } | null>(null);
  const [commentsRefreshKey, setCommentsRefreshKey] = useState(0);
  // A not-yet-committed comment: the floating-toolbar "Comment" action opens
  // this PURELY in the UI (a local draft highlight + the composer) — nothing
  // touches the backend or the Yjs doc until the first message is sent. `el` is
  // the painted draft-highlight span the composer anchors to (resolved a frame
  // after the decoration paints). See `new-comment-popover.tsx`.
  const [draftComment, setDraftComment] = useState<{
    quote: string;
    anchorBlockId?: string;
    el: HTMLElement | null;
    /** Whole-block (atom) comment → on commit mints a `human_block` thread with
     *  NO range mark (atoms carry no text to mark; the highlight is the
     *  decoration keyed on `anchorBlockId`). Absent = the text-range flow. */
    wholeBlock?: boolean;
  } | null>(null);
  // The doc assistant's display identity (name + icon) for AI comment rows.
  const [assistant, setAssistant] = useState<AssistantIdentity | null>(null);
  useEffect(() => {
    if (!assistantId) {
      setAssistant(null);
      return;
    }
    let cancelled = false;
    void getAssistantIdentity(assistantId).then((a) => {
      if (!cancelled) setAssistant(a);
    });
    return () => {
      cancelled = true;
    };
  }, [assistantId]);
  const editorWrapRef = useRef<HTMLDivElement>(null);
  // Mirror the wrap element into state so the rail geometry hook re-runs once
  // it mounts (a ref alone wouldn't trigger the effect).
  const [editorWrapEl, setEditorWrapEl] = useState<HTMLDivElement | null>(null);
  const setEditorWrap = useCallback((node: HTMLDivElement | null) => {
    editorWrapRef.current = node;
    setEditorWrapEl(node);
  }, []);

  const refetchThreads = useCallback(() => {
    if (!viewId) return;
    void listPageThreads(viewId).then((rows) => {
      setThreads(rows);
      setCommentsRefreshKey((k) => k + 1);
    });
  }, [viewId]);

  useEffect(() => {
    refetchThreads();
    const onChanged = () => refetchThreads();
    window.addEventListener(DOC_COMMENTS_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(DOC_COMMENTS_CHANGED_EVENT, onChanged);
  }, [refetchThreads]);

  // While any thread's backing turn is still running (a turn that survived a
  // page refresh — see doc-comments.md "Live turn reconnect"), poll the thread
  // list so the at-a-glance "working…" indicators on collapsed surfaces (the
  // rail cards) clear when the turn finishes. One poll for the whole page; it
  // stops the moment nothing is running. The expanded body / page band stream
  // the reply live via their own reconnect; this only refreshes the cues.
  const anyThreadRunning = threads.some((th) => th.sessionStatus === "running");
  useEffect(() => {
    if (!anyThreadRunning) return;
    const id = window.setInterval(refetchThreads, 5000);
    return () => window.clearInterval(id);
  }, [anyThreadRunning, refetchThreads]);

  const commentExtension = useMemo(
    () =>
      createCommentDecorationsExtension({
        onOpenThread: (threadId, el) => {
          const thread = threadsRef.current.find((th) => th.id === threadId);
          if (thread) setActiveThread({ thread, el });
        },
      }),
    [],
  );

  // Human-edit auto-title trigger (migration 218). No-op unless editing is
  // allowed and the title is still the untouched placeholder.
  useAutoTitle({
    doc,
    viewId: canEdit ? viewId ?? null : null,
    nameOrigin: nameOrigin ?? "user",
    synced,
    onTitled: (title, icon) => onAutoTitled?.(title, icon),
  });

  // ── Slash actions that need page state (Page / Link to page / Space-AI) ──
  // These can't run inside the pure `executeSlashItem` chain — they need the
  // router, workspace context, and a page picker. The slash + space extensions
  // call them through refs so the extension set stays stable (rebuilding it
  // would reinstall the ProseMirror plugins every paint).
  const router = useRouter();
  const [pagePicker, setPagePicker] = useState<{
    top: number;
    left: number;
    insertPos: number;
  } | null>(null);
  // The "/template" slash item — opens the centered template gallery. We
  // capture the insert position the slash was invoked at so a pick (made later,
  // through the modal) lands at the right place even though focus moved.
  const [templateGallery, setTemplateGallery] = useState<{ insertPos: number } | null>(null);
  // Workspace custom templates, loaded lazily when the gallery opens.
  const [customTemplates, setCustomTemplates] = useState<CustomPageTemplateSummary[]>([]);
  const refreshCustomTemplates = useCallback(() => {
    void listCustomPageTemplates(ws.workspaceId)
      .then(setCustomTemplates)
      .catch(() => setCustomTemplates([]));
  }, [ws.workspaceId]);
  useEffect(() => {
    if (templateGallery) refreshCustomTemplates();
  }, [templateGallery, refreshCustomTemplates]);
  // Empty-line "Space for AI": the inline AI box, anchored at the caret of the
  // empty paragraph the user pressed Space on. Opened by `onAiSpaceRef` below.
  const [aiPrompt, setAiPrompt] = useState<{
    blockId: string;
    top: number;
    left: number;
    width: number;
  } | null>(null);
  // The block the inline AI box submitted on — drives the in-flow "Generating…"
  // widget (`ai-generating-decoration.ts`) at that anchor until the turn ends.
  const [generatingBlockId, setGeneratingBlockId] = useState<string | null>(null);

  // Drop an inline `child_page` embed (a link to a sub-page) at a doc position.
  const insertChildPageEmbed = useCallback(
    (ed: Editor, pos: number, childPageId: string) => {
      const id = newBlockId();
      ed
        .chain()
        .focus()
        .insertContentAt(pos, {
          type: "embed",
          attrs: {
            blockId: id,
            block: JSON.stringify({ kind: "child_page", id, childPageId }),
          },
        })
        .run();
    },
    [],
  );

  // "Page" slash item — mint a draft nested under this page, link to it inline,
  // then navigate into the new page (Notion's create-and-open behavior).
  const insertNewChildPage = useCallback(
    async (ed: Editor) => {
      const insertPos = ed.state.selection.from;
      try {
        const draft = await createDraft({
          workspaceId: ws.workspaceId,
          ...(viewId ? { nestParentId: viewId } : {}),
        });
        insertChildPageEmbed(ed, insertPos, draft.id);
        // Surface the new child in the sidebar tree — the hoisted provider
        // only refetches on `doc:draft-created`, not on the `router.push`
        // below, so without this the subpage stays invisible until a reload.
        if (typeof window !== "undefined") {
          window.dispatchEvent(
            new CustomEvent("doc:draft-created", {
              detail: { viewId: draft.id, action: "created" },
            }),
          );
        }
        router.push(`/w/${ws.workspaceId}/p/${draft.id}`);
      } catch {
        // Soft-fail: a failed create leaves the line untouched (no orphan link).
      }
    },
    [ws.workspaceId, viewId, insertChildPageEmbed, router],
  );

  // "Link to page" slash item — open the picker at the caret; on pick we drop
  // an inline link to the chosen existing page (handled in the JSX below).
  const openPagePicker = useCallback((ed: Editor) => {
    const { from } = ed.state.selection;
    const coords = ed.view.coordsAtPos(from);
    setPagePicker({ top: coords.bottom + 4, left: coords.left, insertPos: from });
  }, []);

  // "Template" slash item — open the centered gallery, remembering the caret so
  // the pick lands where the slash was typed.
  const openTemplateGallery = useCallback((ed: Editor) => {
    setTemplateGallery({ insertPos: ed.state.selection.from });
  }, []);

  // Insert a template's blocks at `pos`. Instantiates the shared core template
  // (markdown -> canonical blocks with fresh ids), maps it to ProseMirror nodes
  // via the same `blocksToPMDoc` round-trip the renderer uses, and drops the
  // node fragment in. When the line at `pos` is an empty paragraph it is
  // replaced (no stray blank line), mirroring `executeSlashItem`'s atom rule.
  const insertTemplate = useCallback(
    (ed: Editor, pos: number, templateId: string) => {
      const instance = instantiatePageTemplate(templateId);
      if (!instance || instance.blocks.length === 0) return;
      const pmDoc = blocksToPMDoc(instance.blocks);
      const content = (pmDoc as { content?: unknown[] }).content ?? [];
      if (content.length === 0) return;
      const $pos = ed.state.doc.resolve(Math.min(pos, ed.state.doc.content.size));
      const parent = $pos.parent;
      const lineEmpty = parent.isTextblock && parent.content.size === 0;
      const chain = ed.chain().focus();
      if (lineEmpty) {
        const range = { from: $pos.before(), to: $pos.after() };
        chain.insertContentAt(range, content).run();
      } else {
        chain.insertContentAt(pos, content).run();
      }
    },
    [],
  );

  // Insert a CUSTOM template's stored blocks at `pos`. Fetches the snapshot,
  // mints fresh block ids (so they never collide with the page's), then runs
  // the same `blocksToPMDoc` insert path as `insertTemplate`.
  const insertCustomTemplate = useCallback(
    async (ed: Editor, pos: number, templateId: string) => {
      const tpl = await getCustomPageTemplate(ws.workspaceId, templateId).catch(() => null);
      if (!tpl || tpl.blocks.length === 0) return;
      const blocks = withFreshBlockIds(tpl.blocks, () => crypto.randomUUID());
      const pmDoc = blocksToPMDoc(blocks);
      const content = (pmDoc as { content?: unknown[] }).content ?? [];
      if (content.length === 0) return;
      const $pos = ed.state.doc.resolve(Math.min(pos, ed.state.doc.content.size));
      const parent = $pos.parent;
      const lineEmpty = parent.isTextblock && parent.content.size === 0;
      const chain = ed.chain().focus();
      if (lineEmpty) {
        const range = { from: $pos.before(), to: $pos.after() };
        chain.insertContentAt(range, content).run();
      } else {
        chain.insertContentAt(pos, content).run();
      }
    },
    [ws.workspaceId],
  );

  // Stable indirection: the slash/space extensions read the latest handler off
  // these refs, so the extension set never rebuilds on a state change.
  const onSlashSelectRef = useRef<(item: SlashMenuItem, ed: Editor) => void>(() => {});
  onSlashSelectRef.current = (item, ed) => {
    if (item.blockKind === "child_page") {
      void insertNewChildPage(ed);
      return;
    }
    if (item.blockKind === "link_to_page") {
      openPagePicker(ed);
      return;
    }
    if (item.blockKind === "template") {
      openTemplateGallery(ed);
      return;
    }
    executeSlashItem(ed, item);
  };

  const onAiSpaceRef = useRef<(blockId: string, ed: Editor) => void>(() => {});
  onAiSpaceRef.current = (blockId, ed) => {
    // Open the inline AI box just below this empty line, spanning the editor's
    // writing column (full width) rather than a narrow popover at the caret.
    // All viewport coords — the box is `fixed`.
    const caret = ed.view.coordsAtPos(ed.state.selection.from);
    const column = ed.view.dom.getBoundingClientRect();
    setAiPrompt({
      blockId,
      top: caret.bottom + 6,
      left: column.left,
      width: column.width,
    });
  };

  // Page-body @-mention → record a doc-Inbox notification for the tagged
  // member. Held in a ref so the memoised extension set (below) reads the live
  // pageId without re-creating on every `viewId` change.
  const onPersonMentionedRef = useRef<(item: PersonMentionItem) => void>(() => {});
  onPersonMentionedRef.current = (item) => {
    if (!viewId) return;
    void recordDocMention({
      workspaceId: ws.workspaceId,
      pageId: viewId,
      mentionedUserIds: [item.id],
    });
  };

  // Locale resolvers + the slash/mention extension set. Memoised on the
  // dictionary + workspace + edit-mode so the extensions are stable across
  // re-renders (rebuilding them would re-install ProseMirror plugins every
  // paint). The dynamic handlers are read through refs, so they aren't deps.
  const editingExtensions = useMemo<AnyExtension[]>(() => {
    const resolveSlashLabel = (item: SlashMenuItem) => t.slashMenu.items[item.labelKey];
    const resolveSlashCategory = (category: SlashMenuCategory) =>
      t.slashMenu.categories[category];
    const popupLabels = {
      people: t.mentionPopup.tabPeople,
      pages: t.mentionPopup.tabPages,
      empty: t.mentionPopup.empty,
      aria: t.mentionPopup.ariaLabel,
    };
    const exts: AnyExtension[] = [
      createSlashMenuExtension({
        onSelect: (item, { editor }) => onSlashSelectRef.current(item, editor),
        resolveLabel: resolveSlashLabel,
        resolveCategoryLabel: resolveSlashCategory,
        filteredLabel: t.slashMenu.filteredResults,
        closeMenuLabel: t.slashMenu.closeMenu,
        escLabel: t.slashMenu.esc,
      }),
      createPersonMentionExtension({
        workspaceId: ws.workspaceId,
        fetchMembers,
        fetchPages,
        popupLabels,
        // A page-body @-mention drops a notification into the tagged member's
        // doc Inbox. Page-body mention → no threadId. Best-effort + via a
        // ref so the memoised extension set never re-creates on viewId change.
        onPersonMentioned: (item) => onPersonMentionedRef.current(item),
      }),
      // workspaceId scopes the rendered pill href to `/w/<id>/p/<pageId>` —
      // the bare `/p/<pageId>` fallback is dead on the app origin.
      createPageMentionExtension({ workspaceId: ws.workspaceId }),
    ];
    // Empty-line affordances are edit-only: the placeholder hint + the
    // Space-for-AI handoff make no sense to a read-only viewer.
    if (canEdit) {
      exts.push(
        createDocPlaceholderExtension({
          aiHint: t.editorPlaceholder.aiHint,
          heading: t.editorPlaceholder.heading,
        }),
        // Persistent hint on empty toggle summaries, so a content-less toggle
        // never renders as an orphaned chevron (the global placeholder above is
        // focus-gated + top-level only, so it can't reach a nested summary).
        createToggleSummaryPlaceholderExtension(t.blocks.toggleTextPlaceholder),
        createAiSpaceTriggerExtension({
          onTrigger: (blockId, ed) => onAiSpaceRef.current(blockId, ed),
        }),
        // In-flow "Generating…" indicator (a meta-toggled widget decoration) —
        // shown at the anchor after the inline box submits, so progress sits in
        // the document body instead of floating over it.
        createAiGeneratingExtension({
          generating: t.inlineAi.generating,
          thinking: t.inlineAi.thinking,
        }),
      );
    }
    return exts;
    // The dictionary object is stable per-locale; depend on it + workspace + mode.
  }, [t, ws.workspaceId, canEdit]);

  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: canEdit,
      editorProps: {
        // Journey E (doc-conversion.md): paste block-structured Markdown as
        // real blocks instead of literal `###`/`- ` text. A rich-HTML paste (a
        // real formatted copy) or a single-line/inline paste falls through to
        // the default handler; a schema mismatch is caught and also falls back.
        handlePaste(view, event) {
          const html = event.clipboardData?.getData("text/html") ?? "";
          if (html.trim()) return false;
          const text = event.clipboardData?.getData("text/plain") ?? "";
          const pm = markdownPasteToPMDoc(text);
          if (!pm) return false;
          try {
            const node = view.state.schema.nodeFromJSON(pm);
            view.dispatch(
              view.state.tr.replaceSelection(node.slice(0)).scrollIntoView(),
            );
            return true;
          } catch {
            return false;
          }
        },
      },
      extensions: [
        ...browserDocExtensions({ workspaceId: ws.workspaceId }),
        ...editingExtensions,
        commentExtension,
        Collaboration.configure({ document: doc, field: FRAGMENT_FIELD }),
        CollaborationCursor.configure({
          provider,
          // `id` rides along so the top-bar face-pile (`usePresence`) can
          // dedupe the same person across tabs; `name`/`color` drive the
          // in-document caret.
          user: {
            id: user?.id ?? "me",
            name: user?.name ?? "You",
            color: colorForUserId(user?.id ?? "me"),
          },
        }),
      ],
    },
    [doc, provider, editingExtensions, commentExtension],
  );

  // Seed a template into a fresh, empty draft (the landing's "Start from a
  // template" → `doc-shell`). Unlike the slash-menu gallery, which inserts at
  // the caret on demand, this runs once the moment the editor goes live: focus
  // the top of the empty page and drop the template's blocks there, replacing
  // the lone empty paragraph (`insertTemplate`'s `lineEmpty` rule). Gated on
  // `synced` so we never insert before the Yjs doc's initial content has
  // loaded — otherwise the seed would race (or duplicate) the loaded blocks.
  // The ref makes it fire exactly once per handed-in template; it resets when
  // the shell clears `seedTemplate` so a later page can be seeded too.
  const seededTemplateRef = useRef(false);
  useEffect(() => {
    if (!seedTemplate) {
      seededTemplateRef.current = false;
      return;
    }
    if (!editor || !synced || !canEdit || seededTemplateRef.current) return;
    seededTemplateRef.current = true;
    editor.commands.focus("start");
    const pos = editor.state.selection.from;
    if (seedTemplate.kind === "builtin") {
      insertTemplate(editor, pos, seedTemplate.id);
      onTemplateSeeded?.();
    } else {
      void insertCustomTemplate(editor, pos, seedTemplate.id).finally(() => {
        onTemplateSeeded?.();
      });
    }
  }, [
    editor,
    synced,
    canEdit,
    seedTemplate,
    insertTemplate,
    insertCustomTemplate,
    onTemplateSeeded,
  ]);

  // Forward document edits to the shell (drives the deferred `created`
  // page-event commit — migration 283). Subscribed via a ref-backed handler so
  // the listener is installed once per editor, not rebuilt when the callback
  // identity changes.
  const onContentChangeRef = useRef(onContentChange);
  onContentChangeRef.current = onContentChange;
  useEffect(() => {
    if (!editor) return;
    const handler = () => onContentChangeRef.current?.();
    editor.on("update", handler);
    return () => {
      editor.off("update", handler);
    };
  }, [editor]);

  // Inline "Space for AI": push the active generating-block into the widget
  // decoration plugin (a meta-only transaction — never syncs to Yjs). Set on
  // submit, cleared when the turn ends → the in-flow "Generating…" pill shows
  // at the anchor then vanishes.
  useEffect(() => {
    if (!editor) return;
    editor.view.dispatch(
      editor.state.tr.setMeta(aiGeneratingKey, { blockId: generatingBlockId }),
    );
  }, [editor, generatingBlockId]);

  // Clear the generating indicator when the turn finishes. We watch the
  // build-activity bus the corner chat publishes: once we've seen it stream,
  // drop the pill when it stops. A 60s backstop covers a turn that never starts
  // (e.g. a prior stream was still in flight when the box seeded).
  useEffect(() => {
    if (!generatingBlockId) return;
    let started = false;
    const timeout = window.setTimeout(() => {
      if (!started) setGeneratingBlockId(null);
    }, 60_000);
    const unsubscribe = subscribeBuildActivity((a) => {
      if (a.isStreaming) started = true;
      else if (started) setGeneratingBlockId(null);
    });
    return () => {
      window.clearTimeout(timeout);
      unsubscribe();
    };
  }, [generatingBlockId]);

  // Push the current thread list into the decoration plugin whenever it
  // changes (a meta-only transaction — never syncs to the Yjs doc).
  useEffect(() => {
    if (!editor) return;
    const decoThreads: DecorationThread[] = threads.map((th) => ({
      id: th.id,
      anchorKind: th.anchorKind,
      anchorBlockId: th.anchorBlockId,
    }));
    syncCommentThreads(editor.view, decoThreads);
  }, [editor, threads]);

  // Report whether the page has an inline (in-doc) comment anchor, so the shell
  // can reserve a right gutter for the rail (shifting content left). Checked
  // against the painted decorations — `[data-thread-id]` lands a frame after a
  // thread change, so we re-check on the next frame too. The `comment` mark
  // anchors and AI block tints are the only sources, both carrying the attr.
  // **Scoped to `.ProseMirror`**: the page-comments band's running-thread row
  // also carries `[data-thread-id]` but lives ABOVE the doc (top, self-contained,
  // no rail card), so an unscoped query reserved the gutter — shifting the page
  // left — for a page that has no margin comments at all.
  //
  // On INITIAL load the anchors paint only once the LAST of two independent
  // async paths settles: the thread fetch (`threads` / `commentsRefreshKey`,
  // in the deps below) AND the Yjs content sync that brings in the `comment`
  // marks + anchored blocks. The dep array can't observe that second path, so a
  // page navigated to WITH pre-existing comments reported `false` (marks not yet
  // synced when this ran), and the content never shifted left to reserve the
  // gutter — only a later edit happened to re-check. Re-checking on every editor
  // transaction (the sync's docChanged txns, remote edits, and the meta-only
  // thread push) catches that late paint, and also releases the gutter when the
  // last commented run is deleted. React bails out on the unchanged boolean, so
  // the per-keystroke transactions don't re-render the shell.
  useEffect(() => {
    if (!onCommentsPresenceChange || !editor) return;
    const report = () =>
      onCommentsPresenceChange(
        !!editorWrapRef.current?.querySelector(".ProseMirror [data-thread-id]"),
      );
    report();
    const raf = window.requestAnimationFrame(report);
    editor.on("transaction", report);
    return () => {
      window.cancelAnimationFrame(raf);
      editor.off("transaction", report);
    };
  }, [onCommentsPresenceChange, commentsRefreshKey, threads, editor]);

  // Floating-toolbar "Comment" action: open a LOCAL draft on the selection — a
  // transient highlight (no `comment` mark, no Yjs write) + the new-comment
  // composer. Nothing is persisted until the user sends the first message
  // (`commitDraftComment`); dismissing leaves no thread, badge, or mark. This
  // is the fix for the "empty thread" bug where opening a comment and typing
  // nothing left an orphaned thread showing "No comments yet".
  const onComment = useCallback(() => {
    if (!editor || !assistantId || !viewId) return;
    const { from, to } = editor.state.selection;
    if (from === to) return;
    const quote = editor.state.doc.textBetween(from, to, " ").slice(0, 280);
    const $from = editor.state.doc.resolve(from);
    let anchorBlockId: string | undefined;
    for (let d = $from.depth; d > 0; d--) {
      const id = $from.node(d).attrs?.blockId as string | undefined;
      if (id) {
        anchorBlockId = id;
        break;
      }
    }
    // A range comment MUST anchor to its block — without a blockId the highlight
    // + gutter badge have nowhere to live AND the thread is treated as a
    // page-level (unanchored) thread, which routes its first message to the
    // page-comments band that has no channel for a freshly-minted thread's seed
    // (the message then silently never sends). Freshly-typed text defaults to a
    // null blockId, so mint + stamp one now (the same lazy assignment Copy-link
    // and drag use) to keep every range comment anchored.
    if (!anchorBlockId) {
      anchorBlockId = ensureBlockId(editor, $from.before(1)) ?? undefined;
    }
    // Paint the local draft highlight, then collapse the selection so the
    // inline floating toolbar hides (the composer takes over). The draft range
    // lives in the decoration plugin's state, so collapsing the selection
    // doesn't move it.
    syncCommentDraft(editor.view, { from, to });
    editor.commands.setTextSelection(to);
    setActiveThread(null);
    setDraftComment({ quote, anchorBlockId, el: null });
    // Anchor the composer to the painted highlight span once it lands.
    window.setTimeout(() => {
      const el = document.querySelector("[data-comment-draft]") as HTMLElement | null;
      setDraftComment((d) => (d ? { ...d, el: el ?? editorWrapRef.current } : d));
    }, 0);
  }, [editor, assistantId, viewId]);

  // Block-action "Comment for AI" for an ATOM block (chart / diagram / data /
  // image / file / bookmark / …). Atoms carry no inner text, so the range-based
  // `onComment` can't mark them — open a WHOLE-block draft instead: no draft
  // highlight, the composer anchored to the block's own DOM. On commit this
  // mints a `human_block` thread (see `commitDraftComment`); the gutter badge +
  // whole-block tint are painted by the decoration layer from `anchorBlockId`.
  const onBlockComment = useCallback(
    (blockId: string) => {
      if (!editor || !assistantId || !viewId || !blockId) return;
      const pos = findBlockPos(editor, blockId);
      const dom =
        pos != null ? (editor.view.nodeDOM(pos) as HTMLElement | null) : null;
      setActiveThread(null);
      setDraftComment({
        quote: "",
        anchorBlockId: blockId,
        el: dom ?? editorWrapRef.current,
        wholeBlock: true,
      });
    },
    [editor, assistantId, viewId],
  );

  // Commit the draft: NOW mint the thread, stamp the `comment` mark, and open
  // the real thread. With AI reply on, the first message is handed to the body
  // as a seed (streams the assistant's reply, same as a page comment); with it
  // off, the message is seeded as a plain teammate comment (`body`) and the
  // thread opens with no AI turn.
  const commitDraftComment = useCallback(
    async (payload: NewCommentSubmit) => {
      if (!editor || !assistantId || !viewId) return;
      const range = getCommentDraftRange(editor.state);
      const draft = draftComment;
      try {
        const thread = await createCommentThread({
          pageId: viewId,
          assistantId,
          workspaceId: ws.workspaceId,
          // Atom blocks have no inner text to mark → a whole-block anchor.
          ...(draft?.wholeBlock ? { anchorKind: "human_block" as const } : {}),
          anchorBlockId: draft?.anchorBlockId,
          quote: draft?.quote || undefined,
          // Teammate-only comment → seed the first message as the thread's row;
          // AI reply → leave empty, the seeded body posts through /api/chat.
          ...(payload.aiReply ? {} : { body: payload.body || undefined }),
        });
        // Notify any @-mentioned teammates now the thread (and its id) exists.
        if (payload.mentions.length > 0) {
          void recordDocMention({
            workspaceId: ws.workspaceId,
            pageId: viewId,
            threadId: thread.id,
            mentionedUserIds: payload.mentions,
            preview: payload.body,
          });
        }
        // Range flow only: stamp the `comment` mark over the (possibly
        // remapped) draft range, then clear the transient highlight — the mark
        // now carries it. A whole-block (atom) thread has no range and no draft
        // highlight; its tint is the decoration keyed on `anchorBlockId`, so
        // there's nothing to stamp or clear here.
        if (!draft?.wholeBlock) {
          const r = getCommentDraftRange(editor.state) ?? range;
          if (r && r.to > r.from) {
            editor
              .chain()
              .focus()
              .setTextSelection({ from: r.from, to: r.to })
              .setMark("comment", { threadId: thread.id })
              .run();
          }
          syncCommentDraft(editor.view, null);
        }
        setDraftComment(null);
        setThreads((prev) => [thread, ...prev]);
        // Open the thread so its first message actually sends. Anchor to the
        // freshly-stamped highlight once it paints, but ALWAYS open — fall back
        // to the editor frame (the overlay hosts an unanchored thread) so the
        // seed can never be dropped. The old `if (el)` gate behind a
        // `setTimeout(0)` raced the decoration repaint: when the badge hadn't
        // painted yet the seed was silently dropped, leaving an empty thread +
        // a stamped mark — the stale-empty-comment leak. One rAF lets the badge
        // paint so the common case still anchors precisely (same trick the
        // deep-link focus effect uses).
        const seed = payload.aiReply
          ? {
              message: payload.body,
              fileIds: payload.fileIds,
              model: payload.model,
              researchMode: payload.researchMode,
            }
          : undefined;
        window.requestAnimationFrame(() => {
          const el =
            (document.querySelector(
              `[data-thread-id="${thread.id}"]`,
            ) as HTMLElement | null) ??
            editorWrapRef.current ??
            document.body;
          setActiveThread({ thread, el, ...(seed ? { seed } : {}) });
        });
      } catch {
        /* RLS / network — leave the draft open so the user can retry */
      }
    },
    [editor, assistantId, viewId, ws.workspaceId, draftComment],
  );

  // Dismiss the draft with no trace — clear the local highlight; no backend
  // write ever happened, so there's nothing to undo.
  const dismissDraftComment = useCallback(() => {
    if (editor) syncCommentDraft(editor.view, null);
    setDraftComment(null);
  }, [editor]);

  const canComment = canEdit && !!assistantId && !!viewId;

  // Deep-link scroll: a `#b-<blockId>` hash scrolls that block into view +
  // flashes it once the doc has synced. Gated on `synced` (a hash present
  // before sync waits); `hashchange` re-runs it for intra-app navigation to a
  // new block hash with no remount.
  useEffect(() => {
    if (!synced || !editor || typeof window === "undefined") return;
    let clearTimer: number | undefined;
    const focusBlock = () => {
      const id = blockIdFromHash(window.location.hash);
      if (!id) return;
      const el = editorWrapRef.current?.querySelector<HTMLElement>(
        `.ProseMirror [data-block-id="${CSS.escape(id)}"]`,
      );
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("doc-block-target");
      window.clearTimeout(clearTimer);
      clearTimer = window.setTimeout(
        () => el.classList.remove("doc-block-target"),
        1500,
      );
    };
    // Defer the initial run one frame: right as `synced` flips, the just-synced
    // nodes may not have painted, so the querySelector could miss on a cold
    // deep-link open. `hashchange` (intra-app nav) runs immediately — the DOM
    // is already there.
    const raf = window.requestAnimationFrame(focusBlock);
    window.addEventListener("hashchange", focusBlock);
    return () => {
      window.cancelAnimationFrame(raf);
      window.removeEventListener("hashchange", focusBlock);
      window.clearTimeout(clearTimer);
    };
  }, [synced, editor]);

  // Cleanup sweep (per page open): a thread can be minted with its `comment`
  // mark stamped before its first comment lands — e.g. the AI-reply turn that
  // should have posted it never fired or failed. That strands an empty thread
  // plus a permanent amber highlight, because the mark lives in the Yjs doc
  // independently of the (now-hidden) thread row, so deleting the row alone
  // can't clear it. The server lists such empty threads for this page
  // (system-side, so per-thread clearance can't hide one a member who can open
  // the page should heal); we strip their marks from the SHARED doc in one
  // history-free transaction, so the highlight clears for every collaborator
  // and persists through doc-sync. Edit-gated — a read-only viewer must
  // never mutate the doc.
  useEffect(() => {
    if (!synced || !editor || !canEdit || !viewId) return;
    let cancelled = false;
    void listEmptyThreadIds(viewId).then((emptyIds) => {
      if (cancelled || emptyIds.length === 0 || editor.isDestroyed) return;
      const markType = editor.schema.marks.comment;
      if (!markType) return;
      const ranges = findStaleCommentMarkRanges(
        editor.state.doc,
        new Set(emptyIds),
        markType,
      );
      if (ranges.length === 0) return;
      const tr = editor.state.tr;
      for (const r of ranges) tr.removeMark(r.from, r.to, markType);
      tr.setMeta("addToHistory", false);
      editor.view.dispatch(tr);
    });
    return () => {
      cancelled = true;
    };
  }, [synced, editor, canEdit, viewId]);

  // Resolved-thread mark sweep (companion to the empty sweep above). A
  // `human_range` comment's amber highlight is a `comment` mark in the Yjs doc,
  // painted directly from the mark — independent of the thread list. Resolving a
  // thread only flips `resolved_at` in Postgres and drops it from the open list,
  // so the inline highlight strands (the empty sweep clears half-written threads,
  // never resolved ones). Strip the mark once its thread is resolved, in the same
  // history-free transaction that persists through doc-sync and clears for every
  // collaborator. Unlike the empty sweep — which must stay load-only because an
  // AI-reply thread is briefly empty between creation and its seed landing — this
  // re-runs on EVERY thread change (`commentsRefreshKey`): a resolved thread is
  // definitively closed, never in-flight, so reacting to resolves clears the
  // highlight live; on load it heals threads resolved before this sweep existed.
  // Block-anchored threads need no sweep — their tint derives from the live open
  // list, so resolving already clears it (see doc-comments.md "Resolved").
  useEffect(() => {
    if (!synced || !editor || !canEdit || !viewId) return;
    let cancelled = false;
    void listPageThreads(viewId, { includeResolved: true }).then((all) => {
      if (cancelled || editor.isDestroyed) return;
      const markType = editor.schema.marks.comment;
      if (!markType) return;
      const resolvedIds = resolvedMarkThreadIds(all);
      if (resolvedIds.size === 0) return;
      const ranges = findStaleCommentMarkRanges(editor.state.doc, resolvedIds, markType);
      if (ranges.length === 0) return;
      const tr = editor.state.tr;
      for (const r of ranges) tr.removeMark(r.from, r.to, markType);
      tr.setMeta("addToHistory", false);
      editor.view.dispatch(tr);
    });
    return () => {
      cancelled = true;
    };
  }, [synced, editor, canEdit, viewId, commentsRefreshKey]);

  // Block ids currently present in the doc — used to flag orphaned threads
  // (anchor block deleted) in the page-level thread list. Recomputed when the
  // thread set refreshes (good enough; not on every keystroke).
  const liveAnchorIds = useMemo(() => {
    const ids = new Set<string>();
    editor?.state.doc.descendants((node) => {
      const id = node.attrs?.blockId as string | undefined;
      if (id) ids.add(id);
      return true;
    });
    return ids;
  }, [editor, commentsRefreshKey]);

  // Open a thread picked from a list (the page-level index or the
  // overall-comments nudge): scroll its in-doc badge/highlight into view and
  // anchor the popover to it. Falls back to the editor frame for an orphaned
  // thread (anchor block gone) or an unanchored page thread with no gutter mark.
  const openThreadFromList = useCallback((thread: CommentThread) => {
    const inDoc = document.querySelector(
      `[data-thread-id="${thread.id}"]`,
    ) as HTMLElement | null;
    const el = inDoc ?? editorWrapRef.current;
    if (!el) return;
    inDoc?.scrollIntoView({ behavior: "smooth", block: "center" });
    setActiveThread({ thread, el });
  }, []);

  // Expand a thread from its rail card — no scroll (the card is already in view).
  const expandThreadInRail = useCallback((thread: CommentThread) => {
    const el = document.querySelector(
      `[data-thread-id="${thread.id}"]`,
    ) as HTMLElement | null;
    setActiveThread({ thread, el: el ?? editorWrapRef.current ?? document.body });
  }, []);

  // A page comment was just posted (`PageComments.post`): add the brand-new
  // unanchored thread to the list so the page-comments band renders it inline as
  // the running discussion (the band owns the seed + streams the reply in place).
  // No popover — page-level threads live in the band, not the on-content overlay.
  const addPostedPageThread = useCallback((thread: CommentThread) => {
    setThreads((prev) => (prev.some((t) => t.id === thread.id) ? prev : [thread, ...prev]));
  }, []);

  // The margin rail handles a thread when there's room beside the column AND
  // the active thread has a real in-doc anchor (not the editor-frame fallback
  // used for unanchored / orphaned threads). Otherwise the on-content overlay
  // popover takes the active thread.
  const { hasRoom: railHasRoom, railLeft } = useRailGeometry(editorWrapEl);
  const openThreads = useMemo(() => threads.filter((th) => !th.resolvedAt), [threads]);
  // A page-level (unanchored) active thread lives INLINE in the page-comments
  // band (the Notion running thread), never the on-content popover or the margin
  // rail. Orphaned anchored threads (anchor block deleted) keep the popover —
  // they have no home in the band.
  const activePageThread = !!activeThread && !activeThread.thread.anchorBlockId;
  const activeAnchored =
    !!activeThread &&
    typeof document !== "undefined" &&
    !activePageThread &&
    activeThread.el !== editorWrapEl &&
    activeThread.el !== document.body &&
    document.contains(activeThread.el);
  const railExpandsActive = railHasRoom && activeAnchored;

  return (
    <div ref={setEditorWrap} className="doc-collab-editor relative">
      {/* Page-level comment index — hides itself on a page with no comments
          (it owns its right-aligned flow row above the composer band, so an
          empty page leaves no gap). `hasOpenThreads` lets it appear in sync
          with the gutter badges rather than after its own fetch. */}
      {viewId ? (
        <CommentThreadList
          pageId={viewId}
          liveAnchorIds={liveAnchorIds}
          onPick={openThreadFromList}
          refreshKey={commentsRefreshKey}
          hasOpenThreads={threads.length > 0}
        />
      ) : null}
      {viewId ? (
        <PageComments
          pageId={viewId}
          workspaceId={ws.workspaceId}
          assistantId={canComment ? assistantId : undefined}
          currentUser={user}
          assistant={assistant}
          threads={threads}
          onPick={openThreadFromList}
          onSubmitted={addPostedPageThread}
          onThreadChanged={refetchThreads}
        />
      ) : null}
      {!synced ? <EditorSkeleton overlay /> : null}
      {canEdit ? (
        <FloatingToolbar
          editor={editor}
          onComment={canComment ? onComment : undefined}
        />
      ) : null}
      {/* Top-level block reorder (drag) + the block-action menu (click).
          PM-transaction moves sync through Yjs — see drag-handle.tsx.
          Read-only viewers don't get the handle. */}
      {canEdit ? (
        <DocDragHandle
          editor={editor}
          onComment={canComment ? onComment : undefined}
          onBlockComment={canComment ? onBlockComment : undefined}
          workspaceId={ws.workspaceId}
          pageId={viewId ?? ""}
        />
      ) : null}
      {/* Drafting indicator (when a landing build is running this page) sits
          at the top of the content body, right where the blocks stream in. */}
      {buildSlot}
      <EditorContent editor={editor} />
      {viewId ? (
        <CommentRail
          threads={openThreads}
          railLeft={railLeft}
          hasRoom={railHasRoom}
          refreshKey={commentsRefreshKey}
          activeThreadId={activeThread?.thread.id ?? null}
          activeSeed={activeThread?.seed}
          onExpand={expandThreadInRail}
          onCollapse={() => setActiveThread(null)}
          pageId={viewId}
          workspaceId={ws.workspaceId}
          assistantId={assistantId ?? ""}
          currentUser={user}
          assistant={assistant}
          onChanged={refetchThreads}
        />
      ) : null}
      {/* On-content overlay — the fallback shell when the rail can't host the
          active thread (no margin room, or an orphaned thread). Page-level
          threads are excluded: they render inline in the page-comments band. */}
      {activeThread && !railExpandsActive && !activePageThread ? (
        <CommentThreadPopover
          thread={activeThread.thread}
          anchorEl={activeThread.el}
          pageId={viewId ?? ""}
          workspaceId={ws.workspaceId}
          assistantId={assistantId ?? ""}
          currentUser={user}
          assistant={assistant}
          seed={activeThread.seed}
          onClose={() => setActiveThread(null)}
          onChanged={refetchThreads}
        />
      ) : null}
      {/* New-comment draft composer — a pure-UI overlay anchored to the local
          draft highlight. It commits (mints the thread + first comment) only on
          send; dismissing leaves the backend + Yjs doc untouched. */}
      {draftComment && draftComment.el ? (
        <NewCommentPopover
          anchorEl={draftComment.el}
          quote={draftComment.quote}
          workspaceId={ws.workspaceId}
          hasAssistant={!!assistantId}
          onSubmit={(payload) => void commitDraftComment(payload)}
          onDismiss={dismissDraftComment}
        />
      ) : null}
      {/* "Link to page" picker — chooses an existing page; on pick we drop an
          inline `child_page` link at the caret the slash menu was invoked on. */}
      {pagePicker && editor ? (
        <PagePicker
          workspaceId={ws.workspaceId}
          position={{ top: pagePicker.top, left: pagePicker.left }}
          onPick={(page: PageMentionItem) => {
            insertChildPageEmbed(editor, pagePicker.insertPos, page.id);
            setPagePicker(null);
          }}
          onClose={() => setPagePicker(null)}
        />
      ) : null}
      {/* "Template" slash item — the centered page-template gallery. On pick we
          instantiate the chosen starter and drop its blocks at the caret the
          slash menu was invoked on. */}
      {templateGallery && editor ? (
        <TemplateGallery
          customTemplates={customTemplates}
          onPick={(templateId) => {
            insertTemplate(editor, templateGallery.insertPos, templateId);
            setTemplateGallery(null);
          }}
          onPickCustom={(templateId) => {
            const pos = templateGallery.insertPos;
            setTemplateGallery(null);
            void insertCustomTemplate(editor, pos, templateId);
          }}
          onDeleteCustom={(templateId) => {
            void deleteCustomPageTemplate(ws.workspaceId, templateId).then(
              refreshCustomTemplates,
            );
          }}
          onNewTemplate={() => {
            setTemplateGallery(null);
            onNewTemplate?.();
          }}
          onClose={() => {
            setTemplateGallery(null);
            editor.commands.focus();
          }}
        />
      ) : null}
      {/* Empty-line "Space for AI" — the inline AI composer at the caret. On
          send it seeds an anchored autoSend turn; the generated blocks stream
          into the page after this line via Yjs. */}
      {aiPrompt ? (
        <InlineAiPrompt
          key={aiPrompt.blockId}
          workspaceId={ws.workspaceId}
          viewId={viewId ?? null}
          anchorBlockId={aiPrompt.blockId}
          position={{ top: aiPrompt.top, left: aiPrompt.left, width: aiPrompt.width }}
          onSubmit={() => {
            // Hand off to the in-flow "Generating…" widget at this line, then
            // close the floating composer.
            setGeneratingBlockId(aiPrompt.blockId);
            setAiPrompt(null);
          }}
          onClose={() => {
            setAiPrompt(null);
            editor?.commands.focus();
          }}
        />
      ) : null}
    </div>
  );
}

function EditorSkeleton({ overlay }: { overlay?: boolean }) {
  return (
    <div
      aria-hidden
      className={
        overlay
          ? "pointer-events-none absolute inset-0 z-10 bg-background/40"
          : "space-y-2 py-2"
      }
    >
      {!overlay ? (
        <>
          <div className="h-7 w-1/3 animate-pulse rounded bg-muted" />
          <div className="h-4 w-2/3 animate-pulse rounded bg-muted" />
          <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        </>
      ) : null}
    </div>
  );
}
