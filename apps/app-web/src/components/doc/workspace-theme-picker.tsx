"use client";

/** Persistent rail theme picker. Spec: docs/architecture/features/workspace-navigation.md.
 * [COMP:app-web/workspace-theme-picker] */
import { useState } from "react";
import { Pencil, Trash2 } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { useTheme, THEME_PRESETS, currentPresetId } from "@/lib/theme";
import { useCustomThemes } from "@/lib/custom-themes";
import type { DocTheme } from "@/lib/api/doc-themes";
import { CreateThemeDialog } from "./create-theme-dialog";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { openWorkspaceSettings } from "@/lib/workspace-settings-events";
import { requestSidebarClose } from "@/lib/sidebar-close";
import { Tooltip } from "@/components/ui/tooltip";
import { Select, SelectContent, SelectItem, SelectSeparator, SelectTrigger, SelectValue } from "@/components/ui/select";

/**
 * Desktop uses a swatch in the app rail; phones show the active theme's name
 * and chevron alongside the swatch. The menu lists theme PRESETS ("Default" / "Default
 * Dark" flip light↔dark), then any workspace custom themes, then "Create your
 * own". Each row carries a **mini colour dot** illustrating the theme. Custom
 * themes additionally reveal **edit** + **delete** on hover: edit hands off to
 * Settings → Preferences (rename / refine / delete live there); delete confirms
 * then removes via the provider. A preset entry sets the palette (`data-palette`
 * + `doc:palette`) and the mode (`.dark` + `doc:theme`).
 */
// Sentinel select value for the trailing "Create your own…" action — selecting
// it opens the generate dialog instead of applying a theme.
const CREATE_THEME_VALUE = "__create_theme__";

// Colour stops for the two built-in presets' dots, mirroring the `--primary` /
// `--background` notion tokens in globals.css (light vs dark). Decorative only —
// if those notion tokens change, update here.
const PRESET_DOT_COLORS: Record<string, string[]> = {
  default: ["#2383E2", "#FFFFFF"],
  "default-dark": ["#529CCA", "#191919"],
};

// The selected theme reads as a persistent highlighted row (the focused look)
// instead of a right-aligned tick — that keeps the right edge free so the
// per-row hover actions sit flush right rather than dodging a check gutter.
const SELECTED_ROW_CLS =
  "data-[selected]:bg-accent data-[selected]:font-medium data-[selected]:text-accent-foreground";

/** A mini circle illustrating a theme — vertical colour stops inside a bordered
 *  round swatch. Same visual language as the Settings swatch. */
function ThemeDot({ colors }: { colors: string[] }) {
  if (colors.length === 0) return null;
  return (
    <span className="flex h-3.5 w-3.5 shrink-0 overflow-hidden rounded-full border border-border/60">
      {colors.map((c, i) => (
        <span key={`${i}-${c}`} className="flex-1" style={{ background: c }} />
      ))}
    </span>
  );
}

/** Dot colours for a custom theme: primary / accent / background from its light
 *  token map (the same triple the Settings swatch uses). */
function customDotColors(theme: DocTheme): string[] {
  const { primary, "accent-2": accent, background } = theme.tokens.light;
  return [primary, accent, background].filter(Boolean) as string[];
}

