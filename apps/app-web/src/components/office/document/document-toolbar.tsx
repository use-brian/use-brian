"use client";

/** Adaptive Document formatting, structure, and productivity controls. [COMP:app-web/office-document-editor] */
import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/react";
import {
  AlignCenter, AlignJustify, AlignLeft, AlignRight, Bold, ChevronDown, ChevronLeft, ChevronRight,
  FileSearch, Highlighter, Image as ImageIcon, IndentDecrease, IndentIncrease, Italic, Link,
  List, ListOrdered, MoreHorizontal, Pilcrow, Redo2, RemoveFormatting, Search, Strikethrough,
  Table2, Underline, Undo2,
} from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  applyDocumentRunFormatting, changeDocumentListLevel, clearDocumentRunFormatting, convertDocumentList,
  currentDocumentSectionAttributes, deleteSelectedDocumentNode, documentProductivity, documentSelectionFormatting,
  documentSelectionHasStyle, findDocumentText, focusDocumentHeading, insertDocumentBreak, insertDocumentTable,
  replaceDocumentText, runDocumentTableAction, selectedDocumentNode, setDocumentBlockAttributes,
  setDocumentBlockStyle, setDocumentCellAttributes, setDocumentSectionAttributes, setDocumentTableAttributes,
  toggleDocumentRunStyle, updateSelectedDocumentNode, type DocumentAlignment, type DocumentBlockStyle,
} from "./editor-actions";

const FONTS = ["Arial", "Aptos", "Calibri", "Georgia", "Times New Roman"];
const FONT_SIZES = [8, 9, 10, 11, 12, 14, 18, 24, 36, 48, 72];
const BLOCK_STYLES: DocumentBlockStyle[] = ["Body", "Title", "Subtitle", "Heading 1", "Heading 2", "Heading 3", "Heading 4", "Heading 5", "Heading 6"];
const PAGE_SIZES = {
  letter: { widthPt: 612, heightPt: 792 },
  a4: { widthPt: 595.28, heightPt: 841.89 },
  legal: { widthPt: 612, heightPt: 1008 },
} as const;
const BORDER = { color: "#B7B7B7", widthPt: 0.75, style: "solid" as const };

export type DocumentToolbarController = {
  openFind(): void;
  editLink(): void;
};

export function DocumentToolbar({ editor, editable, onInsertImage, controllerRef }: {
  editor: Editor | null;
  editable: boolean;
  onInsertImage(file: File, placement?: "body" | "header"): void | Promise<void>;
  controllerRef: React.MutableRefObject<DocumentToolbarController | null>;
}) {
  const t = useT().office;
  const [revision, setRevision] = useState(0);
  const [findOpen, setFindOpen] = useState(false);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [countsOpen, setCountsOpen] = useState(false);
  const imageInput = useRef<HTMLInputElement>(null);
  const headerImageInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!editor) return;
    const refresh = () => setRevision((value) => value + 1);
    editor.on("selectionUpdate", refresh);
    editor.on("transaction", refresh);
    return () => { editor.off("selectionUpdate", refresh); editor.off("transaction", refresh); };
  }, [editor]);
  void revision;

  async function editLink() {
    if (!editor || editor.state.selection.empty) return;
    const selection = { from: editor.state.selection.from, to: editor.state.selection.to };
    const current = documentSelectionFormatting(editor).find((style) => style.href)?.href ?? "";
    const value = await promptDialog({
      title: t.editLink,
      description: t.linkDescription,
      defaultValue: current,
      placeholder: "https://",
      confirmLabel: t.apply,
      cancelLabel: t.cancel,
      allowEmpty: true,
      emptyConfirmLabel: t.removeLink,
    });
    if (value === null) return;
    editor.commands.setTextSelection(selection);
    if (value && !/^(https:|mailto:)/.test(value)) return;
    applyDocumentRunFormatting(editor, { href: value || null, ...(value ? { underline: true } : {}) });
  }

  useEffect(() => {
    controllerRef.current = { openFind: () => setFindOpen(true), editLink: () => void editLink() };
    return () => { controllerRef.current = null; };
  });

  const common = { editor, editable, onInsertImage: () => imageInput.current?.click(), onInsertHeaderImage: () => headerImageInput.current?.click(), editLink, setFindOpen, setOutlineOpen, setCountsOpen };
  return <>
    <div className="hidden border-b bg-background/95 backdrop-blur sm:block" data-document-toolbar-surface="desktop-tablet">
      <ToolbarContent {...common} />
    </div>
    <div className="fixed inset-x-2 bottom-2 z-30 rounded-xl border bg-background/95 shadow-xl backdrop-blur sm:hidden" data-document-toolbar-surface="phone">
      <div className="overflow-x-auto"><ToolbarContent {...common} compact /></div>
    </div>
    <input ref={imageInput} type="file" accept="image/png,image/jpeg" className="sr-only" aria-label={t.documentInsertImage} onChange={(event) => {
      const file = event.target.files?.[0];
      if (file) void onInsertImage(file);
      event.target.value = "";
    }} />
    <input ref={headerImageInput} type="file" accept="image/png,image/jpeg" className="sr-only" aria-label={t.headerImage} onChange={(event) => {
      const file = event.target.files?.[0];
      if (file) void onInsertImage(file, "header");
      event.target.value = "";
    }} />
    {findOpen ? <FindReplacePanel editor={editor} editable={editable} onClose={() => setFindOpen(false)} /> : null}
    {outlineOpen ? <OutlinePanel editor={editor} onClose={() => setOutlineOpen(false)} /> : null}
    {countsOpen ? <WordCountPanel editor={editor} onClose={() => setCountsOpen(false)} /> : null}
  </>;
}

