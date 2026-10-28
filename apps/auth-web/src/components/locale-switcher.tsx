"use client";

import { useEffect, useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";

export function LocaleSwitcher({ disabled = false }: { disabled?: boolean }) {
  const t = useT();
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const refreshing = useRef(false);
  useEffect(() => { if (!pending) refreshing.current = false; });
  const setLocale = (locale: string) => {
    if (disabled || refreshing.current) return;
    refreshing.current = true;
    document.cookie = `locale=${locale}; Path=/; Max-Age=31536000; SameSite=Lax`;
    startTransition(() => router.refresh());
  };
  const locales: Array<[string, string]> = [["en", "EN"], ["ja", "JA"], ["zh", "繁"], ["zh-CN", "简"]];
  return <div className="languages" aria-label={t.common.language}>{locales.map(([locale, label]) => <button type="button" key={locale} onClick={() => setLocale(locale)} disabled={disabled || pending}>{label}</button>)}</div>;
}
