"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import { usePathname } from "next/navigation";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { authFetch } from "@/lib/auth-fetch";
import { useT, useLocale } from "@/lib/i18n/client";
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n";
import { setLocaleAction } from "@/lib/i18n/set-locale";
import { useTheme, type ThemeMode } from "@/lib/theme";
import { useCustomThemes } from "@/lib/custom-themes";
import type { DocTheme } from "@/lib/api/doc-themes";
import { CreateThemeDialog } from "@/components/doc/create-theme-dialog";
import { RefineThemeDialog } from "@/components/doc/refine-theme-dialog";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { Button } from "@/components/ui/button";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export function GeneralSection() {
  const t = useT();
  const currentLocale = useLocale();
  const pathname = usePathname();
  const [, startTransition] = useTransition();
  const { mode: theme, setMode: setTheme } = useTheme();
  const browserTz = typeof Intl !== "undefined" ? Intl.DateTimeFormat().resolvedOptions().timeZone : "UTC";
  const [timezone, setTimezone] = useState(browserTz);
  const hasMounted = useRef(false);

  const handleLocaleChange = (next: string | null) => {
    if (!next || next === currentLocale) return;
    const formData = new FormData();
    formData.set("locale", next);
    formData.set("path", pathname || "/");
    startTransition(() => setLocaleAction(formData));
  };

  const saveTimezone = useCallback(async (tz: string) => {
    try {
      await authFetch(`${API_URL}/api/account/timezone`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ timezone: tz }),
      });
    } catch (err) {
      console.error("Failed to save timezone:", err);
    }
  }, []);

  // On mount, save browser-detected timezone (syncs new users automatically)
  useEffect(() => {
    if (!hasMounted.current) {
      hasMounted.current = true;
      saveTimezone(browserTz);
    }
  }, [browserTz, saveTimezone]);

  const handleTimezoneChange = (tz: string | null) => {
    if (!tz) return;
    setTimezone(tz);
    saveTimezone(tz);
  };

  // Cached list of all IANA timezones (hundreds of entries) — computed once.
  const timezones = useMemo<string[]>(() => {
    if (typeof Intl === "undefined") return [timezone];
    const supported = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] })
      .supportedValuesOf;
    return supported ? supported("timeZone") : [timezone];
  }, [timezone]);

  // Base UI's <SelectValue> renders the raw value unless the Root gets an
  // items map; this label map makes the trigger show human-readable text.
  const themeItems = useMemo(
    () => ({
      system: t.settings.general.themeSystem,
      light: t.settings.general.themeLight,
      dark: t.settings.general.themeDark,
    }),
    [t],
  );

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">{t.settings.nav.general}</h2>

      <Section title={t.settings.general.appearance}>
        <Row label={t.settings.general.theme}>
          <Select value={theme} onValueChange={(v) => v && setTheme(v as ThemeMode)} items={themeItems}>
            <SelectTrigger className="min-w-32">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              <SelectItem value="system">{t.settings.general.themeSystem}</SelectItem>
              <SelectItem value="light">{t.settings.general.themeLight}</SelectItem>
              <SelectItem value="dark">{t.settings.general.themeDark}</SelectItem>
            </SelectContent>
          </Select>
        </Row>
      </Section>

      <CustomThemesSection />

      <Section title={t.settings.general.regional}>
        <Row label={t.settings.general.timezone}>
          <Select value={timezone} onValueChange={handleTimezoneChange}>
            <SelectTrigger className="min-w-0 w-full md:min-w-56 md:max-w-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {timezones.map((tz) => (
                <SelectItem key={tz} value={tz}>
                  {tz}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
        <Row label={t.settings.general.language}>
          <Select value={currentLocale} onValueChange={handleLocaleChange} items={LOCALE_LABELS}>
            <SelectTrigger className="min-w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="end">
              {LOCALES.map((loc: Locale) => (
                <SelectItem key={loc} value={loc}>{LOCALE_LABELS[loc]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </Row>
      </Section>
    </div>
  );
}

/**
 * Workspace-shared custom themes ("Get my own theme"). Lists the generated
 * themes with apply / rename / delete, plus a "Create new theme" button that
 * opens the same generate dialog the sidebar picker uses. The 5-per-workspace
 * cap is invisible — it only surfaces (in the dialog) when a 6th is attempted.
 */
function CustomThemesSection() {
  const t = useT();
  const { themes, applyTheme, renameTheme, deleteTheme } = useCustomThemes();
  const { palette, customThemeId } = useTheme();
  const [createOpen, setCreateOpen] = useState(false);
  const [refineTarget, setRefineTarget] = useState<DocTheme | null>(null);

  const onRename = async (id: string, current: string) => {
    const next = await promptDialog({
      title: t.settings.general.customThemeRenamePrompt,
      defaultValue: current,
      confirmLabel: t.settings.general.customThemeRename,
      cancelLabel: t.common.cancel,
    });
    if (next && next !== current) await renameTheme(id, next);
  };

  const onDelete = async (id: string) => {
    const ok = await confirmDialog({
      description: t.settings.general.customThemeDeleteConfirm,
      confirmLabel: t.settings.general.customThemeDelete,
      cancelLabel: t.common.cancel,
      variant: "destructive",
    });
    if (ok) await deleteTheme(id);
  };

  return (
    <Section title={t.settings.general.customThemes}>
      <p className="text-sm text-muted-foreground">{t.settings.general.customThemesDesc}</p>
      {themes.length === 0 ? (
        <p className="text-sm text-muted-foreground/70">{t.settings.general.customThemeEmpty}</p>
      ) : (
        <ul className="space-y-1">
          {themes.map((theme) => {
            const isActive = palette === "custom" && customThemeId === theme.id;
            return (
              <li
                key={theme.id}
                className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2"
              >
                <button
                  type="button"
                  onClick={() => applyTheme(theme)}
                  className="flex min-w-0 items-center gap-2 text-left text-sm"
                >
                  <ThemeSwatch theme={theme} />
                  <span className="truncate">{theme.name}</span>
                  {isActive ? (
                    <span className="shrink-0 text-xs text-muted-foreground">✓</span>
                  ) : null}
                </button>
                <div className="flex shrink-0 items-center gap-1">
                  <Button variant="ghost" size="sm" onClick={() => setRefineTarget(theme)}>
                    {t.settings.general.customThemeRefine}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onRename(theme.id, theme.name)}>
                    {t.settings.general.customThemeRename}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={() => onDelete(theme.id)}>
                    {t.settings.general.customThemeDelete}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      <Button variant="outline" size="sm" onClick={() => setCreateOpen(true)}>
        {t.settings.general.customThemeNew}
      </Button>
      <CreateThemeDialog open={createOpen} onOpenChange={setCreateOpen} />
      <RefineThemeDialog
        theme={refineTarget}
        open={refineTarget !== null}
        onOpenChange={(o) => {
          if (!o) setRefineTarget(null);
        }}
      />
    </Section>
  );
}

/** A tiny three-stop swatch (primary / accent / background) for a theme row. */
function ThemeSwatch({ theme }: { theme: { tokens: { light: Record<string, string> } } }) {
  const { primary, "accent-2": accent, background } = theme.tokens.light;
  return (
    <span className="flex h-4 w-4 shrink-0 overflow-hidden rounded-full border border-border">
      <span className="flex-1" style={{ background: primary }} />
      <span className="flex-1" style={{ background: accent }} />
      <span className="flex-1" style={{ background }} />
    </span>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="border-t border-border pt-6 space-y-4">
      <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider">{title}</h3>
      <div className="space-y-4">{children}</div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between md:gap-4">
      <span className="text-sm">{label}</span>
      {children}
    </div>
  );
}