function ToolbarContent({ editor, editable, compact = false, onInsertImage, onInsertHeaderImage, editLink, setFindOpen, setOutlineOpen, setCountsOpen }: {
  editor: Editor | null; editable: boolean; compact?: boolean; onInsertImage(): void; onInsertHeaderImage(): void; editLink(): void;
  setFindOpen(value: boolean): void; setOutlineOpen(value: boolean): void; setCountsOpen(value: boolean): void;
}) {
  const t = useT().office;
  const selection = documentSelectionFormatting(editor);
  const first = selection[0];
  const canFormat = editable && Boolean(editor && !editor.state.selection.empty);
  const section = currentDocumentSectionAttributes(editor);
  const table = selectedDocumentNode(editor, "officeTable");
  const image = selectedDocumentNode(editor, "officeImage");
  const blockStyle = currentBlockStyle(editor);

  return <div className={cn("flex min-w-max items-center gap-1 px-2 py-1.5", compact && "min-h-12")} role="toolbar" aria-label={t.editorToolbar}>
    <ToolbarButton label={t.undo} disabled={!editable || !editor?.can().undo()} pressed={false} onClick={() => editor?.chain().focus().undo().run()} icon={<Undo2 />} />
    <ToolbarButton label={t.redo} disabled={!editable || !editor?.can().redo()} pressed={false} onClick={() => editor?.chain().focus().redo().run()} icon={<Redo2 />} />
    <Divider />
    <Select value={blockStyle} onValueChange={(value) => value && setDocumentBlockStyle(editor, value as DocumentBlockStyle)} disabled={!editable}>
      <SelectTrigger size="sm" className="w-28" aria-label={t.paragraphStyle}><SelectValue /></SelectTrigger>
      <SelectContent>{BLOCK_STYLES.map((value) => <SelectItem key={value} value={value}>{blockStyleLabel(value, t)}</SelectItem>)}</SelectContent>
    </Select>
    {!compact ? <>
      <Select value={first?.fontFamily ?? null} onValueChange={(value) => value && applyDocumentRunFormatting(editor, { fontFamily: value })} disabled={!canFormat}>
        <SelectTrigger size="sm" className="w-28" aria-label={t.fontFamily}><SelectValue placeholder={t.mixedValue} /></SelectTrigger>
        <SelectContent>{FONTS.map((font) => <SelectItem key={font} value={font}>{font}</SelectItem>)}</SelectContent>
      </Select>
      <Select value={first?.fontSizePt ? String(first.fontSizePt) : null} onValueChange={(value) => value && applyDocumentRunFormatting(editor, { fontSizePt: Number(value) })} disabled={!canFormat}>
        <SelectTrigger size="sm" className="w-16" aria-label={t.fontSize}><SelectValue placeholder={t.mixedValue} /></SelectTrigger>
        <SelectContent>{FONT_SIZES.map((size) => <SelectItem key={size} value={String(size)}>{size}</SelectItem>)}</SelectContent>
      </Select>
    </> : null}
    <ToolbarButton label={t.bold} disabled={!canFormat} pressed={documentSelectionHasStyle(editor, "bold")} onClick={() => toggleDocumentRunStyle(editor, "bold")} icon={<Bold />} />
    <ToolbarButton label={t.italic} disabled={!canFormat} pressed={documentSelectionHasStyle(editor, "italic")} onClick={() => toggleDocumentRunStyle(editor, "italic")} icon={<Italic />} />
    <ToolbarButton label={t.underline} disabled={!canFormat} pressed={documentSelectionHasStyle(editor, "underline")} onClick={() => toggleDocumentRunStyle(editor, "underline")} icon={<Underline />} />
    <ToolbarButton label={t.strike} disabled={!canFormat} pressed={documentSelectionHasStyle(editor, "strike")} onClick={() => toggleDocumentRunStyle(editor, "strike")} icon={<Strikethrough />} />
    {!compact ? <>
      <ColorInput label={t.textColor} value={first?.color ?? "#111111"} disabled={!canFormat} onValue={(color) => applyDocumentRunFormatting(editor, { color })} />
      <ColorInput label={t.highlightColor} value={first?.highlight ?? "#FFF2CC"} disabled={!canFormat} onValue={(highlight) => applyDocumentRunFormatting(editor, { highlight })} icon={<Highlighter />} />
      <ToolbarButton label={t.hyperlink} disabled={!canFormat} pressed={Boolean(first?.href)} onClick={editLink} icon={<Link />} />
      <ToolbarButton label={t.clearFormatting} disabled={!canFormat} pressed={false} onClick={() => clearDocumentRunFormatting(editor)} icon={<RemoveFormatting />} />
      <Divider />
      <ToolbarButton label={t.alignLeft} disabled={!editable} pressed={currentAlignment(editor) === "start"} onClick={() => setDocumentBlockAttributes(editor, { alignment: "start" })} icon={<AlignLeft />} />
      <ToolbarButton label={t.alignCenter} disabled={!editable} pressed={currentAlignment(editor) === "center"} onClick={() => setDocumentBlockAttributes(editor, { alignment: "center" })} icon={<AlignCenter />} />
      <ToolbarButton label={t.alignRight} disabled={!editable} pressed={currentAlignment(editor) === "end"} onClick={() => setDocumentBlockAttributes(editor, { alignment: "end" })} icon={<AlignRight />} />
      <ToolbarButton label={t.justify} disabled={!editable} pressed={currentAlignment(editor) === "justify"} onClick={() => setDocumentBlockAttributes(editor, { alignment: "justify" })} icon={<AlignJustify />} />
      <SpacingMenu editor={editor} editable={editable} />
    </> : null}
    <ToolbarButton label={t.addBulletList} disabled={!editable} pressed={Boolean(selectedDocumentNode(editor, "officeList")?.node.attrs.ordered === false)} onClick={() => convertDocumentList(editor, false)} icon={<List />} />
    <ToolbarButton label={t.addNumberedList} disabled={!editable} pressed={Boolean(selectedDocumentNode(editor, "officeList")?.node.attrs.ordered === true)} onClick={() => convertDocumentList(editor, true)} icon={<ListOrdered />} />
    <ToolbarButton label={t.decreaseIndent} disabled={!editable || !selectedDocumentNode(editor, "officeList")} pressed={false} onClick={() => changeDocumentListLevel(editor, -1)} icon={<IndentDecrease />} />
    <ToolbarButton label={t.increaseIndent} disabled={!editable || !selectedDocumentNode(editor, "officeList")} pressed={false} onClick={() => changeDocumentListLevel(editor, 1)} icon={<IndentIncrease />} />
    <InsertMenu editor={editor} editable={editable} onInsertImage={onInsertImage} editLink={editLink} />
    <PageSetupMenu editor={editor} editable={editable} section={section} onInsertHeaderImage={onInsertHeaderImage} />
    {table ? <TableMenu editor={editor} editable={editable} table={table.node} /> : null}
    {image ? <ImageMenu editor={editor} editable={editable} image={image.node} onReplace={onInsertImage} /> : null}
    <DropdownMenu>
      <DropdownMenuTrigger render={<button type="button" className="rounded p-2 hover:bg-muted" aria-label={t.documentTools}><MoreHorizontal className="size-4" /></button>} />
      <DropdownMenuContent align="end">
        {compact ? <>
          <DropdownMenuItem onClick={() => void editLink()} disabled={!canFormat}><Link />{t.hyperlink}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => clearDocumentRunFormatting(editor)} disabled={!canFormat}><RemoveFormatting />{t.clearFormatting}</DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={() => setDocumentBlockAttributes(editor, { alignment: "start" })}><AlignLeft />{t.alignLeft}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDocumentBlockAttributes(editor, { alignment: "center" })}><AlignCenter />{t.alignCenter}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDocumentBlockAttributes(editor, { alignment: "end" })}><AlignRight />{t.alignRight}</DropdownMenuItem>
          <DropdownMenuItem onClick={() => setDocumentBlockAttributes(editor, { alignment: "justify" })}><AlignJustify />{t.justify}</DropdownMenuItem>
          <DropdownMenuSeparator />
        </> : null}
        <DropdownMenuItem onClick={() => setFindOpen(true)}><Search />{t.findReplace}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setOutlineOpen(true)}><FileSearch />{t.documentOutline}</DropdownMenuItem>
        <DropdownMenuItem onClick={() => setCountsOpen(true)}><Pilcrow />{t.wordCount}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

