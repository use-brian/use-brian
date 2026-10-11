"use client";

/**
 * WeChat connect - one QR-paired iLink bot per person.
 *
 * Two modes: "Connect my WeChat" (`self`, any member, the default) and
 * "Prepare for a staff member" (`admin_prepare`, owners/admins). Poll-based
 * (not SSE like WhatsApp) because iLink's login machine has a mid-flow input
 * state (`need_verifycode`). Polling only READS: when iLink confirms, the
 * person sees the signed-in account and workspace and confirms explicitly;
 * that finalize is the one call that saves anything. A prepared connection
 * never links the admin - it hands back a link the staff member opens after
 * signing in. Bot tokens never reach the browser.
 *
 * Spec: docs/architecture/channels/wechat.md → "Connect flow", "Staff identity".
 * Component tag: [COMP:app-web/studio-wechat].
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  finalizeWechatPairing,
  getWechatPairingStatus,
  startWechatPairing,
  submitWechatVerifyCode,
  wechatPreparedLink,
  WechatPairingError,
  type WechatPairingMode,
} from "@/lib/api/channels";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type Phase =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "qr"; url: string }
  | { kind: "scanned" }
  | { kind: "verify"; rejected: boolean }
  | { kind: "confirm" }
  | { kind: "finalizing" }
  | { kind: "connected"; mode: WechatPairingMode; channelId: string; connectorError: string | null }
  | { kind: "already_bound" }
  | { kind: "expired" }
  | { kind: "error"; code: string };

const POLL_MS = 1500;

function errorCode(e: unknown): string {
  if (e instanceof WechatPairingError) {
    if (e.status === 502 || e.status === 503) return "unavailable";
    return e.code;
  }
  return "error";
}

export function WechatConnectTab({
  workspaceId,
  defaultAssistantId,
  canPrepareForStaff,
  accountLabel,
  workspaceName,
  onConnected,
  pollMs = POLL_MS,
}: {
  workspaceId: string;
  defaultAssistantId: string | null;
  /** Owner/admin: may prepare a connection for a staff member. */
  canPrepareForStaff: boolean;
  /** The signed-in account, named before a self connection is confirmed. */
  accountLabel: string;
  workspaceName: string;
  onConnected: (channelId: string) => void;
  /** Test seam. */
  pollMs?: number;
}) {
  const t = useT();
  const wc = t.studioPage.channels.add.wechat;
  const limits = t.studioPage.channels.wechat;
  const [mode, setMode] = useState<WechatPairingMode>("self");
  const [phase, setPhase] = useState<Phase>({ kind: "idle" });
  const [verifyCode, setVerifyCode] = useState("");
  const [copied, setCopied] = useState(false);
  const pairingIdRef = useRef<string | null>(null);
  const stopRef = useRef(false);

  // Strict Mode mounts, unmounts and mounts again before the user touches
  // anything: reset the latch on the way IN, or the first poll exits at once
  // and nothing is ever saved (graded: invariants/strict-mode-unmount-latch).
  useEffect(() => {
    stopRef.current = false;
    return () => {
      stopRef.current = true;
    };
  }, []);

  const poll = useCallback(
    async (pairingId: string) => {
      while (!stopRef.current && pairingIdRef.current === pairingId) {
        try {
          const status = await getWechatPairingStatus(workspaceId, pairingId);
          if (stopRef.current || pairingIdRef.current !== pairingId) return;
          if (status.status === "confirmed") {
            setPhase({ kind: "confirm" });
            return;
          }
          if (status.status === "qr" && status.qrcodeUrl) setPhase({ kind: "qr", url: status.qrcodeUrl });
          else if (status.status === "scanned") setPhase({ kind: "scanned" });
          else if (status.status === "need_verifycode") setPhase({ kind: "verify", rejected: false });
          else if (status.status === "verify_code_rejected") setPhase({ kind: "verify", rejected: true });
          else if (status.status === "already_bound") { setPhase({ kind: "already_bound" }); return; }
          else if (status.status === "expired") { setPhase({ kind: "expired" }); return; }
          else if (status.status === "error") { setPhase({ kind: "error", code: "error" }); return; }
        } catch (e) {
          if (stopRef.current || pairingIdRef.current !== pairingId) return;
          setPhase({ kind: "error", code: errorCode(e) });
          return;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
    },
    [workspaceId, pollMs],
  );

  const start = useCallback(() => {
    setPhase({ kind: "loading" });
    setVerifyCode("");
    setCopied(false);
    void startWechatPairing(workspaceId, { mode, defaultAssistantId })
      .then((started) => {
        pairingIdRef.current = started.pairingId;
        setPhase({ kind: "qr", url: started.qrcodeUrl });
        void poll(started.pairingId);
      })
      .catch((e: unknown) => setPhase({ kind: "error", code: errorCode(e) }));
  }, [workspaceId, mode, defaultAssistantId, poll]);

  const finalize = useCallback(() => {
    const pairingId = pairingIdRef.current;
    if (!pairingId) return;
    setPhase({ kind: "finalizing" });
    void finalizeWechatPairing(workspaceId, pairingId)
      .then((result) => {
        setPhase({ kind: "connected", mode: result.mode, channelId: result.channelId, connectorError: result.connectorError });
        onConnected(result.channelId);
      })
      .catch((e: unknown) => setPhase({ kind: "error", code: errorCode(e) }));
  }, [workspaceId, onConnected]);

  const submitCode = useCallback(() => {
    const pairingId = pairingIdRef.current;
    const code = verifyCode.trim();
    if (!pairingId || !code) return;
    setPhase({ kind: "scanned" });
    setVerifyCode("");
    void submitWechatVerifyCode(workspaceId, pairingId, code).catch((e: unknown) => {
      setPhase({ kind: "error", code: errorCode(e) });
    });
  }, [workspaceId, verifyCode]);

  const errorText = (code: string): string =>
    code === "binding_conflict" ? wc.errorBindingConflict
      : code === "other_workspace" ? wc.errorOtherWorkspace
        : code === "duplicate_transport" ? wc.errorDuplicate
          : code === "missing_sender" ? wc.errorMissingSender
            : code === "admin_required" || code === "forbidden" ? wc.errorAdminRequired
              : code === "assistant_unavailable" ? wc.errorAssistantUnavailable
                : code === "unavailable" ? wc.errorUnavailable
                  : wc.error;

  const busy = phase.kind !== "idle" && phase.kind !== "error" && phase.kind !== "expired"
    && phase.kind !== "already_bound" && phase.kind !== "connected";
  const preparedLink = phase.kind === "connected" && phase.mode === "admin_prepare" && typeof window !== "undefined"
    ? wechatPreparedLink(window.location.origin, workspaceId, phase.channelId)
    : null;

  return (
    <div className="flex flex-col gap-3" data-testid="wechat-connect">
      <p className="text-xs text-muted-foreground">{wc.hint}</p>
      <ul className="flex flex-col gap-0.5 text-xs text-muted-foreground list-disc pl-4">
        <li>{limits.limitOnePerPerson}</li>
        <li>{limits.limitContact}</li>
        <li>{limits.limitDmsOnly}</li>
        <li>{limits.limitNoHistory}</li>
        <li>{limits.limitSingleConnection}</li>
      </ul>

      {canPrepareForStaff && (phase.kind === "idle" || phase.kind === "error" || phase.kind === "expired") && (
        <div role="radiogroup" aria-label={wc.modeLabel} className="grid gap-2 sm:grid-cols-2">
          {(["self", "admin_prepare"] as const).map((value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={mode === value}
              onClick={() => setMode(value)}
              className={`min-h-11 md:min-h-0 rounded-lg border px-3 py-2 text-left ${mode === value ? "border-foreground bg-muted/50" : "border-border hover:bg-muted/30"}`}
            >
              <span className="block text-sm font-medium">{value === "self" ? wc.modeSelf : wc.modeAdmin}</span>
              <span className="block text-[12px] text-muted-foreground">{value === "self" ? wc.modeSelfDesc : wc.modeAdminDesc}</span>
            </button>
          ))}
        </div>
      )}

      {phase.kind === "qr" ? (
        <div className="flex flex-col items-center gap-2 self-center py-2">
          <div className="rounded-lg bg-white p-3">
            <QRCodeSVG value={phase.url} size={208} />
          </div>
          <p className="max-w-xs text-center text-xs text-muted-foreground">
            {mode === "self" ? wc.scanHint : wc.scanHintAdmin}
          </p>
        </div>
      ) : phase.kind === "loading" ? (
        <p className="py-4 text-center text-sm text-muted-foreground">{wc.loading}</p>
      ) : phase.kind === "scanned" || phase.kind === "finalizing" ? (
        <p className="py-4 text-center text-sm text-muted-foreground">
          {phase.kind === "scanned" ? wc.verifying : wc.finalizing}
        </p>
      ) : phase.kind === "verify" ? (
        <div className="flex flex-col gap-2 self-center py-2">
          <p className="max-w-xs text-center text-sm">
            {phase.rejected ? wc.verifyRejected : wc.verifyPrompt}
          </p>
          <div className="flex items-center gap-2 self-center">
            <input
              type="text"
              inputMode="numeric"
              aria-label={wc.verifyPrompt}
              value={verifyCode}
              onChange={(e) => setVerifyCode(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitCode();
              }}
              maxLength={8}
              className="w-28 text-center text-[16px] md:text-sm rounded-md border border-border bg-background px-2 py-1.5 font-mono tracking-widest"
            />
            <button
              type="button"
              onClick={submitCode}
              disabled={!verifyCode.trim()}
              className="min-h-11 md:min-h-0 rounded-md bg-action px-3 py-1.5 text-sm font-medium text-action-foreground disabled:opacity-50"
            >
              {wc.verifySubmit}
            </button>
          </div>
        </div>
      ) : phase.kind === "confirm" ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border p-3" data-testid="wechat-confirm">
          <p className="text-sm font-medium">{mode === "self" ? wc.confirmTitle : wc.confirmAdminTitle}</p>
          <p className="text-[12px] text-muted-foreground">
            {mode === "self"
              ? format(wc.confirmSelf, { account: accountLabel, workspace: workspaceName })
              : wc.confirmAdmin}
          </p>
          <button
            type="button"
            onClick={finalize}
            className="min-h-11 md:min-h-0 self-start rounded-md bg-action px-3 py-1.5 text-sm font-medium text-action-foreground"
          >
            {mode === "self" ? wc.confirmAction : wc.confirmAdminAction}
          </button>
        </div>
      ) : phase.kind === "connected" ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium text-emerald-600 dark:text-emerald-400">
            {phase.mode === "self" ? wc.connected : wc.preparedTitle}
          </p>
          {preparedLink && (
            <>
              <p className="text-[12px] text-muted-foreground">{wc.preparedHint}</p>
              <div className="flex flex-wrap items-center gap-2">
                <code className="min-w-0 flex-1 break-all rounded bg-muted/50 px-2 py-1 text-[11px]">{preparedLink}</code>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard?.writeText(preparedLink).then(() => setCopied(true), () => {});
                  }}
                  className="min-h-11 md:min-h-0 rounded-md border border-border px-3 py-1.5 text-sm"
                >
                  {copied ? wc.linkCopied : wc.copyLink}
                </button>
              </div>
            </>
          )}
          {phase.connectorError && (
            <p className="text-xs text-amber-600 dark:text-amber-400">{wc.connectorWarning}</p>
          )}
        </div>
      ) : phase.kind === "already_bound" ? (
        <p className="text-sm text-muted-foreground">{wc.alreadyBound}</p>
      ) : phase.kind === "expired" || phase.kind === "error" ? (
        <div className="flex flex-wrap items-center gap-3">
          <span className="text-xs text-destructive">
            {phase.kind === "expired" ? wc.expired : errorText(phase.code)}
          </span>
          <button
            type="button"
            onClick={start}
            className="min-h-11 md:min-h-0 rounded-md bg-action px-3 py-1.5 text-sm font-medium text-action-foreground"
          >
            {wc.retry}
          </button>
        </div>
      ) : null}

      {phase.kind === "idle" && (
        <button
          type="button"
          onClick={start}
          disabled={busy}
          className="min-h-11 md:min-h-0 self-start rounded-md bg-action px-3 py-1.5 text-sm font-medium text-action-foreground"
        >
          {mode === "self" ? wc.startAction : wc.startAdminAction}
        </button>
      )}
    </div>
  );
}
