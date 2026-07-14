"use client";

/**
 * Page template gallery — the "/template" slash action's chooser, and the
 * "Start from a template" picker on the empty-page landing.
 *
 * Lists BOTH the shared built-in Notion-style templates (`@sidanclaw/doc-model`
 * `listPageTemplates` — the same catalog the brain-MCP `listPageTemplates` /
 * `createPageFromTemplate` tools read) AND the workspace's CUSTOM templates
 * (`workspace_page_templates`, fetched by the caller). Custom templates appear
 * first under "My templates" (each deletable); built-ins follow grouped by
 * category. A "New template" button starts a from-scratch authoring flow.
 *
 * Picking resolves immediately (one-tap / Enter on the highlighted row):
 * built-in → `onPick(builtinId)`, custom → `onPickCustom(customId)` — the
 * caller instantiates the built-in Markdown or fetches the custom block
 * snapshot. Keyboard: typing filters, ArrowUp/Down move the highlight across
 * custom + built-in rows, Enter picks, Esc closes (base-ui owns Esc + outside
 * click + focus trap).
 *
 * [COMP:app-web/template-gallery]
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { Plus, Search, Trash2 } from "lucide-react";
import {
  listPageTemplates,
  type CustomPageTemplateSummary,
  type PageTemplateCategory,
  type PageTemplateSummary,
} from "@sidanclaw/doc-model";

import { confirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

export type TemplateGalleryProps = {
  /** Workspace custom templates (summaries), shown under "My templates". */
  customTemplates: CustomPageTemplateSummary[];
  /** Called with the chosen BUILT-IN template id (one-tap). */
  onPick: (templateId: string) => void;
  /** Called with the chosen CUSTOM template id (one-tap). */
  onPickCustom: (templateId: string) => void;
  /** Delete a custom template (after a confirm). */
  onDeleteCustom: (templateId: string) => void;
  /** Start the "author a template from scratch" flow. */
  onNewTemplate: () => void;
  /** Called when the gallery is dismissed without a pick. */
  onClose: () => void;
};

/** Category render order — mirrors the gallery's grouping intent. */
const CATEGORY_ORDER: readonly PageTemplateCategory[] = [
  "meeting",
  "planning",
  "team",
  "personal",
  "knowledge",
];

/**
 * Pure filter: match `query` (trimmed, case-insensitive) against a built-in
 * template's name, description, and keywords. Empty query returns every row.
 * Exported for unit testing (app-web's vitest is node-only).
 */
export function filterTemplates(
  query: string,
  all: PageTemplateSummary[],
): PageTemplateSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter((t) => {
    const haystack = `${t.name} ${t.description} ${t.keywords.join(" ")}`.toLowerCase();
    return haystack.includes(q);
  });
}

/**
 * Pure filter for custom templates — name + description only (custom rows carry
 * no keyword tokens). Empty query returns every row. Exported for unit testing.
 */
export function filterCustomTemplates(
  query: string,
  all: CustomPageTemplateSummary[],
): CustomPageTemplateSummary[] {
  const q = query.trim().toLowerCase();
  if (!q) return all;
  return all.filter((t) => {
    const haystack = `${t.name} ${t.description ?? ""}`.toLowerCase();
    return haystack.includes(q);
  });
}

/** One keyboard-navigable row: a custom or a built-in template. */
type FlatRow =
  | { kind: "custom"; id: string }
  | { kind: "builtin"; id: string };

