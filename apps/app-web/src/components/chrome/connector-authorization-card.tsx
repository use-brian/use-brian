"use client";

import { useEffect, useRef, useState } from "react";
import { ArrowUpRight, Loader2 } from "lucide-react";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import type { PendingQuestionAction } from "@/lib/api/pending-questions";
import type { PendingQuestionDict } from "./pending-question-panel";
import { desktopBridge } from "@/lib/desktop-auth-source";
import { openConnectorAuthorization, supportsInlineConnector } from "@/lib/connector-authorization-popup";

/** Shared full-chat/dock checkpoint. [COMP:app-web/connector-authorization] */
export function ConnectorAuthorizationCard({ action, sessionId, approvalId, dict, cancelling, error, onAnswered, onCancel }: {
  action: PendingQuestionAction;
  sessionId: string;
  approvalId: string;
  dict: PendingQuestionDict;
  cancelling: boolean;
  error: string | null;
  onAnswered: () => void;
  onCancel: () => void;
}) {
  const [waiting, setWaiting] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);
  const cleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => { cleanup.current?.(); }, [sessionId, approvalId, action.provider]);
  const connect = () => {
    if (cancelling) return;
    if (!supportsInlineConnector(action.provider) || desktopBridge()?.connectConnector) {
      window.location.assign(action.connectPath);
      return;
    }
    cleanup.current?.();
    setConnectError(null);
    setWaiting(true);
    cleanup.current = openConnectorAuthorization({
      action, sessionId, approvalId,
      onComplete: () => { setWaiting(false); onAnswered(); },
      onError: (reason) => {
        setWaiting(false);
        setConnectError(reason === "blocked" ? dict.connectBlocked : reason === "unconfigured" ? dict.connectUnavailable : reason === "closed" ? dict.connectClosed : dict.connectFailed);
      },
    });
  };
  return <section aria-label={dict.connect.replace("{connector}", action.label)} className="w-full max-w-md rounded-2xl border border-border/70 bg-background px-4 pt-4 pb-2">
    <div className="flex items-center gap-3">
      <div aria-hidden className="flex size-10 shrink-0 items-center justify-center [&>svg]:size-9 [&>img]:size-9 [&>img]:object-contain">
        <ConnectorIcon connectorId={action.provider} />
      </div>
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold leading-snug text-foreground">{action.label}</h3>
        <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{dict.connectPrompt}</p>
      </div>
      <button type="button" onClick={connect} aria-label={waiting || connectError ? dict.connectRetry : dict.connect.replace("{connector}", action.label)} disabled={cancelling} className="inline-flex min-h-11 md:min-h-9 shrink-0 items-center justify-center gap-1.5 rounded-full bg-action px-3.5 py-2 text-xs font-medium text-action-foreground transition-colors hover:bg-action/90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50">
        {waiting || connectError ? dict.connectRetry : dict.connectAction}<ArrowUpRight className="size-3.5" aria-hidden />
      </button>
    </div>
    {waiting && <p role="status" className="mt-3 flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="size-4 animate-spin motion-reduce:animate-none" aria-hidden />{dict.connectWaiting}</p>}
    {(connectError || error) && <p role="alert" className="mt-3 text-sm text-destructive">{connectError || error}</p>}
    <div className="mt-2 flex items-center justify-between gap-3">
      <p className="text-xs leading-relaxed text-muted-foreground">{dict.connectHelp}</p>
      <button type="button" onClick={onCancel} disabled={cancelling} className="min-h-11 min-w-11 md:min-h-8 md:min-w-0 shrink-0 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring disabled:opacity-50">{cancelling ? dict.cancelling : dict.cancel}</button>
    </div>
  </section>;
}
