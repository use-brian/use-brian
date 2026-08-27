import Link from "next/link";
import { I18nProvider } from "@/lib/i18n/client";
import { dictionaryFor, normalizeLocale } from "@/lib/i18n/server";

export default async function VerifyPage({ searchParams }: { searchParams: Promise<{ token?: string; lang?: string; next?: string }> }) {
  const params = await searchParams;
  const locale = normalizeLocale(params.lang);
  const t = dictionaryFor(locale);
  return <I18nProvider dictionary={t}><main className="shell"><section className="card"><div className="brand">{t.common.product}</div><h1 className="title">{t.login.confirmHeading}</h1><p className="body">{t.login.confirmBody}</p>{params.token ? <form className="stack" method="POST" action="/api/auth/email/verify"><input type="hidden" name="token" value={params.token} />{params.next ? <input type="hidden" name="next" value={params.next} /> : null}<button className="button" type="submit">{t.login.confirmButton}</button></form> : <p className="message error">{t.login.missingToken} <Link className="link" href="/login">{t.login.requestNew}</Link></p>}</section></main></I18nProvider>;
}
