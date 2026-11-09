"use client";

/** Reuse tool-request presentation, never its execution/resume authority. */
import { useEffect, useRef, useState } from "react";
import { ChatConfirmationCard } from "./chat-confirmation-card";
import { respondByKind } from "@/lib/api/approvals";
import type { ExternalActionConfirmation as Request } from "@/lib/api/pending-questions";
import { requestApprovalsRefresh } from "@/lib/approvals-events";
import { useT } from "@/lib/i18n/client";

export function ExternalActionConfirmation({ workspaceId, request, onResolved }: {
  workspaceId: string;
  request: Request;
  onResolved?: () => void;
}) {
  const t = useT().chatApp.approvalReview;
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<"approved" | "rejected" | "changed" | null>(null);
  const [error, setError] = useState(false);
  const expiry = Date.parse(request.expiresAt);
  const [expired, setExpired] = useState(!Number.isFinite(expiry) || expiry <= Date.now());
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    const remaining = expiry - Date.now();
    setExpired(!Number.isFinite(remaining) || remaining <= 0);
    const timer = Number.isFinite(remaining) && remaining > 0
      ? setTimeout(() => setExpired(true), Math.min(remaining, 2_147_483_647)) : undefined;
    return () => { mounted.current = false; clearTimeout(timer); };
  }, [expiry]);

  const decide = async (decision: "approved" | "rejected") => {
    if (locked.current || result || !Number.isFinite(expiry) || expiry <= Date.now()) return;
    locked.current = true;
    setBusy(true);
    setError(false);
    try {
      const response = await respondByKind({ id: request.approvalId, kind: "external_action" }, decision);
      if (!mounted.current) return;
      if (response.ok) {
        setResult(decision);
        onResolved?.();
      } else if ("status" in response && [403, 404, 409, 410].includes(response.status ?? 0)) {
        // A competing decision/revocation is not this person's successful choice.
        setResult("changed");
        onResolved?.();
      } else {
        setError(true);
      }
      requestApprovalsRefresh(workspaceId);
    } catch {
      if (mounted.current) setError(true);
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  if (result) return <p role="status" className="text-xs text-muted-foreground">{result === "approved" ? t.allowed : result === "rejected" ? t.denied : t.changed}</p>;
  return (
    <div data-external-confirmation={request.approvalId}>
      <ChatConfirmationCard
        confirmation={{
          toolCallId: `external:${request.approvalId}`,
          approvalId: request.approvalId,
          toolName: "external_action",
          displayName: request.title,
          description: request.message,
          displayLines: request.options,
          input: {},
          sessionId: "",
          allowPersistentApproval: false,
          status: busy ? "approving" : "pending",
        }}
        approveLabel={request.options?.[0] ?? t.allow}
        denyLabel={request.options?.[1] ?? t.deny}
        approvingLabel={t.allowing}
        disabled={expired}
        allowComment={false}
        showInput={false}
        onApprove={() => void decide("approved")}
        onDeny={() => void decide("rejected")}
      />
      {expired && <p role="status" className="text-xs text-muted-foreground">{t.expired}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{t.decisionFailed}</p>}
    </div>
  );
}
