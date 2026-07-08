"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

export type ThemeMode = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/**
 * Colour palette — orthogonal to light/dark mode. `notion` is the DEFAULT
 * (exact Notion) and also the bare `:root`, so an unset attribute still renders
 * Notion. It maps to a `data-palette="<id>"` attribute on <html> that globals.css
 * keys its token overrides off (see the PALETTE SYSTEM block there).
 *
 * `custom` is special: a workspace-shared, AI-generated theme. Its tokens aren't
 * a static CSS block — they're injected at runtime as a `<style>` element keyed
 * to `[data-palette="custom"]` (see {@link applyCustomThemeStyle}). The shared
 * brand-treatment block in globals.css also keys off `custom`, so a generated
 * theme gets the gradient/glow treatments for free. See
 * docs/architecture/features/doc-custom-themes.md.
 */
export type Palette = "notion" | "custom";
/** The selectable BUILT-IN palettes (Settings → Appearance list). `custom` is
 *  applied via {@link applyCustomTheme}, never picked from this list. */
export const PALETTES: readonly Exclude<Palette, "custom">[] = ["notion"];

/** Light + dark token maps for a custom theme (the wire shape the API returns). */
export type DocThemeTokens = {
  light: Record<string, string>;
  dark: Record<string, string>;
};

/**
 * Theme presets — the user-facing list shown in the bottom-left "Theme"
 * dropdown. A preset bundles a palette with an OPTIONAL explicit mode, so
 * "Default" / "Default Dark" flip light↔dark from the same control. Custom
 * AI-generated themes are listed alongside these (applied via {@link applyCustomTheme});
 * Settings → Appearance exposes the light/dark mode separately.
 */
export type ThemePreset = { id: string; palette: Exclude<Palette, "custom">; mode?: ThemeMode };
export const THEME_PRESETS: readonly ThemePreset[] = [
  { id: "default", palette: "notion", mode: "light" },
  { id: "default-dark", palette: "notion", mode: "dark" },
];

/** Which preset the current (palette, resolved-mode) maps to, for the dropdown's
 *  shown value. Only the default (notion) palette distinguishes light vs dark.
 *  Returns null when a custom theme is active (the picker shows it separately). */
export function currentPresetId(palette: Palette, resolved: ResolvedTheme): string | null {
  if (palette === "custom") return null;
  if (palette === "notion") return resolved === "dark" ? "default-dark" : "default";
  return palette;
}

const MODE_KEY = "doc:theme";
const PALETTE_KEY = "doc:palette";
const DEFAULT_PALETTE: Exclude<Palette, "custom"> = "notion";
// Legacy mode key — app-web shipped with feed-web's "feed:theme" key by
// copy-paste. Read it as a fallback so existing users keep their light/dark
// choice after the rename; new writes use MODE_KEY.
const LEGACY_MODE_KEY = "feed:theme";
// Custom-theme selection: the active theme's id + a cache of its tokens so the
// pre-paint script can inject them with no flash (the authoritative copy lives
// in the DB and is re-applied once CustomThemesProvider fetches the list).
const CUSTOM_ID_KEY = "doc:customThemeId";
const CUSTOM_TOKENS_KEY = "doc:customTheme";
const CUSTOM_STYLE_ID = "doc-custom-theme";

// Only inline values that look like a colour — defence in depth for the tokens
// we write into a <style> element (they're builder-generated hex, but never
// trust cached localStorage blindly). Keys must be plain css-ident chars.
const SAFE_COLOR = /^#[0-9a-fA-F]{3,8}$|^rgba?\([0-9.,%\s]+\)$/;
const SAFE_KEY = /^[a-z0-9-]+$/;

function tokensToCss(map: Record<string, string>): string {
  let out = "";
  for (const [k, v] of Object.entries(map)) {
    if (SAFE_KEY.test(k) && typeof v === "string" && SAFE_COLOR.test(v)) {
      out += `--${k}:${v};`;
    }
  }
  return out;
}

