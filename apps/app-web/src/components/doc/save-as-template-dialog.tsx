"use client";

/**
 * Save-as-template dialog — collects the name / description / category for a
 * new custom template before it is persisted. Opened from the page ⋯ menu
 * ("Save as template", snapshotting the current page's blocks) and from the
 * "New template" authoring flow's "Finish template" step. The caller supplies
 * the block snapshot + icon and persists via `createCustomPageTemplate`; this
 * dialog owns only the metadata form.
 *
 * Category is a chip row (the five built-in gallery groups) rather than a
 * native `<select>` (banned for themed surfaces). Base-ui `Dialog` owns Esc +
 * outside click + focus trap.
 *
 * [COMP:app-web/save-as-template-dialog]
 */

import { useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { PAGE_TEMPLATE_CATEGORIES, type PageTemplateCategory } from "@sidanclaw/doc-model";

import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

export type SaveAsTemplateInput = {
  name: string;
  description: string;
  category: PageTemplateCategory;
  icon: string | null;
};

export type SaveAsTemplateDialogProps = {
  /** Prefill from the source page's title. */
  initialName: string;
  /** Prefill from the source page's icon (seeds template-created pages). */
  initialIcon: string | null;
  /** Persist the template. Throwing surfaces the error inline. */
  onSubmit: (input: SaveAsTemplateInput) => Promise<void>;
  /** Dismiss without saving. */
  onClose: () => void;
};

export function SaveAsTemplateDialog({
  initialName,
  initialIcon,
  onSubmit,
  onClose,
}: SaveAsTemplateDialogProps) {
  const t = useT().docPage.saveTemplateDialog;
  const categories = useT().docPage.templateGallery.categories;
  const [name, setName] = useState(initialName.trim() || "");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<PageTemplateCategory>("planning");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const canSave = name.trim().length > 0 && !busy;

  async function handleSave() {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onSubmit({
        name: name.trim(),
        description: description.trim(),
        category,
        icon: initialIcon,
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  }

  return (
    <Dialog.Root
      open
      onOpenChange={(open) => {
        if (!open && !busy) onClose();
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
          aria-label={t.title}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 flex w-[calc(100%-2rem)] max-w-md flex-col gap-4",
            "-translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-5",
            "shadow-xl ring-1 ring-foreground/5 transition-all duration-150",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
          )}
        >
          <Dialog.Title className="text-sm font-semibold text-foreground">
            {t.title}
          </Dialog.Title>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-foreground">{t.nameLabel}</span>
            <input
              autoFocus
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t.namePlaceholder}
              maxLength={256}
              className="rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-ring placeholder:text-muted-foreground"
            />
          </label>

          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-foreground">{t.descriptionLabel}</span>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t.descriptionPlaceholder}
              maxLength={2000}
              rows={2}
              className="resize-none rounded-md border border-border bg-muted/40 px-2.5 py-1.5 text-sm text-foreground outline-none focus:border-ring placeholder:text-muted-foreground"
            />
          </label>

          <div className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium text-foreground">{t.categoryLabel}</span>
            <div className="flex flex-wrap gap-1.5">
              {PAGE_TEMPLATE_CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={cn(
                    "rounded-full border px-2.5 py-1 text-xs font-medium",
                    c === category
                      ? "border-primary bg-primary/10 text-primary"
                      : "border-border text-muted-foreground hover:bg-muted/60",
                  )}
                >
                  {categories[c]}
                </button>
              ))}
            </div>
          </div>

          {error ? <p className="text-xs text-destructive">{error}</p> : null}

          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="rounded-md px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted/60 disabled:opacity-50"
            >
              {t.cancel}
            </button>
            <button
              type="button"
              onClick={() => void handleSave()}
              disabled={!canSave}
              className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {busy ? t.saving : t.save}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
