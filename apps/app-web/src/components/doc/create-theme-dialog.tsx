"use client";

/**
 * "Create a custom theme" dialog — the prompt entry for "Get my own theme".
 *
 * The user describes a mood/feeling; on Generate we POST the prompt, the server
 * generates + saves the theme, and `CustomThemesProvider.createTheme` applies it
 * live (generation = apply + save immediately). On the invisible 5-per-workspace
 * cap the server returns 409 → we show the limit message inline. Themed sibling
 * of `ui/prompt-dialog.tsx` (base-ui Dialog); never `window.prompt`.
 *
 * Controlled: the picker / settings own `open`.
 *
 * [COMP:app-web/create-theme-dialog]
 */

import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";

import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { useCustomThemes } from "@/lib/custom-themes";
import { DocThemeError } from "@/lib/api/doc-themes";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { Checkbox } from "../ui/checkbox";
import { Button } from "../ui/button";

export function CreateThemeDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const t = useT();
  const { createTheme, generating } = useCustomThemes();
  const { iconUrl } = useWorkspaceContext();
  const [fromIcon, setFromIcon] = React.useState(false);
  const useIcon = Boolean(iconUrl) && fromIcon;
  const iconOptionId = React.useId();
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  // Reset on each open.
  React.useEffect(() => {
    if (open) {
      setValue("");
      setFromIcon(false);
      setError(null);
    }
  }, [open]);

  async function submit() {
    const prompt = value.trim();
    if ((!prompt && !useIcon) || generating) return;
    setError(null);
    try {
      await createTheme(useIcon ? { fromIcon: true, ...(prompt ? { prompt } : {}) } : prompt);
      onOpenChange(false);
    } catch (err) {
      const code = err instanceof DocThemeError ? err.code : "unknown";
      setError(
        code === "limit_reached"
          ? t.settings.general.customThemeLimitReached
          : code === "no_workspace_icon"
            ? t.settings.general.customThemeNoIcon
            : code === "unusable_workspace_icon"
              ? t.settings.general.customThemeUnusableIcon
              : code === "theme_model_no_vision"
                ? t.settings.general.customThemeNoVision
                : t.settings.general.customThemeGenerateFailed,
      );
    }
  }

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        // Don't let an outside-click / Esc cancel a generation mid-flight.
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
            {t.settings.general.customThemeDialogTitle}
          </Dialog.Title>
          <Dialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {t.settings.general.customThemeDialogDesc}
          </Dialog.Description>
          {iconUrl ? (
            <label htmlFor={iconOptionId} className="mt-4 flex min-h-11 cursor-pointer items-center gap-3 text-sm">
              <Checkbox id={iconOptionId} checked={useIcon} disabled={generating}
                onCheckedChange={(checked) => { setFromIcon(checked); setError(null); }} />
              {t.settings.general.customThemeFromIcon}
            </label>
          ) : null}
          <textarea
            autoFocus
            rows={3}
            value={value}
            aria-label={useIcon ? t.settings.general.customThemeIconPrompt : t.settings.general.customThemeDialogDesc}
            placeholder={useIcon ? t.settings.general.customThemeIconPrompt : t.settings.general.customThemePlaceholder}
            disabled={generating}
            onChange={(e) => setValue(e.target.value)}
            onKeyDown={(e) => {
              // ⌘/Ctrl+Enter submits; plain Enter allows newlines.
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                void submit();
              }
            }}
            className="mt-4 w-full resize-none rounded-md border border-border bg-background px-3 py-2 text-[16px] text-foreground outline-none placeholder:text-muted-foreground disabled:opacity-60 md:text-sm"
          />
          {error ? (
            <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>
          ) : null}
          <div className="mt-6 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              className="min-h-11 md:min-h-0"
              disabled={generating}
              onClick={() => onOpenChange(false)}
            >
              {t.common.cancel}
            </Button>
            <Button
              variant="default"
              size="sm"
              className="min-h-11 md:min-h-0"
              disabled={generating || (!useIcon && !value.trim())}
              onClick={() => void submit()}
            >
              {generating
                ? t.settings.general.customThemeGenerating
                : t.settings.general.customThemeGenerate}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