export function WorkspaceThemePicker() {
  const t = useT();
  const { palette, resolved, customThemeId, setPalette, setMode } = useTheme();
  const { themes, applyTheme, deleteTheme } = useCustomThemes();
  const [createOpen, setCreateOpen] = useState(false);
  // Controlled so the per-row edit / delete buttons can close the menu before
  // handing off to Settings / the confirm dialog.
  const [open, setOpen] = useState(false);

  // Value→label map for the trigger display: built-in presets + custom themes.
  const itemLabels: Record<string, string> = {
    default: t.settings.general.paletteNotion,
    "default-dark": t.settings.general.paletteDefaultDark,
    [CREATE_THEME_VALUE]: t.settings.general.createYourOwn,
  };
  for (const theme of themes) itemLabels[`custom:${theme.id}`] = theme.name;

  // The active value: a custom theme (custom:<id>) or the matching built-in preset.
  const activeValue =
    palette === "custom" && customThemeId
      ? `custom:${customThemeId}`
      : currentPresetId(palette, resolved) ?? "default";

  // Dot colours for the active theme shown in the flat trigger.
  const activeDot = activeValue.startsWith("custom:")
    ? (() => {
        const th = themes.find((x) => x.id === activeValue.slice("custom:".length));
        return th ? customDotColors(th) : [];
      })()
    : PRESET_DOT_COLORS[activeValue] ?? [];
  const triggerLabel = `${t.settings.general.theme}: ${itemLabels[activeValue] ?? t.settings.general.theme}`;

  const onValueChange = (v: string | null) => {
    if (!v) return;
    if (v === CREATE_THEME_VALUE) {
      setCreateOpen(true);
      requestSidebarClose();
      return;
    }
    if (v.startsWith("custom:")) {
      const theme = themes.find((th) => th.id === v.slice("custom:".length));
      if (theme) applyTheme(theme);
      return;
    }
    const preset = THEME_PRESETS.find((p) => p.id === v);
    if (!preset) return;
    setPalette(preset.palette);
    if (preset.mode) setMode(preset.mode);
  };

  // Revising a theme's look (rename / refine / delete) lives in Settings — the
  // picker is a quick switcher, so the pencil hands off to that surface.
  const onEditTheme = () => {
    setOpen(false);
    openWorkspaceSettings("preferences");
    requestSidebarClose();
  };

  const onDeleteTheme = async (theme: DocTheme) => {
    setOpen(false);
    const ok = await confirmDialog({
      description: t.settings.general.customThemeDeleteConfirm,
      confirmLabel: t.settings.general.customThemeDelete,
      cancelLabel: t.common.cancel,
      variant: "destructive",
    });
    if (ok) await deleteTheme(theme.id);
  };

  return (
    <>
      <Select
        open={open}
        onOpenChange={setOpen}
        value={activeValue}
        onValueChange={onValueChange}
        items={itemLabels}
      >
        <Tooltip label={triggerLabel} side="right">
          <SelectTrigger data-workspace-theme-picker aria-label={triggerLabel} className="h-11 data-[size=default]:h-11 w-full justify-between gap-2 rounded-md border-0 bg-transparent px-2 text-[16px] font-normal text-sidebar-foreground shadow-none hover:bg-sidebar-accent dark:bg-transparent dark:hover:bg-sidebar-accent md:size-11 md:justify-center md:rounded-xl md:p-0 md:[&>svg]:hidden">
            <span className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden md:flex-none md:overflow-visible">
              <span aria-hidden className="md:scale-125">
                <ThemeDot colors={activeDot} />
              </span>
              <SelectValue className="md:sr-only" />
            </span>
          </SelectTrigger>
        </Tooltip>
        <SelectContent side="top" align="start" sideOffset={8} alignItemWithTrigger={false} className="w-[min(18rem,calc(100vw-1rem))] min-w-0">
          {THEME_PRESETS.map((p) => (
            <SelectItem key={p.id} value={p.id} indicator={false} className={SELECTED_ROW_CLS}>
              <ThemeDot colors={PRESET_DOT_COLORS[p.id] ?? []} />
              <span className="truncate">{itemLabels[p.id]}</span>
            </SelectItem>
          ))}
          {themes.length > 0 ? <SelectSeparator /> : null}
          {themes.map((theme) => (
            <div key={theme.id} className="group/theme relative">
              <SelectItem value={`custom:${theme.id}`} indicator={false} className={SELECTED_ROW_CLS}>
                <ThemeDot colors={customDotColors(theme)} />
                <span className="truncate">{theme.name}</span>
              </SelectItem>
              {/* Hover-revealed actions, flush to the right edge (no tick gutter
                  to dodge now). The container carries the row's highlight bg so
                  it masks the name end on hover — the title runs full-width at
                  rest. Siblings of the item, not children, so a click can't
                  select the row; the handlers also close the menu first. */}
              {/* Always visible on a phone (responsive contract M2), hover-
                  revealed from `md`. */}
              <div className="absolute right-1.5 top-1/2 flex -translate-y-1/2 items-center gap-0.5 rounded bg-popover pl-1.5 opacity-100 transition-opacity md:bg-accent md:opacity-0 md:focus-within:opacity-100 md:group-hover/theme:opacity-100">
                <button
                  type="button"
                  aria-label={`${t.settings.general.customThemeEdit}: ${theme.name}`}
                  title={t.settings.general.customThemeEdit}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    onEditTheme();
                  }}
                  className="flex size-9 items-center justify-center rounded text-muted-foreground hover:bg-foreground/10 hover:text-foreground md:size-auto md:p-1"
                >
                  <Pencil className="size-3.5" />
                </button>
                <button
                  type="button"
                  aria-label={`${t.settings.general.customThemeDelete}: ${theme.name}`}
                  title={t.settings.general.customThemeDelete}
                  onPointerDown={(e) => e.stopPropagation()}
                  onClick={(e) => {
                    e.stopPropagation();
                    e.preventDefault();
                    void onDeleteTheme(theme);
                  }}
                  className="flex size-9 items-center justify-center rounded text-muted-foreground hover:bg-destructive/10 hover:text-destructive md:size-auto md:p-1"
                >
                  <Trash2 className="size-3.5" />
                </button>
              </div>
            </div>
          ))}
          <SelectSeparator />
          <SelectItem value={CREATE_THEME_VALUE} indicator={false}>
            {t.settings.general.createYourOwn}
          </SelectItem>
        </SelectContent>
      </Select>
      <CreateThemeDialog open={createOpen} onOpenChange={setCreateOpen} />
    </>
  );
}