function InsertMenu({ editor, editable, onInsertImage, editLink }: { editor: Editor | null; editable: boolean; onInsertImage(): void; editLink(): void }) {
  const t = useT().office;
  return <DropdownMenu>
    <DropdownMenuTrigger render={<button type="button" disabled={!editable} className="flex h-8 items-center gap-1 rounded px-2 text-xs hover:bg-muted disabled:opacity-40"><span>{t.insert}</span><ChevronDown className="size-3" /></button>} />
    <DropdownMenuContent align="start">
      <DropdownMenuItem onClick={() => void editLink()} disabled={!editor || editor.state.selection.empty}><Link />{t.hyperlink}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => insertDocumentTable(editor)}><Table2 />{t.addTable}</DropdownMenuItem>
      <DropdownMenuItem onClick={onInsertImage}><ImageIcon />{t.documentInsertImage}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => insertDocumentBreak(editor, "page")}>{t.addPageBreak}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => insertDocumentBreak(editor, "section")}>{t.addSectionBreak}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

function SpacingMenu({ editor, editable }: { editor: Editor | null; editable: boolean }) {
  const t = useT().office;
  return <DropdownMenu>
    <DropdownMenuTrigger render={<button type="button" disabled={!editable} className="flex h-8 items-center gap-1 rounded px-2 text-xs hover:bg-muted disabled:opacity-40">{t.spacing}<ChevronDown className="size-3" /></button>} />
    <DropdownMenuContent align="start">
      {[12, 15, 18, 24].map((value) => <DropdownMenuItem key={value} onClick={() => setDocumentBlockAttributes(editor, { lineSpacingPt: value })}>{t.lineSpacingValue.replace("{value}", String(value))}</DropdownMenuItem>)}
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => setDocumentBlockAttributes(editor, { spacingBeforePt: 6 })}>{t.addSpaceBefore}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => setDocumentBlockAttributes(editor, { spacingAfterPt: 6 })}>{t.addSpaceAfter}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => setDocumentBlockAttributes(editor, { spacingBeforePt: undefined, spacingAfterPt: undefined })}>{t.removeParagraphSpacing}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

