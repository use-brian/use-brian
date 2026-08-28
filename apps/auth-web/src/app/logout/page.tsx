import { portalConfig } from "@/lib/config";
import { safeReturnUrl } from "@/lib/origins";
import { serverI18n } from "@/lib/i18n/server";

export default async function LogoutPage({ searchParams }: { searchParams: Promise<{ next?: string }> }) {
  const params = await searchParams;
  const config = portalConfig();
  const next = safeReturnUrl(params.next, config);
  const { dictionary: t } = await serverI18n();
  return <main className="shell"><section className="card"><div className="brand">{t.common.product}</div><h1 className="title">{t.logout.title}</h1><p className="body">{t.logout.body}</p><form className="stack" method="POST" action="/api/auth/logout">{next ? <input type="hidden" name="next" value={next.toString()} /> : null}<button className="button" type="submit">{t.logout.confirm}</button><a className="link" href={next?.toString() ?? config.appOrigin}>{t.logout.cancel}</a></form></section></main>;
}
