import { cookies, headers } from "next/headers";
import { en, ja, zh, zhCN, type Dictionary } from "./dictionaries";

export type Locale = "en" | "ja" | "zh" | "zh-CN";
const dictionaries: Record<Locale, Dictionary> = { en, ja, zh, "zh-CN": zhCN };

export function normalizeLocale(raw: string | null | undefined): Locale {
  const value = raw?.toLowerCase() ?? "";
  if (value.startsWith("ja")) return "ja";
  if (value.startsWith("zh-cn") || value.startsWith("zh-sg") || value.startsWith("zh-hans")) return "zh-CN";
  if (value.startsWith("zh")) return "zh";
  return "en";
}

export async function serverI18n(): Promise<{ locale: Locale; dictionary: Dictionary }> {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const locale = normalizeLocale(cookieStore.get("locale")?.value ?? headerStore.get("accept-language"));
  return { locale, dictionary: dictionaries[locale] };
}

export function dictionaryFor(locale: Locale): Dictionary {
  return dictionaries[locale];
}
