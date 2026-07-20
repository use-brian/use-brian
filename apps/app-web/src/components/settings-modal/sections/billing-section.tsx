"use client";

// Ported from apps/web/src/app/(app)/settings/billing/page.tsx
// — see docs/architecture/platform/cost-and-pricing.md

import { useCallback, useEffect, useState } from "react";
import {
  CreditCardIcon,
  SparklesIcon,
  ZapIcon,
  CrownIcon,
  UsersIcon,
} from "lucide-react";
import { authFetch, refreshUserCookie } from "@/lib/auth-fetch";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { useT, useLocale } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";
import { webAppUrl } from "@/lib/primary-auth";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// Deep-link target for `/plans`, which still lives in the marketing app
// (apps/web). `webAppUrl()` resolves the prod-safe base (usebrian.ai in prod)
// instead of an inline localhost fallback — that fallback is what sent prod
// clicks to http://localhost:3000. `/redeem` is NOT here: it moved in-app, so
// the redeem link below is same-origin.
const WEB_APP = webAppUrl();

// Sales inbox for all Contact-sales CTAs. Mirrors the same constant in
// apps/web/src/app/plans/page.tsx.
const SALES_MAILTO = "mailto:contact@sidan.io";

// ── Plan config ──────────────────────────────────────────────

type PlanId = "free" | "pro" | "max_5x" | "max_10x" | "enterprise";

type PlanConfig = {
  id: PlanId;
  name: string;
  price: string;
  tagline: string;
  features: string[];
  Icon: typeof SparklesIcon;
};

const PLANS: PlanConfig[] = [
  {
    // Not a plan since the Free-plan removal (2026-07-10) — the "no active
    // plan" state (fresh signup pre-trial, post-trial, post-cancel). The
    // header special-cases it to `noPlanTitle`; assistant compute is paused
    // server-side until a paid plan is active.
    id: "free",
    name: "No plan",
    price: "$0",
    tagline: "Subscribe to activate this workspace",
    features: [],
    Icon: SparklesIcon,
  },
  {
    id: "pro",
    name: "Pro",
    price: "$20/mo",
    tagline: "For regular personal use across channels",
    features: [
      "Gemini Pro default",
      "Unlimited memories",
      "All channels",
      "Scheduled jobs",
      "MCP connectors",
    ],
    Icon: ZapIcon,
  },
  {
    id: "max_5x",
    name: "Max 5x",
    price: "$100/mo",
    tagline: "5x more usage than Pro",
    features: [
      "Max model toggle",
      "Higher usage cap",
      "Unlimited scheduled jobs",
      "Unlimited connectors",
    ],
    Icon: CrownIcon,
  },
  {
    id: "max_10x",
    name: "Max 10x",
    price: "$200/mo",
    tagline: "10x more usage than Pro",
    features: [
      "Max model toggle",
      "Highest usage cap",
      "Unlimited scheduled jobs",
      "Unlimited connectors",
      "Priority access at peak times",
    ],
    Icon: CrownIcon,
  },
  {
    id: "enterprise",
    name: "Enterprise",
    price: "Custom",
    tagline: "Custom capacity with volume pricing",
    features: [
      "Custom credit allocation",
      "SSO, audit log, security policies",
      "Shared memory across teammates and agents",
    ],
    Icon: UsersIcon,
  },
];

const PLAN_MAP: Record<PlanId, PlanConfig> = Object.fromEntries(
  PLANS.map((p) => [p.id, p]),
) as Record<PlanId, PlanConfig>;

// ── API types ─────────────────────────────────────────────────

type SubscriptionResponse = {
  plan: PlanId;
  status: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  paymentFailedAt: string | null;
  /** True when the subscription is in `trialing` status. During a trial,
   *  `currentPeriodEnd` is the trial end / first-charge date — exposed
   *  separately as `trialEndsAt` for clarity. */
  isTrialing: boolean;
  trialEndsAt: string | null;
  paymentMethod: { brand: string; last4: string } | null;
};

type Invoice = {
  id: string;
  date: string;
  totalUsd: number;
  currency: string;
  status: string | null;
  hostedUrl: string | null;
};

// Auth + refresh is handled by `authFetch` in @/lib/auth-fetch. We only
// need a JSON Content-Type header for POST bodies here.
const JSON_HEADERS = { "Content-Type": "application/json" };

/**
 * Format an ISO date string as "Apr 22, 2026" for the renewal line.
 * Falls back to a generic message when the date is null or unparseable.
 */