function PageSetupMenu({ editor, editable, section, onInsertHeaderImage }: { editor: Editor | null; editable: boolean; section: Record<string, unknown> | null; onInsertHeaderImage(): void }) {
  const t = useT().office;
  const page = section?.page as Record<string, number | string> | undefined;
  const showPageNumber = section?.showPageNumber === true;
  function patchPage(patch: Record<string, number | string>) { setDocumentSectionAttributes(editor, { page: { ...page, ...patch } }); }
  return <Popover>
    <PopoverTrigger render={<button type="button" disabled={!editable} className="flex h-8 items-center gap-1 rounded px-2 text-xs hover:bg-muted disabled:opacity-40">{t.pageSetup}<ChevronDown className="size-3" /></button>} />
    <PopoverContent align="start" className="w-72">
      <label className="text-xs font-medium">{t.pageSize}</label>
      <Select value={pageSizeKey(page)} onValueChange={(value) => {
        const size = value ? PAGE_SIZES[value as keyof typeof PAGE_SIZES] : null;
        if (!size) return;
        const landscape = page?.orientation === "landscape";
        patchPage({ widthPt: landscape ? size.heightPt : size.widthPt, heightPt: landscape ? size.widthPt : size.heightPt });
      }}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="letter">{t.pageLetter}</SelectItem><SelectItem value="a4">{t.pageA4}</SelectItem><SelectItem value="legal">{t.pageLegal}</SelectItem></SelectContent></Select>
      <label className="text-xs font-medium">{t.orientation}</label>
      <Select value={String(page?.orientation ?? "portrait")} onValueChange={(value) => {
        if (!value || value === page?.orientation) return;
        patchPage({ orientation: value, widthPt: Number(page?.heightPt), heightPt: Number(page?.widthPt) });
      }}><SelectTrigger className="w-full"><SelectValue /></SelectTrigger><SelectContent><SelectItem value="portrait">{t.portrait}</SelectItem><SelectItem value="landscape">{t.landscape}</SelectItem></SelectContent></Select>
      <div className="grid grid-cols-2 gap-2">
        {(["marginTopPt", "marginRightPt", "marginBottomPt", "marginLeftPt"] as const).map((key) => <label key={key} className="text-xs">{t[key]}<input type="number" min={0} max={500} value={Number(page?.[key] ?? 72)} onChange={(event) => patchPage({ [key]: Number(event.target.value) })} className="mt-1 h-8 w-full rounded border bg-background px-2" /></label>)}
      </div>
      <div className="flex gap-2">
        <button type="button" className="rounded border px-2 py-1.5 text-xs hover:bg-muted" onClick={onInsertHeaderImage}>{section?.headerImage ? t.replaceHeaderImage : t.headerImage}</button>
        {section?.headerImage ? <button type="button" className="rounded border px-2 py-1.5 text-xs hover:bg-muted" onClick={() => setDocumentSectionAttributes(editor, { headerImage: undefined })}>{t.removeHeaderImage}</button> : null}
      </div>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={showPageNumber} onChange={(event) => setDocumentSectionAttributes(editor, { showPageNumber: event.target.checked })} />{t.showPageNumbers}</label>
      <label className="text-xs font-medium">{t.headerFooterAlignment}</label>
      <div className="grid grid-cols-2 gap-2">
        <AlignmentSelect label={t.header} value={String(section?.headerAlignment ?? "start") as DocumentAlignment} onValue={(value) => setDocumentSectionAttributes(editor, { headerAlignment: value })} />
        <AlignmentSelect label={t.footer} value={String(section?.footerAlignment ?? "start") as DocumentAlignment} onValue={(value) => setDocumentSectionAttributes(editor, { footerAlignment: value })} />
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(section?.headerBorderBottom)} onChange={(event) => setDocumentSectionAttributes(editor, { headerBorderBottom: event.target.checked ? { color: BORDER.color, widthPt: BORDER.widthPt } : undefined })} />{t.headerBorder}</label>
        <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={Boolean(section?.footerBorderTop)} onChange={(event) => setDocumentSectionAttributes(editor, { footerBorderTop: event.target.checked ? { color: BORDER.color, widthPt: BORDER.widthPt } : undefined })} />{t.footerBorder}</label>
      </div>
    </PopoverContent>
  </Popover>;
}

