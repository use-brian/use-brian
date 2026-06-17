/**
 * i18n configuration for apps/app-web.
 *
 * Locale is selected via the `locale` cookie (set on first visit
 * based on the request's `Accept-Language` header, or by the user via
 * the locale switcher in apps/web — app-web shares the cookie via
 * the `.sidan.ai` domain scope in production). No URL prefix.
 *
 * Mirrors `apps/web/src/lib/i18n/config.ts` — keep them in sync if you
 * add a locale.
 */

export const LOCALES = ["en", "zh", "ja"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_COOKIE = "locale";

/** 1 year — locale is a stable user preference, not a session value. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  zh: "繁體中文",
  ja: "日本語",
};

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

/**
 * Pick the best locale from an `Accept-Language` header. Honors quality
 * weights, matches on the primary subtag, falls back to
 * {@link DEFAULT_LOCALE}.
 */
export function matchLocale(acceptLanguage: string | null | undefined): Locale {
  if (!acceptLanguage) return DEFAULT_LOCALE;
  const ranked = acceptLanguage
    .split(",")
    .map((part) => {
      const [tag, ...params] = part.trim().split(";");
      const qParam = params.find((p) => p.trim().startsWith("q="));
      const q = qParam ? Number(qParam.split("=")[1]) : 1;
      return { tag: tag.toLowerCase(), q: Number.isFinite(q) ? q : 0 };
    })
    .filter((r) => r.tag)
    .sort((a, b) => b.q - a.q);
  for (const { tag } of ranked) {
    const primary = tag.split("-")[0];
    if (isLocale(primary)) return primary;
  }
  return DEFAULT_LOCALE;
}
