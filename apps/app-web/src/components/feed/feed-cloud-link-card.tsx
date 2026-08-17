"use client";

/** Paid hosted capability link for a self-hosted Feed. */

import { useEffect, useState } from "react";
import { ExternalLink, Link2, ShieldCheck } from "lucide-react";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import {
  pollFeedCloudLink,
  startFeedCloudLink,
  unlinkFeedCloud,
} from "@/lib/api/feed";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";

export function FeedCloudLinkCard({ assistantId }: { assistantId?: string }) {
  const team = useFeedWorkspace();
  const t = useT().feedPage.cloudLink;
  // Older embedded/test hosts may provide the pre-Cloud-Link context shape.
  // Treat that as native capability so this additive card stays invisible.
  const link = team.cloudLink ?? { state: "native" as const };
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (link.state !== "pending") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const next = await pollFeedCloudLink(team.workspaceId);
        if (!cancelled && next.state !== "pending") await team.refresh();
      } catch (pollError) {
        if (!cancelled) {
          setError(pollError instanceof Error ? pollError.message : t.pollFailed);
        }
      }
    };
    const timer = window.setInterval(() => void poll(), 3_000);
    void poll();
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [link.state, t.pollFailed, team]);

  if (link.state === "native") return null;

  async function start() {
    const target = assistantId ?? team.assistants[0]?.id;
    if (!target) {
      setError(t.voiceRequired);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await startFeedCloudLink(team.workspaceId, target);
      if (next.verificationUrl) {
        window.open(next.verificationUrl, "_blank", "noopener,noreferrer");
      }
      await team.refresh();
    } catch (startError) {
      setError(startError instanceof Error ? startError.message : t.startFailed);
    } finally {
      setBusy(false);
    }
  }

  async function unlink() {
    const confirmed = await confirmDialog({
      title: t.unlinkTitle,
      description: t.unlinkBody,
      confirmLabel: t.unlink,
      variant: "destructive",
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    try {
      await unlinkFeedCloud(team.workspaceId);
      await team.refresh();
    } catch (unlinkError) {
      setError(unlinkError instanceof Error ? unlinkError.message : t.unlinkFailed);
    } finally {
      setBusy(false);
    }
  }

  const linked = link.state === "linked";
  const pending = link.state === "pending";
  const planRequired = link.state === "plan_required";

  return (
    <section className="rounded-xl border border-border/60 bg-card p-4 shadow-xs">
      <div className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
          {linked ? <ShieldCheck className="size-4" /> : <Link2 className="size-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <h2 className="text-sm font-medium">
                {linked ? t.linkedTitle : planRequired ? t.planRequiredTitle : pending ? t.pendingTitle : t.title}
              </h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {linked
                  ? t.linkedBody.replace("{workspace}", link.hostedWorkspaceName ?? t.cloudWorkspace)
                  : planRequired
                    ? t.planRequiredBody
                    : pending
                      ? t.pendingBody
                      : t.body}
              </p>
            </div>
            {linked ? (
              <span className="rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300">
                {t.active}
              </span>
            ) : null}
          </div>

          {!linked && !pending && !planRequired ? (
            <div className="mt-3 rounded-lg border border-border/50 bg-muted/35 p-3 text-[11px] leading-relaxed text-muted-foreground">
              <p>{t.disclosureSent}</p>
              <p className="mt-1">{t.disclosureLocal}</p>
            </div>
          ) : null}

          {pending && link.userCode ? (
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <code className="rounded-md border border-border bg-muted px-2.5 py-1.5 text-sm font-semibold tracking-widest text-foreground">
                {link.userCode}
              </code>
              {link.verificationUrl ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => window.open(link.verificationUrl!, "_blank", "noopener,noreferrer")}
                >
                  {t.openApproval}
                  <ExternalLink className="size-3.5" />
                </Button>
              ) : null}
              <span className="text-[11px] text-muted-foreground">{t.waiting}</span>
            </div>
          ) : null}

          {error || link.error ? (
            <p className="mt-3 text-xs text-destructive">{error ?? link.error}</p>
          ) : null}

          <div className="mt-3 flex flex-wrap gap-2">
            {!linked && !pending ? (
              <Button type="button" size="sm" onClick={() => void start()} disabled={busy}>
                {busy ? t.starting : planRequired ? t.checkPlan : t.connect}
              </Button>
            ) : null}
            {linked || pending || planRequired ? (
              <Button type="button" size="sm" variant="ghost" onClick={() => void unlink()} disabled={busy}>
                {t.unlink}
              </Button>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}
