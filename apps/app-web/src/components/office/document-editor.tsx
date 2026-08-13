"use client";

/** One character-collaborative Tiptap editor for canonical Office Document. [COMP:app-web/office-document-editor] */
import { useEffect, useMemo, useRef, useState } from "react";
import * as Y from "yjs";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCursor } from "@tiptap/extension-collaboration-cursor";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import {
  ensureDocumentFragment,
  attachDocumentResource,
  getDocumentFragment,
  snapshotToYDoc,
  type DocumentSnapshot,
  type OfficeCommand,
  type OfficeResourceRef,
} from "@use-brian/office-model";
import { useT } from "@/lib/i18n/client";
import type { UserInfo } from "@/lib/user";
import { admitOfficeImageResource, type OfficeCommentThread, type OfficeSuggestion } from "@/lib/office/api";
import { getOfficeResourceObjectUrl } from "@/lib/office/api";
import { officeDocumentEditorExtensions } from "./document/editor-schema";
import { DocumentToolbar, type DocumentToolbarController } from "./document/document-toolbar";
import { changeDocumentListLevel, convertDocumentList, insertDocumentImage, moveDocumentTableCell, toggleDocumentRunStyle, updateSelectedDocumentNode } from "./document/editor-actions";
import { captureDocumentCommentAnchor, captureDocumentSuggestionRange, type DocumentCommentAnchor, type DocumentSuggestionRange } from "./document/comment-anchor";
import { updateDocumentReviewDecorations } from "./document/comment-decorations";

type DocumentEditorProps = {
  snapshot: DocumentSnapshot;
  baseVersion: number;
  role: "view" | "comment" | "edit";
  suggestMode: boolean;
  doc?: Y.Doc | null;
  provider?: HocuspocusProvider | null;
  currentUser?: UserInfo | null;
  synced?: boolean;
  onCommand(command: OfficeCommand): void;
  onSelectTargets?(ids: string[]): void;
  onSelectCommentAnchor?(anchor: DocumentCommentAnchor | null): void;
  onSelectSuggestionRange?(range: DocumentSuggestionRange | null): void;
  commentThreads?: OfficeCommentThread[];
  suggestions?: OfficeSuggestion[];
};

const NO_COMMENT_THREADS: OfficeCommentThread[] = [];
const NO_SUGGESTIONS: OfficeSuggestion[] = [];

function collaboratorColor(id: string): string {
  const palette = ["#2563EB", "#7C3AED", "#DB2777", "#0F766E", "#B45309", "#DC2626"];
  let value = 0;
  for (const character of id) value = (value * 31 + character.charCodeAt(0)) >>> 0;
  return palette[value % palette.length];
}

