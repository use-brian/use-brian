"use client";

import { useT } from "@/lib/i18n/client";

export function LocaleSwitcher() {
  const t = useT();
  const setLocale = (locale: string) => {
    document.cookie = `locale=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
    window.location.reload();
  };
  const locales: Array<[string, string]> = [["en", "EN"], ["ja", "JA"], ["zh", "繁"], ["zh-CN", "简"]];
  return <div className="languages" aria-label={t.common.language}>{locales.map(([locale, label]) => <button type="button" key={locale} onClick={() => setLocale(locale)}>{label}</button>)}</div>;
}
