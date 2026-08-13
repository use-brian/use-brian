"use client";

/** One character-collaborative Tiptap editor for canonical Office Document. [COMP:app-web/office-document-editor] */
import { useEffect, useMemo, useState } from "react";
import * as Y from "yjs";
import { Bold, Italic, Redo2, Strikethrough, Underline, Undo2 } from "lucide-react";
import { EditorContent, useEditor, type Editor } from "@tiptap/react";
import { Collaboration } from "@tiptap/extension-collaboration";
import { CollaborationCursor } from "@tiptap/extension-collaboration-cursor";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import {
  ensureDocumentFragment,
  getDocumentFragment,
  snapshotToYDoc,
  type DocumentSnapshot,
  type OfficeCommand,
  type OfficeRichTextRun,
} from "@use-brian/office-model";
import { useT } from "@/lib/i18n/client";
import type { UserInfo } from "@/lib/user";
import { cn } from "@/lib/utils";
import { officeDocumentEditorExtensions } from "./document/editor-schema";

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
};

function collaboratorColor(id: string): string {
  const palette = ["#2563EB", "#7C3AED", "#DB2777", "#0F766E", "#B45309", "#DC2626"];
  let value = 0;
  for (const character of id) value = (value * 31 + character.charCodeAt(0)) >>> 0;
  return palette[value % palette.length];
}

export function DocumentEditor({ snapshot, role, suggestMode, doc, provider, currentUser, synced = true, onSelectTargets }: DocumentEditorProps) {
  const t = useT().office;
  const localDoc = useMemo(() => snapshotToYDoc(snapshot), [snapshot.artifactId]);
  const activeDoc = doc ?? localDoc;
  const [fragmentReady, setFragmentReady] = useState(() => !doc);

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
    },
    onSelectionUpdate: ({ editor: current }) => {
      const ids: string[] = [];
      for (let depth = current.state.selection.$from.depth; depth >= 0; depth -= 1) {
        const id = current.state.selection.$from.node(depth).attrs.id;
        if (typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) { ids.push(id); break; }
      }
      onSelectTargets?.(ids);
    },
  }, [activeDoc.clientID, fragmentReady, provider]);

  useEffect(() => { editor?.setEditable(editable); }, [editable, editor]);
  useEffect(() => () => localDoc.destroy(), [localDoc]);

  if (!fragmentReady) return <div className="m-auto text-sm text-muted-foreground" role="status">{t.editorLoading}</div>;

  return <div className="flex min-h-0 flex-1 flex-col" data-office-editor="document" data-office-structured-editor="true">
    <DocumentToolbar editor={editor} editable={editable} />
    {suggestMode ? <div className="border-b bg-amber-50 px-3 py-1 text-xs font-medium text-amber-950" role="status">{t.suggesting}</div> : null}
    <div data-office-document-scroll="true" className="min-h-0 flex-1 overflow-auto bg-muted/30 px-2 py-4 sm:px-4">
      <EditorContent editor={editor} className="mx-auto max-w-full" />
    </div>
  </div>;
}

function DocumentToolbar({ editor, editable }: { editor: Editor | null; editable: boolean }) {
  const t = useT().office;
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const refresh = () => setRevision((value) => value + 1);
    editor.on("selectionUpdate", refresh);
    editor.on("transaction", refresh);
    return () => { editor.off("selectionUpdate", refresh); editor.off("transaction", refresh); };
  }, [editor]);
  void revision;
  const canFormat = editable && Boolean(editor && !editor.state.selection.empty);

  return <div className="sticky top-0 z-10 flex flex-wrap items-center gap-1 border-b bg-background/95 p-2 backdrop-blur" role="toolbar" aria-label={t.editorToolbar}>
    <ToolbarButton label={t.undo} disabled={!editable || !editor?.can().undo()} pressed={false} onClick={() => editor?.chain().focus().undo().run()} icon={<Undo2 className="size-4" />} />
    <ToolbarButton label={t.redo} disabled={!editable || !editor?.can().redo()} pressed={false} onClick={() => editor?.chain().focus().redo().run()} icon={<Redo2 className="size-4" />} />
    <span className="mx-1 h-5 border-l" aria-hidden />
    <ToolbarButton label={t.bold} disabled={!canFormat} pressed={selectionHasStyle(editor, "bold")} onClick={() => toggleDocumentRunStyle(editor, "bold")} icon={<Bold className="size-4" />} />
    <ToolbarButton label={t.italic} disabled={!canFormat} pressed={selectionHasStyle(editor, "italic")} onClick={() => toggleDocumentRunStyle(editor, "italic")} icon={<Italic className="size-4" />} />
    <ToolbarButton label={t.underline} disabled={!canFormat} pressed={selectionHasStyle(editor, "underline")} onClick={() => toggleDocumentRunStyle(editor, "underline")} icon={<Underline className="size-4" />} />
    <ToolbarButton label={t.strike} disabled={!canFormat} pressed={selectionHasStyle(editor, "strike")} onClick={() => toggleDocumentRunStyle(editor, "strike")} icon={<Strikethrough className="size-4" />} />
  </div>;
}

type BooleanRunStyle = "bold" | "italic" | "underline" | "strike";

function selectedRunStyles(editor: Editor | null): OfficeRichTextRun["style"][] {
  if (!editor || editor.state.selection.empty) return [];
  const styles: OfficeRichTextRun["style"][] = [];
  const { from, to } = editor.state.selection;
  editor.state.doc.nodesBetween(from, to, (node) => {
    if (!node.isText) return;
    const mark = node.marks.find((candidate) => candidate.type.name === "officeRun");
    if (mark?.attrs.style) styles.push(mark.attrs.style as OfficeRichTextRun["style"]);
  });
  return styles;
}

function selectionHasStyle(editor: Editor | null, field: BooleanRunStyle): boolean {
  const styles = selectedRunStyles(editor);
  return styles.length > 0 && styles.every((style) => style[field]);
}

export function toggleDocumentRunStyle(editor: Editor | null, field: BooleanRunStyle): void {
  if (!editor || editor.state.selection.empty) return;
  const nextValue = !selectionHasStyle(editor, field);
  const { from, to } = editor.state.selection;
  const transaction = editor.state.tr;
  editor.state.doc.nodesBetween(from, to, (node, position) => {
    if (!node.isText) return;
    const mark = node.marks.find((candidate) => candidate.type.name === "officeRun");
    if (!mark) return;
    const start = Math.max(from, position);
    const end = Math.min(to, position + node.nodeSize);
    if (start >= end) return;
    const { href, ...markAttrs } = mark.attrs;
    transaction.addMark(start, end, editor.schema.marks.officeRun.create({
      ...markAttrs,
      ...(href ? { href } : {}),
      id: crypto.randomUUID(),
      style: { ...(mark.attrs.style as OfficeRichTextRun["style"]), [field]: nextValue },
    }));
  });
  editor.view.dispatch(transaction.scrollIntoView());
  editor.commands.focus();
}

function ToolbarButton({ label, icon, disabled, pressed, onClick }: { label: string; icon: React.ReactNode; disabled: boolean; pressed: boolean; onClick(): void }) {
  return <button type="button" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick} className={cn("rounded p-2 hover:bg-muted disabled:opacity-40", pressed && "bg-muted text-primary")}>{icon}</button>;
}