export function DocumentEditor({ snapshot, role, suggestMode, doc, provider, currentUser, synced = true, onSelectTargets, onSelectCommentAnchor, onSelectSuggestionRange, commentThreads = NO_COMMENT_THREADS, suggestions = NO_SUGGESTIONS }: DocumentEditorProps) {
  const t = useT().office;
  const localDoc = useMemo(() => snapshotToYDoc(snapshot), [snapshot.artifactId]);
  const activeDoc = doc ?? localDoc;
  const [fragmentReady, setFragmentReady] = useState(() => !doc);
  const [status, setStatus] = useState<string | null>(null);
  const toolbarRef = useRef<DocumentToolbarController | null>(null);

  useEffect(() => {
    if (!doc) { setFragmentReady(true); return; }
    try {
      ensureDocumentFragment(doc);
      setFragmentReady(true);
    } catch {
      setFragmentReady(false);
    }
  }, [doc, synced]);

  const fragment = fragmentReady ? getDocumentFragment(activeDoc) : getDocumentFragment(localDoc);
  const extensions = useMemo(() => {
    const configured = [
      ...officeDocumentEditorExtensions(),
      Collaboration.configure({ fragment }),
    ];
    if (provider) configured.push(CollaborationCursor.configure({
      provider,
      user: {
        id: currentUser?.id ?? "guest",
        name: currentUser?.name || currentUser?.email || t.collaborator,
        color: collaboratorColor(currentUser?.id ?? currentUser?.email ?? "guest"),
      },
    }));
    return configured;
  }, [currentUser?.email, currentUser?.id, currentUser?.name, fragment, provider, t.collaborator]);

  const editable = fragmentReady && role === "edit" && !suggestMode;
  const editor = useEditor({
    extensions,
    editable,
    immediatelyRender: false,
    editorProps: {
      attributes: {
        class: "office-document-prosemirror outline-none",
        role: "textbox",
        "aria-label": t.documentEditor,
        "aria-multiline": "true",
        spellcheck: "true",
      },
      transformPastedText: (text) => text.replace(/\r\n?/g, "\n"),
      handlePaste: (_view, event) => {
        const html = event.clipboardData?.getData("text/html") ?? "";
        const plain = event.clipboardData?.getData("text/plain") ?? "";
        if (!html) return false;
        if (!/<(figure|iframe|svg|canvas|math|form|input|button|video|audio)\b/i.test(html)) return false;
        event.preventDefault();
        if (!plain.trim()) {
          setStatus(t.pasteRefused);
          return true;
        }
        editor?.commands.insertContent(plain.replace(/\r\n?/g, "\n"));
        setStatus(t.formattingRemoved);
        return true;
      },
    },
    onSelectionUpdate: ({ editor: current }) => {
      const ids: string[] = [];
      for (let depth = current.state.selection.$from.depth; depth >= 0; depth -= 1) {
        const id = current.state.selection.$from.node(depth).attrs.id;
        if (typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) { ids.push(id); break; }
      }
      onSelectTargets?.(ids);
      onSelectCommentAnchor?.(captureDocumentCommentAnchor(current));
      onSelectSuggestionRange?.(captureDocumentSuggestionRange(current));
    },
  }, [activeDoc.clientID, fragmentReady, provider]);

  useEffect(() => { editor?.setEditable(editable); }, [editable, editor]);
  useEffect(() => { if (editor) updateDocumentReviewDecorations(editor, commentThreads, suggestions); }, [commentThreads, editor, suggestions]);
  useEffect(() => () => localDoc.destroy(), [localDoc]);

  useEffect(() => {
    if (!editor) return;
    let generation = 0;
    const refresh = () => {
      const activeGeneration = ++generation;
      editor.state.doc.descendants((node) => {
        if (node.type.name !== "officeSection" || typeof node.attrs.id !== "string") return;
        const section = editor.view.dom.querySelector<HTMLElement>(`section[id="${node.attrs.id}"]`);
        const header = section?.querySelector<HTMLElement>(".office-document-header");
        if (!header) return;
        const headerImage = node.attrs.headerImage as Record<string, unknown> | null;
        header.style.backgroundImage = "";
        header.removeAttribute("aria-label");
        header.removeAttribute("role");
        if (!headerImage || typeof headerImage.resourceId !== "string") return;
        const alt = headerImage.decorative ? "" : String(headerImage.altText ?? "");
        if (alt) { header.setAttribute("role", "img"); header.setAttribute("aria-label", alt); }
        header.style.backgroundSize = `${Number(headerImage.widthPt ?? 96)}pt ${Number(headerImage.heightPt ?? 48)}pt`;
        void getOfficeResourceObjectUrl(snapshot.artifactId, headerImage.resourceId).then((url) => {
          if (activeGeneration === generation) header.style.backgroundImage = `url("${url.replaceAll('"', '%22')}")`;
        }).catch(() => undefined);
      });
    };
    refresh();
    editor.on("transaction", refresh);
    return () => { generation += 1; editor.off("transaction", refresh); };
  }, [editor, snapshot.artifactId]);

  useEffect(() => {
    if (!editor) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Tab" && editable) {
        if (moveDocumentTableCell(editor, event.shiftKey ? -1 : 1)) {
          event.preventDefault();
          return;
        }
        if (selectedList(editor)) {
          event.preventDefault();
          changeDocumentListLevel(editor, event.shiftKey ? -1 : 1);
          return;
        }
      }
      if (!(event.metaKey || event.ctrlKey)) return;
      const key = event.key.toLowerCase();
      if (key === "f") {
        event.preventDefault();
        toolbarRef.current?.openFind();
      } else if (key === "k" && !editor.state.selection.empty && editable) {
        event.preventDefault();
        toolbarRef.current?.editLink();
      } else if (event.shiftKey && key === "7" && editable) {
        event.preventDefault();
        convertDocumentList(editor, true);
      } else if (event.shiftKey && key === "8" && editable) {
        event.preventDefault();
        convertDocumentList(editor, false);
      }
    };
    const element = editor.view.dom;
    element.addEventListener("keydown", onKeyDown);
    return () => element.removeEventListener("keydown", onKeyDown);
  }, [editable, editor]);

  useEffect(() => {
    if (!status) return;
    const timeout = window.setTimeout(() => setStatus(null), 4_000);
    return () => window.clearTimeout(timeout);
  }, [status]);

  if (!fragmentReady) return <div className="m-auto text-sm text-muted-foreground" role="status">{t.editorLoading}</div>;

  async function addImage(file: File, placement: "body" | "header" = "body") {
    if (!editable || !editor) return;
    try {
      const uploaded = await admitOfficeImageResource(snapshot.artifactId, snapshot.workspaceId, file);
      attachDocumentResource(activeDoc, uploaded.resource, "manual");
      if (placement === "header") {
        setDocumentHeaderImage(editor, {
          resourceId: uploaded.resource.id,
          altText: file.name.replace(/\.[^.]+$/, ""),
          decorative: false,
          widthPt: Math.max(1, uploaded.widthPx * 0.75),
          heightPt: Math.max(1, uploaded.heightPx * 0.75),
        });
        return;
      }
      const selected = updateImageResource(editor, uploaded.resource);
      if (!selected) insertDocumentImage(editor, {
        resourceId: uploaded.resource.id,
        altText: file.name.replace(/\.[^.]+$/, ""),
        decorative: false,
        widthPt: Math.max(1, uploaded.widthPx * 0.75),
        heightPt: Math.max(1, uploaded.heightPx * 0.75),
      });
    } catch {
      setStatus(t.documentImageUploadFailed);
    }
  }

  return <div className="relative flex min-h-0 flex-1 flex-col" data-office-editor="document" data-office-artifact-id={snapshot.artifactId} data-office-structured-editor="true">
    <DocumentToolbar editor={editor} editable={editable} onInsertImage={addImage} controllerRef={toolbarRef} />
    {suggestMode ? <div className="border-b bg-amber-50 px-3 py-1 text-xs font-medium text-amber-950" role="status">{t.suggesting}</div> : null}
    {status ? <div className="absolute bottom-16 left-1/2 z-50 max-w-sm -translate-x-1/2 rounded-lg bg-foreground px-3 py-2 text-xs text-background shadow-lg sm:bottom-4" role="status">{status}</div> : null}
    <div data-office-document-scroll="true" className="min-h-0 flex-1 overflow-auto bg-muted/30 px-2 pb-20 pt-4 sm:px-4 sm:pb-4">
      <EditorContent editor={editor} className="mx-auto max-w-full" />
    </div>
  </div>;
}

function selectedList(editor: Editor): boolean {
  const $from = editor.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) if ($from.node(depth).type.name === "officeList") return true;
  return false;
}

export { toggleDocumentRunStyle };

function updateImageResource(editor: Editor, resource: OfficeResourceRef): boolean {
  const selected = editor.state.selection.$from.nodeAfter?.type.name === "officeImage" || editor.state.selection.$from.node(editor.state.selection.$from.depth).type.name === "officeImage";
  if (!selected) return false;
  updateSelectedDocumentNode(editor, "officeImage", { resourceId: resource.id });
  return true;
}

function setDocumentHeaderImage(editor: Editor, headerImage: Record<string, unknown>): void {
  const $from = editor.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    if ($from.node(depth).type.name !== "officeSection") continue;
    editor.view.dispatch(editor.state.tr.setNodeMarkup($from.before(depth), undefined, { ...$from.node(depth).attrs, headerImage }).scrollIntoView());
    editor.commands.focus();
    return;
  }
}