function TableMenu({ editor, editable, table }: { editor: Editor | null; editable: boolean; table: import("@tiptap/pm/model").Node }) {
  const t = useT().office;
  return <DropdownMenu>
    <DropdownMenuTrigger render={<button type="button" disabled={!editable} className="flex h-8 items-center gap-1 rounded bg-muted px-2 text-xs disabled:opacity-40"><Table2 className="size-3.5" />{t.tableActions}</button>} />
    <DropdownMenuContent align="start">
      <DropdownMenuItem onClick={() => runDocumentTableAction(editor, "addRow")}>{t.addRow}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => runDocumentTableAction(editor, "deleteRow")}>{t.deleteRow}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => runDocumentTableAction(editor, "addColumn")}>{t.addColumn}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => runDocumentTableAction(editor, "deleteColumn")}>{t.deleteColumn}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => runDocumentTableAction(editor, "mergeCellRight")}>{t.mergeCellRight}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => runDocumentTableAction(editor, "splitCell")}>{t.splitCell}</DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem onClick={() => setDocumentTableAttributes(editor, { headerRows: Number(table.attrs.headerRows ?? 0) ? 0 : 1 })}>{t.toggleHeaderRow}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => setDocumentTableAttributes(editor, { layout: table.attrs.layout === "fixed" ? "autofit" : "fixed" })}>{t.toggleTableLayout}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => setDocumentCellAttributes(editor, { fill: "#FFF2CC" })}>{t.cellShading}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => setDocumentCellAttributes(editor, { borders: { top: BORDER, right: BORDER, bottom: BORDER, left: BORDER } })}>{t.cellBorders}</DropdownMenuItem>
      <DropdownMenuItem onClick={() => setDocumentTableAttributes(editor, { columnWidthsPt: Array.from({ length: Math.max(1, table.firstChild?.childCount ?? 1) }, () => 90) })}>{t.equalColumnWidth}</DropdownMenuItem>
    </DropdownMenuContent>
  </DropdownMenu>;
}