/** Build the `<style>` text that applies a custom theme's light + dark tokens. */
function buildCustomThemeCss(tokens: DocThemeTokens): string {
  return (
    `html[data-palette="custom"]{${tokensToCss(tokens.light ?? {})}}` +
    `html.dark[data-palette="custom"]{${tokensToCss(tokens.dark ?? {})}}`
  );
}

function applyCustomThemeStyle(tokens: DocThemeTokens) {
  let el = document.getElementById(CUSTOM_STYLE_ID) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement("style");
    el.id = CUSTOM_STYLE_ID;
    document.head.appendChild(el);
  }
  el.textContent = buildCustomThemeCss(tokens);
}

function removeCustomThemeStyle() {
  document.getElementById(CUSTOM_STYLE_ID)?.remove();
}

type ThemeContextValue = {
  /** Stored light/dark preference (what the user picked). */
  mode: ThemeMode;
  /** Concrete theme actually rendered after resolving "system". */
  resolved: ResolvedTheme;
  setMode: (next: ThemeMode) => void;
  /** Selected colour palette (notion = default, "custom" = a generated theme). */
  palette: Palette;
  /** Select a BUILT-IN palette. Clears any active custom theme. */
  setPalette: (next: Exclude<Palette, "custom">) => void;
  /** The active custom theme's id, or null when a built-in is selected. */
  customThemeId: string | null;
  /**
   * Apply (and persist the selection of) a custom theme by id + its tokens.
   * `preferredMode` — when given (a user-initiated apply of a theme that has a
   * light/dark intent), also flips the doc mode so a "dark theme" renders
   * dark. Omit it on passive re-applies (mount) to preserve the user's own toggle.
   */
  applyCustomTheme: (
    id: string,
    tokens: DocThemeTokens,
    preferredMode?: ResolvedTheme,
  ) => void;
};

const ThemeContext = createContext<ThemeContextValue | null>(null);

/**
 * Pre-paint script. Inlined into <head> by RootLayout so the `dark` class, the
 * `data-palette` attribute, AND any active custom-theme tokens land on <html>
 * before the first paint — no flash. Must stay in sync with the storage keys +
 * resolution rules in this file.
 */
export const THEME_PREPAINT_SCRIPT = `(()=>{try{var r=document.documentElement;var s=localStorage.getItem("${MODE_KEY}")||localStorage.getItem("${LEGACY_MODE_KEY}");var m=(s==="light"||s==="dark"||s==="system")?s:"light";var d=m==="dark"||(m==="system"&&window.matchMedia("(prefers-color-scheme: dark)").matches);if(d){r.classList.add("dark");r.style.colorScheme="dark";}else{r.classList.remove("dark");r.style.colorScheme="light";}var ok={notion:1,custom:1};var p=localStorage.getItem("${PALETTE_KEY}");var pal=ok[p]?p:"${DEFAULT_PALETTE}";r.setAttribute("data-palette",pal);if(pal==="custom"){var raw=localStorage.getItem("${CUSTOM_TOKENS_KEY}");if(raw){var t=JSON.parse(raw);var sc=/^#[0-9a-fA-F]{3,8}$|^rgba?\\([0-9.,%\\s]+\\)$/;var mk=function(o){var c="";for(var k in o){if(/^[a-z0-9-]+$/.test(k)&&typeof o[k]==="string"&&sc.test(o[k]))c+="--"+k+":"+o[k]+";";}return c;};var css='html[data-palette="custom"]{'+mk(t.light||{})+'}html.dark[data-palette="custom"]{'+mk(t.dark||{})+'}';var el=document.getElementById("${CUSTOM_STYLE_ID}");if(!el){el=document.createElement("style");el.id="${CUSTOM_STYLE_ID}";document.head.appendChild(el);}el.textContent=css;}}}catch(e){}})();`;

function readStoredMode(): ThemeMode {
  if (typeof window === "undefined") return "light";
  const raw =
    window.localStorage.getItem(MODE_KEY) ??
    window.localStorage.getItem(LEGACY_MODE_KEY);
  if (raw === "light" || raw === "dark" || raw === "system") return raw;
  return "light";
}

