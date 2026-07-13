"use client";

// [COMP:app-web/settings-usage-section] — see docs/architecture/platform/cost-and-pricing.md
// Ported from apps/web/src/app/(app)/settings/usage/page.tsx (UsagePage →
// UsageSection) as part of the settings consolidation
// (docs/architecture/features/doc.md §5a). Scoped to the active
// workspace via the app-web `useWorkspaceContext()` (single-workspace per
// route), mirroring the BillingSection — apps/web reads `useWorkspaces()`
// because it is multi-workspace.

import { useState, useEffect, useCallback } from "react";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { useT, useLocale } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";
import {
  getUsage,
  startExtraUsageCheckout,
  EMPTY_CREDITS,
  type Credits,
} from "@/lib/api/usage";

// Display strings for the prepaid extra-usage pack. Source of truth:
// EXTRA_USAGE_PACK_CREDITS / EXTRA_USAGE_PACK_USD in the platform's
// billing/credit-usage.ts (cost-and-pricing.md -> "Extra usage packs").
const EXTRA_USAGE_PACK_CREDITS_LABEL = "2,500";
const EXTRA_USAGE_PACK_PRICE_LABEL = "$100";

// Plans that can buy a pack: an active self-service paid plan. "" = still
// loading, "free" = no active plan (subscribe first), enterprise = negotiated.
const PACK_ELIGIBLE_PLANS = new Set(["pro", "max_5x", "max_10x"]);

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
  const [plan, setPlan] = useState("");
  const [credits, setCredits] = useState<Credits>(EMPTY_CREDITS);
  const [loading, setLoading] = useState(true);
  const [lastUpdatedAt, setLastUpdatedAt] = useState<number | null>(null);
  const [buying, setBuying] = useState(false);
  const [buyError, setBuyError] = useState<string | null>(null);
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
          // `'free'` is the no-active-plan state, not a plan name — keep the
          // raw value here and translate at render time.
          setPlan(data.plan);
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

  /**
   * Open Stripe Checkout for one extra-usage pack. The server enforces
   * owner + active-paid-plan; error codes map to dictionary copy here.
   */
  const buyExtraUsage = useCallback(async () => {
    if (!workspaceId || buying) return;
    setBuyError(null);
    setBuying(true);
    const result = await startExtraUsageCheckout(workspaceId);
    if ("url" in result) {
      window.location.href = result.url;
      return;
    }
    setBuyError(
      result.error === "not_workspace_owner"
        ? t.settings.usage.extraUsageOwnerOnly
        : result.error === "no_active_plan"
          ? t.settings.usage.extraUsageNeedsPlan
          : t.settings.usage.extraUsageError,
    );
    setBuying(false);
  }, [workspaceId, buying, t]);

  const usageDict = t.settings.usage as unknown as Record<string, string>;
  const extraCredits = credits.extra ?? 0;
  // Purchased pack credits extend the period's allowance — the bar and the
  // "{used} of {cap}" label show the effective cap the gate enforces.
  const effectiveCap = credits.cap === null ? null : credits.cap + extraCredits;
  const creditsLabel =
    effectiveCap === null
      ? format(t.settings.usage.creditsUncapped, { used: credits.used.toLocaleString() })
      : format(t.settings.usage.creditsOfCap, {
          used: credits.used.toLocaleString(),
          cap: effectiveCap.toLocaleString(),
        });
  const canBuyExtraUsage = PACK_ELIGIBLE_PLANS.has(plan.toLowerCase());

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-lg font-semibold">{t.settings.usage.title}</h2>
        <span className="text-sm text-muted-foreground">
          {plan === ""
            ? ""
            : plan.toLowerCase() === "free"
              ? t.settings.billing.noPlanTitle
              : plan.charAt(0).toUpperCase() + plan.slice(1)}
        </span>
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
        {extraCredits > 0 && (
          <p className="text-xs text-muted-foreground mt-2">
            {format(t.settings.usage.extraIncluded, {
              extra: extraCredits.toLocaleString(),
            })}
          </p>
        )}
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

      {/* Extra usage pack — prepaid, current billing cycle only. Shown for
          active self-service paid plans; the server re-enforces owner +
          plan on POST /api/billing/extra-usage/checkout. */}
      {canBuyExtraUsage && (
        <div className="border-t border-border pt-6">
          <div className="flex items-start justify-between gap-4">
            <div className="flex-1 min-w-0">
              <h3 className="text-sm font-semibold">
                {t.settings.usage.extraUsageTitle}
              </h3>
              <p className="text-xs text-muted-foreground mt-0.5">
                {format(t.settings.usage.extraUsageDesc, {
                  credits: EXTRA_USAGE_PACK_CREDITS_LABEL,
                  price: EXTRA_USAGE_PACK_PRICE_LABEL,
                })}
              </p>
              <p className="text-xs text-muted-foreground mt-1">
                {t.settings.usage.extraUsageNote}
              </p>
            </div>
            <button
              onClick={buyExtraUsage}
              disabled={buying}
              className="text-sm font-medium border border-border px-4 py-2 rounded-lg hover:bg-muted transition-colors shrink-0 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {buying
                ? t.settings.usage.buyExtraUsageOpening
                : t.settings.usage.buyExtraUsage}
            </button>
          </div>
          {buyError && <p className="text-xs text-destructive mt-2">{buyError}</p>}
        </div>
      )}
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
