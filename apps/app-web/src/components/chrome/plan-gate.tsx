"use client";

// [COMP:app-web/plan-gate] — see docs/architecture/platform/cost-and-pricing.md
// → "No free plan: the hosted paid gate (2026-07-10)"
//
// Full-screen gate over the workspace shell for HOSTED workspaces with no
// active plan (`plan === 'free'`). The server already blocks assistant
// compute for these workspaces (the closed credit gate rejects every turn);
// this overlay explains that state and routes the user to the trial / plan
// checkout directly, or to the open-source self-host alternative. Eligible
// workspaces get an animated Brian welcome; post-trial workspaces get the
// quieter plan-required card. "Explore first" dismisses it for the session —
// data is never hostage, only compute — and the OSS edition never renders it.

import { useEffect, useState, type CSSProperties } from "react";
import {
  ArrowRightIcon,
  CheckIcon,
  ExternalLinkIcon,
  LoaderCircleIcon,
  LockIcon,
  SparklesIcon,
} from "lucide-react";
import { isHostedEdition } from "@/lib/edition";
import {
  planGateApplies,
  planGateDismissKey,
  planGateTrialCheckoutBody,
} from "@/lib/plan-gate";
import { getUsage } from "@/lib/api/usage";
import { authFetch } from "@/lib/auth-fetch";
import { webAppUrl } from "@/lib/primary-auth";
import { useT } from "@/lib/i18n/client";
import styles from "./plan-gate.module.css";

const OSS_REPO_URL = "https://github.com/use-brian/use-brian";
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

function BrianTrialMascot() {
  return (
    <div className={styles.mascotWrap} aria-hidden="true">
      <span className={styles.mascotAura} />
      <span className={styles.mascotOrbit} />
      <span className={`${styles.sparkle} ${styles.sparkleOne}`} />
      <span className={`${styles.sparkle} ${styles.sparkleTwo}`} />
      <span className={`${styles.sparkle} ${styles.sparkleThree}`} />
      <svg
        className={styles.mascot}
        viewBox="0 0 160 160"
        role="presentation"
      >
        <defs>
          <linearGradient id="brian-trial-body" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#66f2ff" />
            <stop offset="0.48" stopColor="#10d8ea" />
            <stop offset="1" stopColor="#00a9ca" />
          </linearGradient>
          <filter id="brian-trial-glow" x="-60%" y="-60%" width="220%" height="220%">
            <feGaussianBlur stdDeviation="5" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g className={styles.mascotShadow}>
          <ellipse cx="80" cy="143" rx="42" ry="7" fill="rgba(4, 31, 47, 0.28)" />
        </g>
        <g className={styles.mascotBody} filter="url(#brian-trial-glow)">
          <path
            d="M60 28h40v12h20v20h20v40h-20v20h-20v20H88v-20H72v20H60v-20H40v-20H20V60h20V40h20V28Z"
            fill="url(#brian-trial-body)"
          />
          <path d="M60 28h40v12H60zM40 40h20v20H40z" fill="rgba(255,255,255,.22)" />
          <path d="M100 40h20v20h-20zM120 60h20v40h-20z" fill="rgba(0,87,117,.14)" />
          <g className={styles.mascotEyes} fill="#062333">
            <rect x="53" y="72" width="12" height="14" rx="1" />
            <rect x="95" y="72" width="12" height="14" rx="1" />
          </g>
          <path className={styles.mascotSmile} d="M69 97c6 7 16 7 22 0" fill="none" stroke="#062333" strokeWidth="5" strokeLinecap="round" />
          <path className={styles.mascotCheek} d="M44 94h10M106 94h10" stroke="#ff86a7" strokeWidth="5" strokeLinecap="round" opacity=".8" />
        </g>
        <g className={styles.mascotWave}>
          <rect x="134" y="66" width="13" height="36" rx="4" fill="#10d8ea" />
          <rect x="140" y="49" width="13" height="24" rx="4" fill="#66f2ff" />
        </g>
      </svg>
    </div>
  );
}

