"use client";

// [COMP:app-web/settings-usage-section] — see docs/architecture/platform/cost-and-pricing.md
// Ported from apps/web/src/app/(app)/settings/usage/page.tsx (UsagePage →
// UsageSection) as part of the settings consolidation
// (docs/plans/doc-web-app-consolidation.md §5a). Scoped to the active
// workspace via the app-web `useWorkspaceContext()` (single-workspace per
// route), mirroring the BillingSection — apps/web reads `useWorkspaces()`
// because it is multi-workspace.

import { useState, useEffect, useCallback } from "react";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { useT, useLocale } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";
import { getUsage, EMPTY_CREDITS, type Credits } from "@/lib/api/usage";

/**
 * Format the billing-period reset as an absolute date, e.g. "Resets Jun 28".
 * `resetsAt` is the monthly billing-period end (weeks away, not hours), so we
 * never render an hour countdown here. Returns a placeholder when null.
 */
function formatResetDate(
  resetsAt: string | null,
  dict: Record<string, string>,
  locale: string,
  now: Date = new Date(),
): string {
  if (!resetsAt) return dict.noUsageYet;
  const reset = new Date(resetsAt);
  if (reset.getTime() - now.getTime() <= 0) return dict.resetting;
  const intl = locale === "ja" ? "ja-JP" : locale === "zh" ? "zh-Hant" : "en-US";
  const dateStr = reset.toLocaleDateString(intl, { month: "short", day: "numeric" });
  return dict.resetsOn.replace("{date}", dateStr);
}

function formatLastUpdated(ms: number | null, dict: Record<string, string>): string {
  if (ms === null) return dict.loading ?? "Loading";
  const age = Date.now() - ms;
  if (age < 60_000) return dict.justNow;
  const minutes = Math.floor(age / 60_000);
  if (minutes < 60) return dict.minAgo.replace("{minutes}", String(minutes));
  const hours = Math.floor(minutes / 60);
  return dict.hrAgo.replace("{hours}", String(hours));
}

export function UsageSection() {
  const t = useT();
  const locale = useLocale();
  const [plan, setPlan] = useState("Free");
  const [credits, setCredits] = useState<Credits>(EMPTY_CREDITS);
  const [loading, setLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  // Re-render once a minute so the reset date / "resetting now" state stays current.
  const [now, setNow] = useState(() => new Date());

  // Billing is per-workspace (migration 143) — usage is scoped to the active
  // workspace from the doc workspace context.
  const { workspaceId } = useWorkspaceContext();

  const fetchUsage = useCallback(() => {
    if (!workspaceId) return;
    getUsage(workspaceId)
      .then((data) => {
        if (!data) {
          setLoading(false);
          return;
        }
        if (data.plan) {
          setPlan(data.plan.charAt(0).toUpperCase() + data.plan.slice(1));
        }
        if (data.credits) setCredits({ ...EMPTY_CREDITS, ...data.credits });
        setLastUpdatedAt(Date.now());
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [workspaceId]);

  useEffect(() => {
    fetchUsage();
  }, [fetchUsage]);

  useEffect(() => {
    const tick = setInterval(() => setNow(new Date()), 60_000);
    return () => clearInterval(tick);
  }, []);

  const usageDict = t.settings.usage as unknown as Record<string, string>;
  const creditsLabel =
    credits.cap === null
      ? format(t.settings.usage.creditsUncapped, { used: credits.used.toLocaleString() })
      : format(t.settings.usage.creditsOfCap, {
          used: credits.used.toLocaleString(),
          cap: credits.cap.toLocaleString(),
        });

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t.settings.usage.title}</h2>
        <span className="text-sm text-muted-foreground">{plan}</span>
      </div>

      {/* Monthly credit allowance */}
      <div className="border-t border-border pt-6">
        <div className="mb-6">
          <h3 className="text-sm font-semibold">{t.settings.usage.creditAllowance}</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            {t.settings.usage.creditAllowanceDesc}
          </p>
        </div>
        <UsageBar
          label={creditsLabel}
          sublabel={formatResetDate(credits.resetsAt, usageDict, locale, now)}
          percent={credits.percent}
          uncapped={credits.cap === null}
          loading={loading}
        />
        <div className="flex items-center gap-1.5 text-xs text-muted-foreground mt-6">
          <span>
            {format(t.settings.usage.lastUpdated, {
              time: formatLastUpdated(lastUpdatedAt, usageDict),
            })}
          </span>
          <button
            onClick={fetchUsage}
            className="p-0.5 hover:text-foreground transition-colors"
            title={t.settings.usage.refresh}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 12 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden
            >
              <path d="M10 6a4 4 0 01-7.3 2.3M2 6a4 4 0 017.3-2.3" />
              <path d="M9.5 1.5V4H7M2.5 10.5V8H5" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Components ───────────────────────────────────────────────

function UsageBar({
  label,
  sublabel,
  percent,
  uncapped,
  loading,
}: {
  label: string;
  sublabel: string;
  percent: number;
  uncapped?: boolean;
  loading?: boolean;
}) {
  const t = useT();
  return (
    <div className="flex items-center gap-6">
      {/* Left column: label + sublabel */}
      <div className="w-44 shrink-0">
        <div className="text-sm font-semibold">{label}</div>
        <div className="text-xs text-muted-foreground mt-0.5">{sublabel}</div>
      </div>

      {/* Middle: progress bar */}
      <div className="flex-1 min-w-0">
        <div className="h-1.5 bg-muted rounded-full overflow-hidden">
          <div
            className="h-full bg-primary rounded-full transition-all"
            style={{ width: `${uncapped ? 0 : Math.min(percent, 100)}%` }}
          />
        </div>
      </div>

      {/* Right: percent used (or "Uncapped" for enterprise) */}
      <div className="w-16 shrink-0 text-right">
        <span className="text-sm text-muted-foreground tabular-nums">
          {loading ? (
            <span className="skeleton inline-block w-12 h-4" />
          ) : uncapped ? (
            t.settings.usage.uncapped
          ) : (
            format(t.settings.usage.percentUsed, { percent })
          )}
        </span>
      </div>
    </div>
  );
}
