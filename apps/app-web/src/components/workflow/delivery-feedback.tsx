"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

function ChannelsLink({ workspaceId }: { workspaceId?: string }) {
  const params = useParams();
  const routeWorkspace = params?.workspaceId;
  const id = workspaceId ?? (typeof routeWorkspace === "string" ? routeWorkspace : undefined);
  const t = useT();
  if (!id) return null;
  return (
    <Link className="inline-flex min-h-11 items-center text-primary underline" href={`/w/${encodeURIComponent(id)}/studio/channels`}>
      {t.workflowPage.builder.deliveryFeedback.settings}
    </Link>
  );
}

export function DeliveryAudienceGuidance() {
  const t = useT();
  return (
    <div className="text-sm text-muted-foreground">
      <p>{t.workflowPage.builder.deliveryFeedback.guidance}</p>
      <ChannelsLink />
    </div>
  );
}

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read only the public outcome contract. Private reasons/errors stay in raw JSON. */
export function DeliveryOutcomeFeedback({ output, workspaceId }: { output: unknown; workspaceId: string }) {
  const t = useT();
  const copy = t.workflowPage.builder.deliveryFeedback;
  if (!record(output) || !Object.hasOwn(output, "__delivery")) return null;
  const outcome = output.__delivery;
  const valid = record(outcome) && typeof outcome.channelType === "string" && (
    (outcome.status === "delivered" && typeof outcome.channelId === "string") ||
    (outcome.status === "skipped" && typeof outcome.reason === "string") ||
    (outcome.status === "failed" && typeof outcome.error === "string")
  );
  const status = valid ? outcome.status as "delivered" | "skipped" | "failed" : "unknown";
  const unverified = valid && status === "skipped" && outcome.reason === "delivery_audience_unverified";
  // Only known, coarse policy codes select copy. Never render raw server detail.
  const audienceMessage = unverified && outcome.detail === "unbound" ? copy.unbound
    : unverified && outcome.detail === "evidence_exceeds_audience" ? copy.evidenceExceedsAudience
      : copy.unverified;
  return (
    <div className={cn("rounded-md border p-3 text-sm", {
      "border-green-500/40 bg-green-500/5": status === "delivered",
      "border-amber-500/40 bg-amber-500/5": status === "skipped" || status === "unknown",
      "border-red-500/40 bg-red-500/5": status === "failed",
    })}>
      <p className="font-semibold">{copy[status]}</p>
      <p>{copy.generationNote}</p>
      {unverified && <><p>{audienceMessage}</p><ChannelsLink workspaceId={workspaceId} /></>}
    </div>
  );
}
