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
  from: string; to: string; inputTokens: number; outputTokens: number;
  cacheReadTokens: number; cacheWriteTokens: number;
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
  const fields = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheWriteTokens"] as const;
  return <section className="space-y-4" aria-busy={loading || revalidating}>
    <div className="flex items-center justify-between gap-3">
      <h2 className="text-lg font-semibold">{t.title}</h2>
      <Button className="min-h-11" variant="outline" disabled={revalidating} onClick={() => void refresh()}>{t.refresh}</Button>
    </div>
    <p className="text-sm text-muted-foreground">{t.period}</p>
    <p className="text-sm text-muted-foreground">{t.description}</p>
    {error != null && <p role="alert" className="text-sm text-destructive">{t.error}</p>}
    {loading && <GridSurfaceSkeleton cards={4} chrome={false} />}
    {data && <>
      <p className="text-xs text-muted-foreground">{new Date(data.from).toLocaleString(locale)} – {new Date(data.to).toLocaleString(locale)}</p>
      <dl className="grid grid-cols-1 sm:grid-cols-2 gap-4">
        {fields.map((field) => <div key={field} className="rounded-lg border border-border p-4">
          <dt className="text-sm text-muted-foreground">{t[field]}</dt>
          <dd className="text-2xl font-semibold tabular-nums">{data[field].toLocaleString(locale)}</dd>
        </div>)}
      </dl>
      {fields.every((field) => data[field] === 0) && <p className="text-sm text-muted-foreground">{t.empty}</p>}
    </>}
  </section>;
}