export function TemplateGallery({
  customTemplates,
  onPick,
  onPickCustom,
  onDeleteCustom,
  onNewTemplate,
  onClose,
}: TemplateGalleryProps) {
  const t = useT().docPage.templateGallery;
  const allBuiltin = useMemo(() => listPageTemplates(), []);
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const customMatches = useMemo(
    () => filterCustomTemplates(query, customTemplates),
    [query, customTemplates],
  );
  const builtinMatches = useMemo(() => filterTemplates(query, allBuiltin), [query, allBuiltin]);

  // Flat keyboard order: custom rows first (catalog/recency order), then
  // built-ins in category order. Enter dispatches by row kind.
  const flatRows = useMemo<FlatRow[]>(() => {
    const rows: FlatRow[] = customMatches.map((c) => ({ kind: "custom", id: c.id }));
    for (const category of CATEGORY_ORDER) {
      for (const b of builtinMatches.filter((m) => m.category === category)) {
        rows.push({ kind: "builtin", id: b.id });
      }
    }
    return rows;
  }, [customMatches, builtinMatches]);

  // Keep the highlight in range as the filtered list shrinks/grows.
  useEffect(() => {
    setSelectedIndex((i) => (i >= flatRows.length ? 0 : i));
  }, [flatRows.length]);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const pickRow = useCallback(
    (row: FlatRow) => {
      if (row.kind === "custom") onPickCustom(row.id);
      else onPick(row.id);
    },
    [onPick, onPickCustom],
  );

  const onKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setSelectedIndex((i) => (flatRows.length ? (i + 1) % flatRows.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setSelectedIndex((i) =>
          flatRows.length ? (i - 1 + flatRows.length) % flatRows.length : 0,
        );
      } else if (e.key === "Enter") {
        e.preventDefault();
        const chosen = flatRows[selectedIndex];
        if (chosen) pickRow(chosen);
      }
    },
    [flatRows, selectedIndex, pickRow],
  );

  const handleDeleteCustom = useCallback(
    async (id: string, name: string) => {
      const ok = await confirmDialog({
        title: t.deleteConfirmTitle,
        description: t.deleteConfirm.replace("{name}", name),
        confirmLabel: t.deleteConfirmAction,
        cancelLabel: t.cancel,
        variant: "destructive",
      });
      if (ok) onDeleteCustom(id);
    },
    [onDeleteCustom, t],
  );

  const hasMatches = flatRows.length > 0;

  // Track the running flat index so each rendered row matches `flatRows`.
  let flatIndex = -1;

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm transition-opacity duration-150",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          )}
        />
        <Dialog.Popup
          aria-label={t.ariaLabel}
          onKeyDown={onKeyDown}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex max-h-[80vh] w-[calc(100%-2rem)] max-w-md flex-col",
            "-translate-x-1/2 -translate-y-1/2 overflow-hidden rounded-2xl border border-border",
            "bg-background shadow-xl ring-1 ring-foreground/5 transition-all duration-150",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
          )}
        >
          <div className="flex items-center justify-between gap-2 px-4 pt-4">
            <Dialog.Title className="text-sm font-semibold text-foreground">
              {t.title}
            </Dialog.Title>
            <button
              type="button"
              onClick={onNewTemplate}
              className="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs font-medium text-foreground hover:bg-muted/60"
            >
              <Plus className="size-3.5" aria-hidden />
              {t.newTemplate}
            </button>
          </div>
          <div className="px-4 pb-2 pt-2">
            {/* Composite field: the box draws the focus ring; the inner input
                opts out of the global :focus-visible ring. */}
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted/40 px-2.5 py-1.5 transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
              <Search className="size-4 shrink-0 text-muted-foreground" aria-hidden />
              <input
                ref={inputRef}
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t.searchPlaceholder}
                className="w-full bg-transparent text-sm text-foreground outline-none focus-visible:shadow-none placeholder:text-muted-foreground"
              />
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
            {!hasMatches ? (
              <p className="px-2 py-6 text-center text-sm text-muted-foreground">{t.empty}</p>
            ) : (
              <>
                {customMatches.length > 0 ? (
                  <div className="pb-1">
                    <div className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                      {t.myTemplates}
                    </div>
                    {customMatches.map((tpl) => {
                      flatIndex += 1;
                      const idx = flatIndex;
                      return (
                        <div
                          key={tpl.id}
                          className={cn(
                            "group flex items-center gap-1 rounded-md",
                            idx === selectedIndex ? "bg-muted" : "hover:bg-muted/60",
                          )}
                          onMouseEnter={() => setSelectedIndex(idx)}
                        >
                          <button
                            type="button"
                            onClick={() => onPickCustom(tpl.id)}
                            className="flex min-w-0 flex-1 items-start gap-3 px-2.5 py-2 text-left"
                          >
                            <span className="mt-0.5 text-lg leading-none" aria-hidden>
                              {tpl.icon ?? "📄"}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium text-foreground">
                                {tpl.name}
                              </span>
                              {tpl.description ? (
                                <span className="block truncate text-xs text-muted-foreground">
                                  {tpl.description}
                                </span>
                              ) : null}
                            </span>
                          </button>
                          <button
                            type="button"
                            aria-label={t.deleteTemplate}
                            title={t.deleteTemplate}
                            onClick={() => handleDeleteCustom(tpl.id, tpl.name)}
                            className="mr-1.5 shrink-0 rounded p-1 text-muted-foreground opacity-0 hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
                          >
                            <Trash2 className="size-4" aria-hidden />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                ) : null}
                {CATEGORY_ORDER.map((category) => {
                  const inCategory = builtinMatches.filter((m) => m.category === category);
                  if (inCategory.length === 0) return null;
                  return (
                    <div key={category} className="pb-1">
                      <div className="px-2 pb-1 pt-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                        {t.categories[category]}
                      </div>
                      {inCategory.map((tpl) => {
                        flatIndex += 1;
                        const idx = flatIndex;
                        return (
                          <button
                            key={tpl.id}
                            type="button"
                            onClick={() => onPick(tpl.id)}
                            onMouseEnter={() => setSelectedIndex(idx)}
                            className={cn(
                              "flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left",
                              idx === selectedIndex ? "bg-muted" : "hover:bg-muted/60",
                            )}
                          >
                            <span className="mt-0.5 text-lg leading-none" aria-hidden>
                              {tpl.icon}
                            </span>
                            <span className="min-w-0">
                              <span className="block truncate text-sm font-medium text-foreground">
                                {tpl.name}
                              </span>
                              <span className="block truncate text-xs text-muted-foreground">
                                {tpl.description}
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  );
                })}
              </>
            )}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
