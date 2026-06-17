"use client";

/**
 * "Refine theme" dialog — conversational iteration on an existing custom theme.
 *
 * The user types a follow-up instruction ("make it warmer", "more contrast",
 * "swap the accent to green"); on Update we POST it, the server nudges the
 * theme's seed and rebuilds the tokens in place, and
 * `CustomThemesProvider.refineTheme` re-applies it live if it's the active
 * theme. Sibling of `create-theme-dialog.tsx`; same base-ui Dialog shell.
 *
 * Controlled: the caller owns `theme` (which theme to refine) + `open`.
 *
 * [COMP:app-web/refine-theme-dialog]
 */

import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";

import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { useCustomThemes } from "@/lib/custom-themes";
import { DocThemeError, type DocTheme } from "@/lib/api/doc-themes";
import { Button } from "../ui/button";

export function RefineThemeDialog({
  theme,
  open,
  onOpenChange,
}: {
  theme: DocTheme | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { refineTheme, generating } = useCustomThemes();
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (open) {
      setValue("");
      setError(null);
    }
  }, [open]);

  async function submit() {
    const instruction = value.trim();
    if (!instruction || generating || !theme) return;
    setError(null);
    try {
      await refineTheme(theme.id, instruction);
      onOpenChange(false);
    } catch (err) {
      const code = err instanceof DocThemeError ? err.code : "unknown";
      setError(
        code === "limit_reached"
          ? t.settings.general.customThemeLimitReached
          : t.settings.general.customThemeGenerateFailed,
      );
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!generating) onOpenChange(next);
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
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2",
            "rounded-2xl border border-border bg-background p-6 shadow-xl ring-1 ring-foreground/5",
            "transition-all duration-150",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
          )}
        >
          <Dialog.Title className="text-base font-semibold text-foreground">
            {t.settings.general.customThemeRefineTitle}
            {theme ? <span className="text-muted-foreground"> · {theme.name}</span> : null}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {t.settings.general.customThemeRefineDesc}
          </Dialog.Description>
          <textarea
            autoFocus
            rows={2}
            value={value}
            placeholder={t.settings.general.customThemeRefinePlaceholder}
            disabled={generating}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            className="mt-4 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 disabled:opacity-60"
          />
          {error ? <p className="mt-2 text-sm text-destructive">{error}</p> : null}
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={generating} onClick={() => onOpenChange(false)}>
              {t.common.cancel}
            </Button>
            <Button
              variant="default"
              size="sm"
              disabled={generating || !value.trim()}
              onClick={() => void submit()}
            >
              {generating
                ? t.settings.general.customThemeGenerating
                : t.settings.general.customThemeRefineSubmit}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