function formatRenewalDate(
  iso: string | null,
  dict: { autoRenewOn: string; autoRenewGeneric: string },
  locale: string,
): string {
  if (!iso) return dict.autoRenewGeneric;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return dict.autoRenewGeneric;
  const formatted = d.toLocaleDateString(locale === "ja" ? "ja-JP" : "en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
  return format(dict.autoRenewOn, { date: formatted });
}

function formatInvoiceDate(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatMoney(amount: number, currency: string): string {
  try {
    return new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: currency.toUpperCase(),
    }).format(amount);
  } catch {
    return `$${amount.toFixed(2)}`;
  }
}

function capitalize(s: string | null): string {
  if (!s) return "";
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Format an ISO date as "Apr 22, 2026", or null when unparseable/absent. */
function formatShortDate(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (isNaN(d.getTime())) return null;
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ── Section ───────────────────────────────────────────────────

export function BillingSection() {
  const t = useT();
  const locale = useLocale();
  // Billing is per-workspace (migration 143) — scoped to the active
  // workspace from the doc workspace context.
  const { workspaceId } = useWorkspaceContext();
  const [plan, setPlan] = useState<PlanId>("free");
  const [loading, setLoading] = useState(true);
  const [subscription, setSubscription] = useState<SubscriptionResponse | null>(
    null,
  );
  const [invoices, setInvoices] = useState<Invoice[]>([]);
  const [portalSubmitting, setPortalSubmitting] = useState(false);
  const [portalError, setPortalError] = useState<string | null>(null);

  const fetchBillingState = useCallback(async () => {
    if (!workspaceId) return;
    const ws = encodeURIComponent(workspaceId);
    try {
      const [subRes, invRes] = await Promise.all([
        authFetch(`${API_URL}/api/billing/subscription?workspace_id=${ws}`),
        authFetch(`${API_URL}/api/billing/invoices?workspace_id=${ws}`),
      ]);

      if (subRes.ok) {
        const sub = (await subRes.json()) as SubscriptionResponse;
        setSubscription(sub);
        if (sub.plan && sub.plan in PLAN_MAP) setPlan(sub.plan);
      }
      // 401 here is expected for guest users — authFetch has already
      // attempted a refresh and cleared the user cookie if it failed.
      // We silently keep the free-plan default state.
      if (invRes.ok) {
        const data = (await invRes.json()) as { invoices: Invoice[] };
        setInvoices(data.invoices ?? []);
      }
    } catch (err) {
      console.error("[billing] fetch failed:", err);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    const ws = encodeURIComponent(workspaceId);
    async function init() {
      await fetchBillingState();

      // After a Stripe checkout/upgrade redirect, the webhook may not
      // have processed yet. Poll until the plan updates, then refresh
      // the user cookie so the chrome reflects the new plan.
      const params = new URLSearchParams(window.location.search);
      if (params.get("checkout") === "success") {
        for (let i = 0; i < 5; i++) {
          const res = await authFetch(
            `${API_URL}/api/billing/subscription?workspace_id=${ws}`,
          );
          if (res.ok) {
            const data = (await res.json()) as SubscriptionResponse;
            if (data.plan !== "free") {
              setSubscription(data);
              if (data.plan && data.plan in PLAN_MAP) setPlan(data.plan);
              break;
            }
          }
          await new Promise((r) => setTimeout(r, 2000));
        }
        await refreshUserCookie();
        // Strip the `checkout` query param without navigating away from
        // the current page (app-web URLs are page-scoped).
        const url = new URL(window.location.href);
        url.searchParams.delete("checkout");
        window.history.replaceState({}, "", url.toString());
      }
    }
    void init();
  }, [fetchBillingState, workspaceId]);

  /**
   * Open the Stripe Customer Portal for the current user. Used by all
   * paid-plan management actions: Update payment method, Adjust plan,
   * Cancel. The portal handles prorated upgrades, downgrades, cancels,
   * and card updates — all in one UI, no custom flows needed.
   *
   * Pass `flow: 'payment_method_update'` to deep-link into the
   * card-update screen — used by the Add/Update payment button so
   * promo-granted trial users can convert in one click.
   *
   * On 401 (no token or expired), authFetch redirects to login.
   */
  async function openPortal(flow?: "payment_method_update") {
    if (portalSubmitting || !workspaceId) return;
    setPortalError(null);
    setPortalSubmitting(true);
    try {
      const res = await authFetch(`${API_URL}/api/billing/portal`, {
        method: "POST",
        headers: JSON_HEADERS,
        body: JSON.stringify({
          workspace_id: workspaceId,
          ...(flow ? { flow } : {}),
        }),
      });
      if (res.status === 401) {
        // authFetch already tried refreshing and triggered a login
        // redirect; nothing more to do here.
        return;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(`Portal failed (${res.status}): ${text || "no body"}`);
      }
      const data = (await res.json()) as { url?: string };
      if (!data.url) throw new Error("Portal returned no URL");
      window.location.href = data.url;
    } catch (err) {
      console.error("[billing/portal] error:", err);
      setPortalError(
        err instanceof Error
          ? err.message
          : "Couldn't open the billing portal. Try again.",
      );
      setPortalSubmitting(false);
    }
  }

  const config = PLAN_MAP[plan];
  const isPaid = plan !== "free";
  // Enterprise is billed via invoice through our sales team — no Stripe
  // subscription, no self-service Cancel/Adjust flow. The billing page
  // swaps its payment/invoices/cancellation sections for sales-assisted
  // copy when the workspace is on Enterprise.
  const isContactSales = plan === "enterprise";
  const primaryAction = isContactSales
    ? t.settings.billing.contactSales
    : t.settings.billing.upgrade;

  const hasPaymentMethod = !!subscription?.paymentMethod;
  const isTrialing = !!subscription?.isTrialing;
  const trialEndsOn =
    isTrialing && subscription?.trialEndsAt
      ? formatShortDate(subscription.trialEndsAt)
      : null;
  const periodEndDate =
    formatShortDate(subscription?.currentPeriodEnd ?? null) ??
    t.settings.billing.endOfPeriod;
  const renewalLine = isContactSales
    ? t.settings.billing.renewalContactSales
    : !isPaid
      ? t.settings.billing.renewalFree
      : isTrialing && trialEndsOn
        ? format(t.settings.billing.renewalTrial, { date: trialEndsOn })
        : subscription?.cancelAtPeriodEnd
          ? format(t.settings.billing.renewalCancel, { date: periodEndDate })
          : formatRenewalDate(
              subscription?.currentPeriodEnd ?? null,
              t.settings.billing,
              locale,
            );

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">{t.settings.billing.title}</h2>

      {/* ── Plan header card ───────────────────────────────── */}
      <div className="border-t border-border pt-6">
        <div className="flex items-start gap-4">
          <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center shrink-0">
            <config.Icon className="w-6 h-6 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-base font-semibold">
              {plan === "free"
                ? t.settings.billing.noPlanTitle
                : format(t.settings.billing.planSuffix, { plan: config.name })}
            </div>
            {plan !== "free" ? (
              <div className="text-sm text-muted-foreground mt-0.5">
                {plan === "pro"
                  ? t.settings.billing.planTaglinePro
                  : plan === "max_5x"
                    ? t.settings.billing.planTaglineMax5x
                    : plan === "max_10x"
                      ? t.settings.billing.planTaglineMax10x
                      : plan === "enterprise"
                        ? t.settings.billing.planTaglineEnterprise
                        : config.tagline}
              </div>
            ) : null}
            <div className="text-sm text-muted-foreground mt-1">
              {renewalLine}
            </div>
          </div>
          {isContactSales ? (
            <a
              href={SALES_MAILTO}
              className="text-sm font-medium border border-border px-4 py-2 rounded-lg hover:bg-muted transition-colors shrink-0"
            >
              {primaryAction}
            </a>
          ) : (
            <a
              href={`${WEB_APP}/plans`}
              target="_blank"
              rel="noopener noreferrer"
              aria-disabled={loading}
              className={`text-sm font-medium border border-border px-4 py-2 rounded-lg hover:bg-muted transition-colors shrink-0 ${
                loading ? "opacity-50 pointer-events-none" : ""
              }`}
            >
              {primaryAction}
            </a>
          )}
        </div>
      </div>

      {/* ── Upgrade teasers ────────────────────────────────── */}
      {/* Surface the next tier(s) inline so Pro/Max users don't have
          to bounce to /plans just to see the upgrade path. Hidden on
          Free, Max+, Team, and during an active trial (trial users are
          deciding whether to keep their current plan first). */}
      {!isTrialing && (plan === "pro" || plan === "max_5x") && (
        <div className="border-t border-border pt-6">
          <h3 className="text-sm font-semibold mb-4">
            {t.settings.billing.upgradeTeasersTitle}
          </h3>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {(plan === "pro"
              ? (["max_5x", "max_10x"] as const)
              : (["max_10x"] as const)
            ).map((upgradeId) => {
              const upgrade = PLAN_MAP[upgradeId];
              return (
                <a
                  key={upgradeId}
                  href={`${WEB_APP}/plans`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-start gap-3 p-4 rounded-lg border border-border hover:border-primary/40 hover:bg-muted/40 transition-colors"
                >
                  <div className="w-10 h-10 rounded-lg bg-primary/10 flex items-center justify-center shrink-0">
                    <upgrade.Icon className="w-5 h-5 text-primary" />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-baseline gap-2">
                      <span className="text-sm font-semibold">
                        {upgrade.name}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {upgrade.price}
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      {upgrade.tagline}
                    </p>
                  </div>
                </a>
              );
            })}
          </div>
        </div>
      )}

      {/* ── Trial banner ────────────────────────────────────── */}
      {isTrialing && trialEndsOn && (
        <div className="border border-primary/30 bg-primary/5 rounded-lg p-4">
          <p className="text-sm font-medium text-foreground">
            {format(t.settings.billing.trialEndsOn, { date: trialEndsOn })}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {hasPaymentMethod
              ? format(t.settings.billing.trialChargeNotice, {
                  price: config.price,
                })
              : format(t.settings.billing.trialAddCardNotice, {
                  plan: config.name,
                })}
          </p>
          {!hasPaymentMethod && (
            <button
              onClick={() => openPortal("payment_method_update")}
              disabled={portalSubmitting}
              className="text-sm font-medium mt-3 bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-60"
            >
              {portalSubmitting
                ? t.settings.billing.opening
                : t.settings.billing.addPaymentMethod}
            </button>
          )}
        </div>
      )}

      {/* ── Payment failure warning ─────────────────────────── */}
      {subscription?.paymentFailedAt && (
        <div className="border border-destructive/30 bg-destructive/5 rounded-lg p-4">
          <p className="text-sm font-medium text-destructive">
            {t.settings.billing.paymentFailedTitle}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            {t.settings.billing.paymentFailedDesc}
          </p>
          <button
            onClick={() => openPortal("payment_method_update")}
            disabled={portalSubmitting}
            className="text-sm font-medium text-destructive underline mt-2 disabled:opacity-60"
          >
            {portalSubmitting
              ? t.settings.billing.opening
              : t.settings.billing.updatePaymentMethod}
          </button>
        </div>
      )}

      {/* ── Payment ────────────────────────────────────────── */}
      <div className="border-t border-border pt-6">
        <h3 className="text-sm font-semibold mb-4">
          {t.settings.billing.paymentTitle}
        </h3>
        <div className="flex items-center justify-between gap-4">
          <div className="flex items-center gap-3 min-w-0">
            <CreditCardIcon className="w-5 h-5 text-muted-foreground shrink-0" />
            <span className="text-sm text-muted-foreground truncate">
              {isContactSales
                ? t.settings.billing.billedByInvoice
                : hasPaymentMethod
                  ? `${capitalize(subscription!.paymentMethod!.brand)} •••• ${subscription!.paymentMethod!.last4}`
                  : t.settings.billing.noPaymentMethod}
            </span>
          </div>
          {/* Only paid non-team users see the Add/Update button — free
              users have no Stripe customer yet, so the portal can't be
              opened until they subscribe. */}
          {!isContactSales && isPaid && (
            <button
              onClick={() => openPortal("payment_method_update")}
              disabled={portalSubmitting}
              className="text-sm font-medium border border-border px-4 py-2 rounded-lg hover:bg-muted transition-colors shrink-0 disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {portalSubmitting
                ? t.settings.billing.opening
                : hasPaymentMethod
                  ? t.settings.billing.update
                  : t.settings.billing.add}
            </button>
          )}
        </div>
      </div>

      {/* ── Invoices ───────────────────────────────────────── */}
      <div className="border-t border-border pt-6">
        <h3 className="text-sm font-semibold mb-4">
          {t.settings.billing.invoicesTitle}
        </h3>
        {isContactSales ? (
          <div className="text-xs text-muted-foreground italic">
            {t.settings.billing.invoicesContactSales}
          </div>
        ) : invoices.length === 0 ? (
          <div className="text-xs text-muted-foreground italic">
            {t.settings.billing.noInvoices}
          </div>
        ) : (
          <div className="grid grid-cols-[1fr_auto_auto_auto] gap-x-6 gap-y-3 text-sm items-baseline">
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t.settings.billing.colDate}
            </div>
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">
              {t.settings.billing.colTotal}
            </div>
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
              {t.settings.billing.colStatus}
            </div>
            <div className="text-xs font-medium text-muted-foreground uppercase tracking-wider text-right">
              {t.settings.billing.colActions}
            </div>
            <div className="col-span-4 border-t border-border pt-3" />
            {invoices.map((inv) => (
              <InvoiceRow key={inv.id} invoice={inv} />
            ))}
          </div>
        )}
      </div>

      {/* ── Cancellation (paid plans only) ─────────────────── */}
      {/* Hidden while trialing without a card on file — Stripe will
          auto-cancel at trial end via end_behavior=cancel, so a manual
          Cancel button is redundant and confusing. */}
      {isPaid && !(isTrialing && !hasPaymentMethod) && (
        <div className="border-t border-border pt-6">
          <h3 className="text-sm font-semibold mb-4">
            {subscription?.cancelAtPeriodEnd
              ? t.settings.billing.reactivateTitle
              : t.settings.billing.cancellationTitle}
          </h3>
          <div className="flex items-center justify-between gap-4">
            <div className="flex-1">
              <div className="text-sm font-medium">
                {subscription?.cancelAtPeriodEnd
                  ? t.settings.billing.reactivatePlan
                  : t.settings.billing.cancelPlan}
              </div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {isContactSales
                  ? t.settings.billing.contactSalesCancelDesc
                  : subscription?.cancelAtPeriodEnd
                    ? format(t.settings.billing.reactivateDesc, {
                        date: periodEndDate,
                      })
                    : t.settings.billing.cancelDescDefault}
              </div>
            </div>
            {isContactSales ? (
              <a
                href={SALES_MAILTO}
                className="text-sm font-medium border border-border px-4 py-2 rounded-lg hover:bg-muted transition-colors shrink-0"
              >
                {t.settings.billing.contactSales}
              </a>
            ) : subscription?.cancelAtPeriodEnd ? (
              <button
                onClick={() => openPortal()}
                disabled={portalSubmitting}
                className="text-sm font-medium bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:bg-primary/90 transition-colors shrink-0 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {portalSubmitting
                  ? t.settings.billing.opening
                  : t.settings.billing.reactivate}
              </button>
            ) : (
              <button
                onClick={() => openPortal()}
                disabled={portalSubmitting}
                className="text-sm font-medium bg-destructive/90 text-destructive-foreground px-4 py-2 rounded-lg hover:bg-destructive transition-colors shrink-0 disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {portalSubmitting
                  ? t.settings.billing.opening
                  : t.settings.common.cancel}
              </button>
            )}
          </div>
        </div>
      )}

      {portalError && (
        <div className="border-t border-border pt-6">
          <p className="text-xs text-destructive">{portalError}</p>
        </div>
      )}

      <div className="border-t border-border pt-6">
        <p className="text-sm text-muted-foreground">
          {t.settings.billing.promoPrompt}{" "}
          <a
            href={`/redeem?ws=${encodeURIComponent(workspaceId)}`}
            className="text-foreground underline hover:no-underline"
          >
            {t.settings.billing.promoCta}
          </a>
          .
        </p>
      </div>
    </div>
  );
}

// ── Invoice row ──────────────────────────────────────────────

function InvoiceRow({ invoice }: { invoice: Invoice }) {
  const t = useT();
  const statusLabel = (() => {
    switch (invoice.status) {
      case "paid":
        return t.settings.billing.invoicePaid;
      case "open":
        return t.settings.billing.invoiceOpen;
      case "void":
        return t.settings.billing.invoiceVoid;
      case "failed":
      case "uncollectible":
        return t.settings.billing.invoiceFailed;
      default:
        return capitalize(invoice.status);
    }
  })();
  return (
    <>
      <div className="text-sm text-foreground">
        {formatInvoiceDate(invoice.date)}
      </div>
      <div className="text-sm text-foreground text-right tabular-nums">
        {formatMoney(invoice.totalUsd, invoice.currency)}
      </div>
      <div className="text-sm text-muted-foreground">{statusLabel}</div>
      <div className="text-right">
        {invoice.hostedUrl ? (
          <a
            href={invoice.hostedUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-foreground underline hover:no-underline"
          >
            {t.settings.billing.invoiceView}
          </a>
        ) : (
          <span className="text-sm text-muted-foreground">—</span>
        )}
      </div>
    </>
  );
}
