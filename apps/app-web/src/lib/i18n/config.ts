/**
 * i18n configuration for apps/app-web.
 *
 * Locale is selected via the `locale` cookie (set on first visit
 * based on the request's `Accept-Language` header, or by the user via
 * the locale switcher in apps/web — app-web shares the cookie via
 * the `.usebrian.ai` domain scope in production). No URL prefix.
 *
 * Mirrors `apps/web/src/lib/i18n/config.ts` — keep them in sync if you
 * add a locale.
 */

export const LOCALES = ["en", "zh", "zh-CN", "ja"] as const;
export type Locale = (typeof LOCALES)[number];

export const DEFAULT_LOCALE: Locale = "en";

export const LOCALE_COOKIE = "locale";

/** 1 year — locale is a stable user preference, not a session value. */
export const LOCALE_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

export const LOCALE_LABELS: Record<Locale, string> = {
  en: "English",
  zh: "繁體中文",
  "zh-CN": "简体中文",
  ja: "日本語",
};

export function isLocale(value: string | undefined | null): value is Locale {
  return !!value && (LOCALES as readonly string[]).includes(value);
}

/**
 * Resolve one lowercased `Accept-Language` tag to a supported locale.
 * Simplified-script tags (`zh-cn`, `zh-sg`, `zh-hans*`) resolve to
 * `zh-CN`; every other `zh-*` (and bare `zh`) resolves to `zh`, whose
 * dictionary holds Traditional Chinese.
 */
function resolveTag(tag: string): Locale | null {
  if (tag === "zh-cn" || tag === "zh-sg" || tag.startsWith("zh-hans")) {
    return "zh-CN";
  }
  const primary = tag.split("-")[0];
  if (primary === "zh") return "zh";
  return isLocale(primary) ? primary : null;
}

/**
 * Pick the best locale from an `Accept-Language` header. Honors quality
 * weights, matches per tag via {@link resolveTag}, falls back to
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
    const match = resolveTag(tag);
    if (match) return match;
  }
  return DEFAULT_LOCALE;
}