function readStoredPalette(): Palette {
  if (typeof window === "undefined") return DEFAULT_PALETTE;
  const raw = window.localStorage.getItem(PALETTE_KEY);
  // A stale brand-palette id (slate/indigo/emerald/sunset, since removed) falls
  // through to the default — existing users keep a valid palette after the cut.
  return raw === "notion" || raw === "custom" ? raw : DEFAULT_PALETTE;
}

function resolveMode(mode: ThemeMode): ResolvedTheme {
  if (mode === "system") {
    if (typeof window === "undefined") return "light";
    return window.matchMedia("(prefers-color-scheme: dark)").matches
      ? "dark"
      : "light";
  }
  return mode;
}

function applyResolved(resolved: ResolvedTheme) {
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

function applyPalette(palette: Palette) {
  document.documentElement.setAttribute("data-palette", palette);
}

export function ThemeProvider({ children }: { children: React.ReactNode }) {
  const [mode, setModeState] = useState<ThemeMode>("light");
  const [resolved, setResolved] = useState<ResolvedTheme>("light");
  const [palette, setPaletteState] = useState<Palette>(DEFAULT_PALETTE);
  const [customThemeId, setCustomThemeId] = useState<string | null>(null);

  // Sync from storage on mount. The pre-paint script already applied the class +
  // attribute (+ custom tokens) — we just align React state with what's in the DOM.
  useEffect(() => {
    const storedMode = readStoredMode();
    setModeState(storedMode);
    setResolved(resolveMode(storedMode));
    const storedPalette = readStoredPalette();
    setPaletteState(storedPalette);
    if (storedPalette === "custom") {
      setCustomThemeId(window.localStorage.getItem(CUSTOM_ID_KEY));
    }
  }, []);

  // When mode is "system", track OS-level changes live.
  useEffect(() => {
    if (mode !== "system" || typeof window === "undefined") return;
    const mql = window.matchMedia("(prefers-color-scheme: dark)");
    const handler = () => {
      const next: ResolvedTheme = mql.matches ? "dark" : "light";
      setResolved(next);
      applyResolved(next);
    };
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [mode]);

  const setMode = useCallback((next: ThemeMode) => {
    setModeState(next);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MODE_KEY, next);
    }
    const r = resolveMode(next);
    setResolved(r);
    applyResolved(r);
  }, []);

  const setPalette = useCallback((next: Exclude<Palette, "custom">) => {
    setPaletteState(next);
    setCustomThemeId(null);
    if (typeof window !== "undefined") {
      window.localStorage.setItem(PALETTE_KEY, next);
      window.localStorage.removeItem(CUSTOM_ID_KEY);
    }
    removeCustomThemeStyle();
    applyPalette(next);
  }, []);

  const applyCustomTheme = useCallback(
    (id: string, tokens: DocThemeTokens, preferredMode?: ResolvedTheme) => {
      setPaletteState("custom");
      setCustomThemeId(id);
      if (typeof window !== "undefined") {
        window.localStorage.setItem(PALETTE_KEY, "custom");
        window.localStorage.setItem(CUSTOM_ID_KEY, id);
        window.localStorage.setItem(CUSTOM_TOKENS_KEY, JSON.stringify(tokens));
      }
      applyCustomThemeStyle(tokens);
      applyPalette("custom");
      // A theme carries a light/dark intent (a "dark theme"). On a user-initiated
      // apply, flip the doc mode to match so the page actually renders that
      // way — both variants stay available via the mode toggle afterwards.
      if (preferredMode) setMode(preferredMode);
    },
    [setMode],
  );

  const value = useMemo<ThemeContextValue>(
    () => ({ mode, resolved, setMode, palette, setPalette, customThemeId, applyCustomTheme }),
    [mode, resolved, setMode, palette, setPalette, customThemeId, applyCustomTheme],
  );

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error("useTheme must be used inside <ThemeProvider>");
  return ctx;
}
