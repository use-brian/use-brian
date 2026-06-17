/**
 * SDK for the doc custom-themes routes (`packages/api/src/routes/doc-themes.ts`,
 * migration 225). Thin typed wrappers over `authFetch` so token refresh is
 * transparent — same shape as `lib/api/views.ts`.
 *
 * Wire types are declared locally (not imported from `@sidanclaw/shared`) to
 * keep the browser bundle lean; the server Zod schemas are the authoritative
 * contract. The token maps mirror `@sidanclaw/shared` `CustomThemePayload`.
 *
 * See docs/architecture/features/doc-custom-themes.md.
 *
 * [COMP:app-web/doc-themes-sdk]
 */

import { authFetch } from "@/lib/auth-fetch";
import type { DocThemeTokens } from "@/lib/theme";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type ThemeMoodSeed = "light" | "dark" | "vivid" | "muted";
export type ThemeAppearance = "light" | "dark";

export type DocThemeSeed = {
  name: string;
  description?: string;
  primary: string;
  accent: string;
  neutral: string;
  /** Lightness axis — which doc mode the theme reads as by default. Optional
   *  for themes generated before this field existed (fall back via {@link themeAppearance}). */
  appearance?: ThemeAppearance;
  mood: ThemeMoodSeed;
};

/**
 * The light/dark doc mode a theme wants by default. Prefers the explicit
 * `appearance`; falls back to the `mood` for older seeds (where `dark` was the
 * only signal of intent). Mirrors `seedAppearance` in `@sidanclaw/shared` — kept
 * local so the browser bundle doesn't pull in the shared package (see the wire-type
 * note above).
 */
export function themeAppearance(seed: DocThemeSeed): ThemeAppearance {
  return seed.appearance ?? (seed.mood === "dark" ? "dark" : "light");
}

export type DocTheme = {
  id: string;
  workspaceId: string;
  createdBy: string;
  name: string;
  description: string | null;
  prompt: string;
  seed: DocThemeSeed;
  tokens: DocThemeTokens;
  createdAt: string;
  updatedAt: string;
};

/** Distinguishable failures so the dialog can show the right message. */
export type DocThemeErrorCode =
  | "limit_reached"
  | "generation_failed"
  | "unavailable"
  | "unknown";

export class DocThemeError extends Error {
  code: DocThemeErrorCode;
  constructor(code: DocThemeErrorCode, message: string) {
    super(message);
    this.name = "DocThemeError";
    this.code = code;
  }
}

function errorCodeForStatus(status: number, body: { code?: string }): DocThemeErrorCode {
  if (status === 409 || body.code === "theme_limit_reached") return "limit_reached";
  if (status === 422) return "generation_failed";
  if (status === 503) return "unavailable";
  return "unknown";
}

async function readJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let body: { error?: string; code?: string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* non-JSON error body */
    }
    throw new DocThemeError(
      errorCodeForStatus(res.status, body),
      body.error ?? `HTTP ${res.status}`,
    );
  }
  return (await res.json()) as T;
}

export async function listDocThemes(workspaceId: string): Promise<DocTheme[]> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${workspaceId}/doc-themes`,
  );
  const body = await readJson<{ themes: DocTheme[] }>(res);
  return body.themes;
}

export async function createDocTheme(
  workspaceId: string,
  prompt: string,
): Promise<DocTheme> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${workspaceId}/doc-themes`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ prompt }),
    },
  );
  const body = await readJson<{ theme: DocTheme }>(res);
  return body.theme;
}

export async function refineDocTheme(
  id: string,
  instruction: string,
): Promise<DocTheme> {
  const res = await authFetch(`${API_URL}/api/doc-themes/${id}/refine`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ instruction }),
  });
  const body = await readJson<{ theme: DocTheme }>(res);
  return body.theme;
}

export async function renameDocTheme(
  id: string,
  name: string,
): Promise<DocTheme> {
  const res = await authFetch(`${API_URL}/api/doc-themes/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name }),
  });
  const body = await readJson<{ theme: DocTheme }>(res);
  return body.theme;
}

export async function deleteDocTheme(id: string): Promise<void> {
  const res = await authFetch(`${API_URL}/api/doc-themes/${id}`, {
    method: "DELETE",
  });
  if (!res.ok && res.status !== 204) {
    await readJson(res); // throws DocThemeError
  }
}
