"use client";

/**
 * Workspace-scoped provider for doc custom themes ("Get my own theme").
 *
 * Fetches the workspace's shared themes (capped at 5 server-side), and exposes
 * create / rename / delete / apply. Generation **applies + saves immediately**:
 * `createTheme` POSTs the prompt, then applies the returned tokens live via
 * `useTheme().applyCustomTheme`. On mount it re-applies the authoritative tokens
 * for whatever custom theme is currently selected (the pre-paint cache may be
 * stale, or the theme may have been edited by another member).
 *
 * Mounted inside `w/[workspaceId]/layout.tsx` (has the workspace id; nested
 * under the root <ThemeProvider>). The picker + settings consume it via
 * {@link useCustomThemes}.
 *
 * See docs/architecture/features/doc-custom-themes.md.
 *
 * [COMP:app-web/custom-themes-provider]
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { useTheme, type DocThemeTokens } from "@/lib/theme";
import {
  createDocTheme,
  deleteDocTheme,
  listDocThemes,
  refineDocTheme,
  renameDocTheme,
  themeAppearance,
  type DocTheme,
} from "@/lib/api/doc-themes";

type CustomThemesContextValue = {
  themes: DocTheme[];
  loading: boolean;
  /** True while a generation request is in flight. */
  generating: boolean;
  /** Generate, save, and apply a theme from a prompt. Throws DocThemeError. */
  createTheme: (prompt: string) => Promise<DocTheme>;
  /** Refine an existing theme by a follow-up instruction (in place). Re-applies
   *  if it's the active theme. Throws DocThemeError. */
  refineTheme: (id: string, instruction: string) => Promise<DocTheme>;
  renameTheme: (id: string, name: string) => Promise<void>;
  deleteTheme: (id: string) => Promise<void>;
  applyTheme: (theme: DocTheme) => void;
};

const CustomThemesContext = createContext<CustomThemesContextValue | null>(null);

export function CustomThemesProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: React.ReactNode;
}) {
  const { applyCustomTheme, customThemeId, setPalette } = useTheme();
  const [themes, setThemes] = useState<DocTheme[]>([]);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);

  useEffect(() => {
    let active = true;
    setLoading(true);
    listDocThemes(workspaceId)
      .then((list) => {
        if (!active) return;
        setThemes(list);
        // Re-apply the authoritative tokens for the active custom theme. If it
        // was deleted by another member we leave the cached tokens in place
        // rather than yank the theme out mid-session.
        const activeId = window.localStorage.getItem("doc:customThemeId");
        if (activeId) {
          const found = list.find((t) => t.id === activeId);
          if (found) applyCustomTheme(found.id, found.tokens);
        }
      })
      .catch(() => {
        // Themes are non-critical chrome — a fetch failure shouldn't block the
        // doc. The picker simply shows the built-in palettes.
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [workspaceId, applyCustomTheme]);

  // Live-apply when the doc chat's `refineActiveTheme` tool rebuilds the
  // active theme server-side: FloatingChat bridges the `doc_theme_update`
  // SSE to this window event, carrying the new tokens.
  useEffect(() => {
    function onThemeChanged(e: Event) {
      const detail = (e as CustomEvent).detail as
        | { themeId?: string; tokens?: DocThemeTokens; appearance?: "light" | "dark" }
        | undefined;
      if (!detail?.themeId || !detail.tokens) return;
      const { themeId, tokens, appearance } = detail;
      setThemes((prev) => prev.map((t) => (t.id === themeId ? { ...t, tokens } : t)));
      // A chat refine ("make it darker") is user-initiated — flip the doc
      // mode to the refined theme's intent when the server reported it.
      applyCustomTheme(themeId, tokens, appearance);
    }
    window.addEventListener("doc:theme-changed", onThemeChanged);
    return () => window.removeEventListener("doc:theme-changed", onThemeChanged);
  }, [applyCustomTheme]);

  const createTheme = useCallback(
    async (prompt: string) => {
      setGenerating(true);
      try {
        const theme = await createDocTheme(workspaceId, prompt);
        setThemes((prev) => [...prev, theme]);
        // Generation is a user-initiated apply: honour the theme's light/dark
        // intent so "fancy dark theme" actually renders dark.
        applyCustomTheme(theme.id, theme.tokens, themeAppearance(theme.seed));
        return theme;
      } finally {
        setGenerating(false);
      }
    },
    [workspaceId, applyCustomTheme],
  );

  const refineTheme = useCallback(
    async (id: string, instruction: string) => {
      setGenerating(true);
      try {
        const theme = await refineDocTheme(id, instruction);
        setThemes((prev) => prev.map((t) => (t.id === id ? theme : t)));
        // Re-apply live if the refined theme is the one currently showing —
        // honour its (possibly changed) light/dark intent, so "make it darker".
        if (customThemeId === id) {
          applyCustomTheme(theme.id, theme.tokens, themeAppearance(theme.seed));
        }
        return theme;
      } finally {
        setGenerating(false);
      }
    },
    [customThemeId, applyCustomTheme],
  );

  const renameTheme = useCallback(async (id: string, name: string) => {
    const updated = await renameDocTheme(id, name);
    setThemes((prev) => prev.map((t) => (t.id === id ? updated : t)));
  }, []);

  const deleteTheme = useCallback(
    async (id: string) => {
      await deleteDocTheme(id);
      setThemes((prev) => prev.filter((t) => t.id !== id));
      // If the deleted theme was the active one, revert to the default palette.
      if (customThemeId === id) setPalette("notion");
    },
    [customThemeId, setPalette],
  );

  const applyTheme = useCallback(
    (theme: DocTheme) =>
      applyCustomTheme(theme.id, theme.tokens, themeAppearance(theme.seed)),
    [applyCustomTheme],
  );

  const value = useMemo<CustomThemesContextValue>(
    () => ({ themes, loading, generating, createTheme, refineTheme, renameTheme, deleteTheme, applyTheme }),
    [themes, loading, generating, createTheme, refineTheme, renameTheme, deleteTheme, applyTheme],
  );

  return (
    <CustomThemesContext.Provider value={value}>
      {children}
    </CustomThemesContext.Provider>
  );
}

export function useCustomThemes(): CustomThemesContextValue {
  const ctx = useContext(CustomThemesContext);
  if (!ctx) {
    throw new Error("useCustomThemes must be used inside <CustomThemesProvider>");
  }
  return ctx;
}