function ImageMenu({ editor, editable, image, onReplace }: { editor: Editor | null; editable: boolean; image: import("@tiptap/pm/model").Node; onReplace(): void }) {
  const t = useT().office;
  const [lockAspectRatio, setLockAspectRatio] = useState(true);
  async function editAlt() {
    const value = await promptDialog({ title: t.altText, description: t.altTextDescription, defaultValue: String(image.attrs.altText ?? ""), confirmLabel: t.apply, cancelLabel: t.cancel, allowEmpty: image.attrs.decorative === true });
    if (value !== null) updateSelectedDocumentNode(editor, "officeImage", { altText: value });
  }
  return <Popover>
    <PopoverTrigger render={<button type="button" disabled={!editable} className="flex h-8 items-center gap-1 rounded bg-muted px-2 text-xs disabled:opacity-40"><ImageIcon className="size-3.5" />{t.imageActions}</button>} />
    <PopoverContent align="start" className="w-64">
      <button type="button" className="rounded border px-2 py-1.5 text-left text-xs hover:bg-muted" onClick={onReplace}>{t.replaceImage}</button>
      <div className="grid grid-cols-2 gap-2">
        <label className="text-xs">{t.imageWidth}<input type="number" min={1} max={10000} value={Number(image.attrs.widthPt ?? 240)} onChange={(event) => {
          const widthPt = Number(event.target.value); const ratio = Number(image.attrs.heightPt ?? 160) / Math.max(1, Number(image.attrs.widthPt ?? 240));
          updateSelectedDocumentNode(editor, "officeImage", { widthPt, ...(lockAspectRatio ? { heightPt: Math.max(1, widthPt * ratio) } : {}) });
        }} className="mt-1 h-8 w-full rounded border px-2" /></label>
        <label className="text-xs">{t.imageHeight}<input type="number" min={1} max={10000} value={Number(image.attrs.heightPt ?? 160)} onChange={(event) => {
          const heightPt = Number(event.target.value); const ratio = Number(image.attrs.widthPt ?? 240) / Math.max(1, Number(image.attrs.heightPt ?? 160));
          updateSelectedDocumentNode(editor, "officeImage", { heightPt, ...(lockAspectRatio ? { widthPt: Math.max(1, heightPt * ratio) } : {}) });
        }} className="mt-1 h-8 w-full rounded border px-2" /></label>
      </div>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={lockAspectRatio} onChange={(event) => setLockAspectRatio(event.target.checked)} />{t.lockAspectRatio}</label>
      <button type="button" className="rounded border px-2 py-1.5 text-left text-xs hover:bg-muted" onClick={() => void editAlt()}>{t.editAltText}</button>
      <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={image.attrs.decorative === true} onChange={(event) => updateSelectedDocumentNode(editor, "officeImage", { decorative: event.target.checked, ...(event.target.checked ? { altText: "" } : {}) })} />{t.decorativeImage}</label>
      <button type="button" className="rounded border border-destructive/30 px-2 py-1.5 text-left text-xs text-destructive hover:bg-destructive/10" onClick={() => deleteSelectedDocumentNode(editor, "officeImage")}>{t.deleteObject}</button>
    </PopoverContent>
  </Popover>;
}

