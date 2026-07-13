"use client";

// [COMP:app-web/plan-gate] — see docs/architecture/platform/cost-and-pricing.md
// → "No free plan: the hosted paid gate (2026-07-10)"
//
// Full-screen gate over the workspace shell for HOSTED workspaces with no
// active plan (`plan === 'free'`). The server already blocks assistant
// compute for these workspaces (the closed credit gate rejects every turn);
// this overlay explains that state and routes the user to the trial / plan
// checkout on the marketing `/plans` page, or to the open-source self-host
// alternative. "Continue browsing" dismisses it for the session — data is
// never hostage, only compute — and the OSS edition never renders it
// (`planGateApplies` is false for `edition === 'oss'`).

import { useEffect, useState } from "react";
import { LockIcon, ExternalLinkIcon } from "lucide-react";
import { isHostedEdition } from "@/lib/edition";
import { planGateApplies, planGateDismissKey } from "@/lib/plan-gate";
import { getUsage } from "@/lib/api/usage";
import { webAppUrl } from "@/lib/primary-auth";
import { useT } from "@/lib/i18n/client";

const OSS_REPO_URL = "https://github.com/sidanclaw/sidanclaw";

export function PlanGate({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const edition = isHostedEdition() ? ("hosted" as const) : ("oss" as const);
  const [plan, setPlan] = useState<string | null>(null);
  const [trialEligible, setTrialEligible] = useState(false);
  const [dismissed, setDismissed] = useState(true);

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
  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-background/80 backdrop-blur-sm p-6">
      <div className="w-full max-w-md rounded-2xl border border-border bg-card p-8 shadow-lg">
        <div className="w-12 h-12 rounded-xl bg-primary/10 flex items-center justify-center mb-5">
          <LockIcon className="w-6 h-6 text-primary" />
        </div>
        <h2 className="text-lg font-semibold">{g.title}</h2>
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
            className="block w-full text-center text-sm font-medium bg-primary text-primary-foreground px-4 py-2.5 rounded-lg hover:bg-primary/90 transition-colors"
          >
            {trialEligible ? g.startTrial : g.choosePlan}
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
          onClick={() => {
            sessionStorage.setItem(planGateDismissKey(workspaceId), "1");
            setDismissed(true);
          }}
          className="block w-full text-center text-xs text-muted-foreground hover:text-foreground transition-colors mt-4"
        >
          {g.continueBrowsing}
        </button>
      </div>
    </div>
  );
}
