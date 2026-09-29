"use client";

import { useEffect } from "react";
import { Button } from "@/components/ui/button";
import { GridSurfaceSkeleton } from "@/components/chrome/surface-skeleton";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { useLocale, useT } from "@/lib/i18n/client";
import { authFetch } from "@/lib/auth-fetch";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { SurfaceCacheEvictionError, useCachedResource } from "@/lib/surface-cache";
import { tokenUsageCacheKey } from "@/lib/surface-prefetch";

type TokenUsage = {
  from: string; to: string; estimatedCostUsd: number | null; hasUnpricedUsage: boolean;
  models: Array<{ model: string; modelName: string; tokens: number;
    estimatedCostUsd: number | null; hasUnpricedUsage: boolean }>;
};

export function TokenUsageSection() {
  const t = useT().tokenUsage;
  const locale = useLocale();
  const { workspaceId } = useWorkspaceContext();
  const { data, error, loading, revalidating, refresh } = useCachedResource<TokenUsage>(
    tokenUsageCacheKey(workspaceId), async () => {
      const base = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";
      const response = await authFetch(`${base}/api/workspaces/${encodeURIComponent(workspaceId)}/token-usage`);
      if ([401, 403, 404].includes(response.status)) throw new SurfaceCacheEvictionError(response.status);
      if (!response.ok) throw new Error("token_usage_failed");
      return response.json();
    },
  );
  useEffect(() => {
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);
  const usd = new Intl.NumberFormat(locale, { style: "currency", currency: "USD", currencyDisplay: "code", maximumFractionDigits: 6 });
  const cost = (value: number | null) => value === null ? t.unavailable
    : value > 0 && value < 0.000001 ? `< ${usd.format(0.000001)}` : usd.format(value);
  return <section className="space-y-4" aria-busy={loading || revalidating}>
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">{t.title}</h2>
      <Button className="min-h-11" variant="outline" disabled={revalidating} onClick={() => void refresh()}>{t.refresh}</Button>
    </div>
    <p className="text-sm text-muted-foreground">{t.period}</p>
    <p className="text-sm text-muted-foreground">{t.description}</p>
    {error != null && <p role="alert" className="text-sm text-destructive">{t.error}</p>}
    {loading && <GridSurfaceSkeleton cards={1} chrome={false} />}
    {data && <>
      <p className="text-xs text-muted-foreground">{new Date(data.from).toLocaleString(locale)} – {new Date(data.to).toLocaleString(locale)}</p>
      <div className="rounded-lg border border-border p-4">
        <p className="text-sm text-muted-foreground">{t.total}</p>
        <p className="text-2xl font-semibold tabular-nums">{cost(data.estimatedCostUsd)}</p>
        {data.hasUnpricedUsage && <p className="text-sm text-muted-foreground">{t.partial}</p>}
      </div>
      {data.models.length === 0 ? <p className="text-sm text-muted-foreground">{t.empty}</p> :
        <table className="w-full table-fixed text-sm">
          <thead><tr className="border-b border-border text-left">
            <th scope="col" className="py-3 pr-2 w-2/5">{t.model}</th>
            <th scope="col" className="py-3 pr-2 text-right">{t.tokens}</th>
            <th scope="col" className="py-3 text-right">{t.cost}</th>
          </tr></thead>
          <tbody>{data.models.map((model) => <tr key={model.model} className="border-b border-border">
            <th scope="row" className="py-3 pr-2 text-left font-medium break-words" title={model.model}>{model.modelName}</th>
            <td className="py-3 pr-2 text-right tabular-nums break-words">{model.tokens.toLocaleString(locale)}</td>
            <td className="py-3 text-right tabular-nums break-words">
              {cost(model.estimatedCostUsd)}
              {model.hasUnpricedUsage && model.estimatedCostUsd !== null && <span className="block text-xs text-muted-foreground">{t.partialCost}</span>}
            </td>
          </tr>)}</tbody>
        </table>}
    </>}
  </section>;
}