function FindReplacePanel({ editor, editable, onClose }: { editor: Editor | null; editable: boolean; onClose(): void }) {
  const t = useT().office;
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
  const [matchCase, setMatchCase] = useState(false);
  const [matches, setMatches] = useState(0);
  const queryRef = useRef<HTMLInputElement>(null);
  useEffect(() => { queryRef.current?.focus(); }, []);
  return <section className="absolute right-3 top-12 z-40 w-[min(26rem,calc(100%-1.5rem))] rounded-xl border bg-background p-3 shadow-xl" aria-label={t.findReplace} data-document-find-replace="true">
    <div className="flex items-center gap-2"><input ref={queryRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t.findPlaceholder} aria-label={t.find} className="h-8 min-w-0 flex-1 rounded border px-2 text-sm" onKeyDown={(event) => { if (event.key === "Enter") setMatches(findDocumentText(editor, query, event.shiftKey ? -1 : 1, matchCase)); if (event.key === "Escape") onClose(); }} />
      <ToolbarButton label={t.previousMatch} disabled={!query} pressed={false} onClick={() => setMatches(findDocumentText(editor, query, -1, matchCase))} icon={<ChevronLeft />} />
      <ToolbarButton label={t.nextMatch} disabled={!query} pressed={false} onClick={() => setMatches(findDocumentText(editor, query, 1, matchCase))} icon={<ChevronRight />} />
      <button type="button" onClick={onClose} aria-label={t.close} className="rounded p-2 hover:bg-muted">×</button></div>
    <div className="mt-2 flex items-center gap-2"><input value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder={t.replacePlaceholder} aria-label={t.replace} disabled={!editable} className="h-8 min-w-0 flex-1 rounded border px-2 text-sm disabled:opacity-40" />
      <button type="button" disabled={!editable || !query} onClick={() => setMatches(replaceDocumentText(editor, query, replacement, false, matchCase))} className="rounded border px-2 py-1.5 text-xs disabled:opacity-40">{t.replace}</button>
      <button type="button" disabled={!editable || !query} onClick={() => setMatches(replaceDocumentText(editor, query, replacement, true, matchCase))} className="rounded border px-2 py-1.5 text-xs disabled:opacity-40">{t.replaceAll}</button></div>
    <div className="mt-2 flex items-center justify-between text-xs text-muted-foreground"><label className="flex items-center gap-2"><input type="checkbox" checked={matchCase} onChange={(event) => setMatchCase(event.target.checked)} />{t.matchCase}</label><span aria-live="polite">{t.matchesFound.replace("{count}", String(matches))}</span></div>
  </section>;
}

function OutlinePanel({ editor, onClose }: { editor: Editor | null; onClose(): void }) {
  const t = useT().office;
  const { headings } = documentProductivity(editor);
  return <section className="absolute left-3 top-12 z-40 max-h-[70vh] w-72 overflow-y-auto rounded-xl border bg-background p-3 shadow-xl" aria-label={t.documentOutline} data-document-outline="true">
    <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">{t.documentOutline}</h2><button type="button" onClick={onClose} aria-label={t.close}>×</button></div>
    {headings.length ? <ol className="space-y-1">{headings.map((heading) => <li key={heading.id}><button type="button" onClick={() => focusDocumentHeading(editor, heading)} className="w-full truncate rounded px-2 py-1.5 text-left text-xs hover:bg-muted" style={{ paddingInlineStart: `${Math.max(0, heading.level - 1) * 12 + 8}px` }}>{heading.text || t.untitledHeading}</button></li>)}</ol> : <p className="text-xs text-muted-foreground">{t.noHeadings}</p>}
  </section>;
}

