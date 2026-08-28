"use client";

import { useT } from "@/lib/i18n/client";

export function LocaleSwitcher() {
  const t = useT();
  const setLocale = (locale: string) => {
    document.cookie = `locale=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
    window.location.reload();
  };
  return <div className="languages" aria-label={t.common.language}>{["en", "ja", "zh"].map((locale) => <button type="button" key={locale} onClick={() => setLocale(locale)}>{locale.toUpperCase()}</button>)}</div>;
}