export function PlanGate({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const edition = isHostedEdition() ? ("hosted" as const) : ("oss" as const);
  const [plan, setPlan] = useState<string | null>(null);
  const [trialEligible, setTrialEligible] = useState(false);
  const [dismissed, setDismissed] = useState(true);
  const [checkoutPending, setCheckoutPending] = useState(false);
  const [checkoutError, setCheckoutError] = useState(false);

  useEffect(() => {
    // OSS builds never fetch — the gate cannot apply there.
    if (edition === "oss") return;
    let cancelled = false;
    setDismissed(
      sessionStorage.getItem(planGateDismissKey(workspaceId)) === "1",
    );
    void getUsage(workspaceId).then((usage) => {
      if (cancelled || !usage?.plan) return;
      setPlan(usage.plan);
      setTrialEligible(usage.trialEligible === true);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, edition]);

  if (!planGateApplies(edition, plan) || dismissed) return null;

  const g = t.planGate;

  const dismiss = () => {
    sessionStorage.setItem(planGateDismissKey(workspaceId), "1");
    setDismissed(true);
  };

  const startTrial = async () => {
    if (checkoutPending) return;
    setCheckoutPending(true);
    setCheckoutError(false);
    try {
      const res = await authFetch(`${API_URL}/api/billing/checkout`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(planGateTrialCheckoutBody(workspaceId)),
      });
      const data = (await res.json().catch(() => ({}))) as { url?: string };
      if (!res.ok || !data.url) {
        setCheckoutError(true);
        return;
      }
      window.location.assign(data.url);
    } catch {
      setCheckoutError(true);
    } finally {
      setCheckoutPending(false);
    }
  };

  if (trialEligible) {
    const benefits = [g.benefitCredits, g.benefitPro, g.benefitTime];
    return (
      <div className={`${styles.backdrop} ${styles.trialBackdrop}`} role="dialog" aria-modal="true" aria-labelledby="trial-welcome-title">
        <div className={styles.ambient} aria-hidden="true">
          <span className={`${styles.ambientBlob} ${styles.ambientBlobOne}`} />
          <span className={`${styles.ambientBlob} ${styles.ambientBlobTwo}`} />
          <span className={`${styles.ambientBlob} ${styles.ambientBlobThree}`} />
          <span className={styles.grid} />
        </div>

        <div className={styles.trialCard}>
          <div className={styles.mascotStage}>
            <div className={styles.pixelTrail} aria-hidden="true">
              {Array.from({ length: 8 }, (_, index) => (
                <span key={index} style={{ "--pixel-index": index } as CSSProperties} />
              ))}
            </div>
            <BrianTrialMascot />
            <div className={styles.greetingBubble}>{g.greeting}</div>
          </div>

          <div className={styles.trialContent}>
            <div className={styles.eyebrow}>
              <SparklesIcon aria-hidden="true" />
              {g.eyebrow}
            </div>
            <h1 id="trial-welcome-title" className={styles.trialTitle}>{g.welcomeTitle}</h1>
            <p className={styles.trialBody}>{g.welcomeBody}</p>

            <div className={styles.benefitGrid}>
              {benefits.map((benefit) => (
                <div key={benefit} className={styles.benefit}>
                  <span className={styles.benefitCheck}><CheckIcon aria-hidden="true" /></span>
                  {benefit}
                </div>
              ))}
            </div>

            <button type="button" className={styles.trialCta} onClick={() => void startTrial()} disabled={checkoutPending}>
              {checkoutPending ? (
                <>
                  <LoaderCircleIcon className={styles.spinner} aria-hidden="true" />
                  {g.startingTrial}
                </>
              ) : (
                <>
                  {g.startTrial}
                  <ArrowRightIcon aria-hidden="true" />
                </>
              )}
            </button>
            <p className={styles.noCard}>{g.noCard}</p>
            {checkoutError && <p className={styles.checkoutError} role="alert">{g.checkoutError}</p>}

            <button type="button" onClick={dismiss} className={styles.exploreButton}>
              {g.exploreFirst}
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm p-6" role="dialog" aria-modal="true" aria-labelledby="plan-required-title">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-lg">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-5">
          <LockIcon className="w-6 h-6 text-primary" />
        </div>
        <h2 id="plan-required-title" className="text-lg font-semibold">{g.title}</h2>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          {g.body}
        </p>
        <p className="text-sm text-muted-foreground mt-2 leading-relaxed">
          {g.dataNote}
        </p>
        <div className="mt-6 space-y-3">
          <a
            href={`${webAppUrl()}/plans`}
            target="_blank"
            rel="noopener noreferrer"
            className="block w-full text-center text-sm font-medium bg-action text-action-foreground px-4 py-2.5 rounded-lg hover:bg-action/90 transition-colors"
          >
            {g.choosePlan}
          </a>
          <a
            href={OSS_REPO_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center justify-center gap-2 w-full text-center text-sm font-medium border border-border px-4 py-2.5 rounded-lg hover:bg-muted transition-colors"
          >
            {g.selfHost}
            <ExternalLinkIcon className="w-3.5 h-3.5" aria-hidden />
          </a>
        </div>
        <button
          onClick={dismiss}
          className="block w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors mt-4"
        >
          {g.continueBrowsing}
        </button>
      </div>
    </div>
  );
}