function WordCountPanel({ editor, onClose }: { editor: Editor | null; onClose(): void }) {
  const t = useT().office;
  const { counts } = documentProductivity(editor);
  const rows = [[t.words, counts.words], [t.characters, counts.characters], [t.charactersNoSpaces, counts.charactersNoSpaces], [t.selectionWords, counts.selectionWords], [t.selectionCharacters, counts.selectionCharacters]] as const;
  return <section className="absolute left-1/2 top-16 z-40 w-72 -translate-x-1/2 rounded-xl border bg-background p-3 shadow-xl" aria-label={t.wordCount} data-document-word-count="true">
    <div className="mb-2 flex items-center justify-between"><h2 className="text-sm font-semibold">{t.wordCount}</h2><button type="button" onClick={onClose} aria-label={t.close}>×</button></div>
    <dl className="space-y-1 text-xs">{rows.map(([label, value]) => <div key={label} className="flex justify-between gap-4"><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
  </section>;
}

function ColorInput({ label, value, disabled, onValue, icon }: { label: string; value: string; disabled: boolean; onValue(value: string): void; icon?: React.ReactNode }) {
  return <label className="relative flex h-8 items-center gap-1 rounded px-1 hover:bg-muted" title={label}>{icon ?? <span className="size-3 rounded-full border" style={{ backgroundColor: value }} />}<input aria-label={label} disabled={disabled} type="color" value={/^#[0-9A-Fa-f]{6}$/.test(value) ? value : "#111111"} onChange={(event) => onValue(event.target.value.toUpperCase())} className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-default" /></label>;
}

function AlignmentSelect({ label, value, onValue }: { label: string; value: DocumentAlignment; onValue(value: DocumentAlignment): void }) {
  const t = useT().office;
  return <Select value={value} onValueChange={(next) => next && onValue(next as DocumentAlignment)}><SelectTrigger className="w-full" aria-label={label}><SelectValue /></SelectTrigger><SelectContent><SelectItem value="start">{t.alignLeft}</SelectItem><SelectItem value="center">{t.alignCenter}</SelectItem><SelectItem value="end">{t.alignRight}</SelectItem></SelectContent></Select>;
}

function ToolbarButton({ label, icon, disabled, pressed, onClick }: { label: string; icon: React.ReactNode; disabled: boolean; pressed: boolean; onClick(): void }) {
  return <button type="button" aria-label={label} aria-pressed={pressed} disabled={disabled} onClick={onClick} className={cn("rounded p-2 hover:bg-muted disabled:opacity-40 [&_svg]:size-4", pressed && "bg-muted text-primary")}>{icon}</button>;
}
function Divider() { return <span className="mx-0.5 h-5 border-l" aria-hidden />; }

function currentBlockStyle(editor: Editor | null): DocumentBlockStyle {
  if (!editor) return "Body";
  const $from = editor.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (node.type.name === "heading") return `Heading ${Number(node.attrs.level)}` as DocumentBlockStyle;
    if (node.type.name === "paragraph") return (node.attrs.styleName === "Title" || node.attrs.styleName === "Subtitle" ? node.attrs.styleName : "Body") as DocumentBlockStyle;
  }
  return "Body";
}
function currentAlignment(editor: Editor | null): DocumentAlignment {
  if (!editor) return "start";
  const $from = editor.state.selection.$from;
  for (let depth = $from.depth; depth > 0; depth -= 1) {
    const node = $from.node(depth);
    if (["paragraph", "heading", "officeTableCell"].includes(node.type.name)) return (node.attrs.alignment ?? "start") as DocumentAlignment;
  }
  return "start";
}
function pageSizeKey(page?: Record<string, number | string>): keyof typeof PAGE_SIZES {
  if (!page) return "letter";
  const width = Math.min(Number(page.widthPt), Number(page.heightPt));
  const height = Math.max(Number(page.widthPt), Number(page.heightPt));
  if (Math.abs(width - 595.28) < 2 && Math.abs(height - 841.89) < 2) return "a4";
  if (Math.abs(height - 1008) < 2) return "legal";
  return "letter";
}
function blockStyleLabel(value: DocumentBlockStyle, t: ReturnType<typeof useT>["office"]): string {
  if (value === "Body") return t.styleBody;
  if (value === "Title") return t.styleTitle;
  if (value === "Subtitle") return t.styleSubtitle;
  return t.styleHeading.replace("{level}", value.slice(-1));
}
