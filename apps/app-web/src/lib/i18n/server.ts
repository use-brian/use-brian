import "server-only";

import { cookies, headers } from "next/headers";
import { isLocale, LOCALE_COOKIE, matchLocale, type Locale } from "./config";
import { getDictionary, type Dictionary } from "./dictionaries";

/**
 * Resolve the current locale from the `locale` cookie, falling back to
 * negotiation against `Accept-Language`, then to the default locale.
 *
 * In production the cookie scope is `.sidan.ai`, so app-web sees
 * whatever apps/web's switcher last set. In dev (separate `localhost`
 * origins) app-web reads its own cookie or `Accept-Language`.
 */
export async function getLocale(): Promise<Locale> {
  const store = await cookies();
  const fromCookie = store.get(LOCALE_COOKIE)?.value;
  if (isLocale(fromCookie)) return fromCookie;
  const h = await headers();
  return matchLocale(h.get("accept-language"));
}

export async function getServerDictionary(): Promise<{
  locale: Locale;
  dict: Dictionary;
}> {
  const locale = await getLocale();
  return { locale, dict: getDictionary(locale) };
}
