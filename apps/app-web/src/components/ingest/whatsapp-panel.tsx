"use client";

/**
 * Studio -> Ingestion: WhatsApp Bring-Your-Own-Number panel.
 *
 * Connect the workspace's own WhatsApp number (QR-linked companion device),
 * then enable specific team groups. Enabled groups are read silently into the
 * brain (entities/memories, attributed per sender); the assistant NEVER sends
 * on WhatsApp. Rendered at the top of the ingest control plane, above the
 * dynamic OAuth-connector sources, because BYO connect (QR) + per-group enable
 * is its own flow distinct from the generic source rows.
 *
 * Eligibility (connected-number presence): a group only becomes enable-able
 * once the connected number has been observed in it. The backend records that
 * into `seenChats` at intake, so the list here IS the eligible set - there is
 * no roster endpoint for a companion device.
 *
 * Backend: packages/api-platform/src/routes/whatsapp-ingest-admin.ts.
 * Spec: docs/architecture/channels/whatsapp.md -> "Read-only group ingest";
 * docs/plans/whatsapp-bring-your-own-number.md.
 *
 * [COMP:app-web/studio-whatsapp-ingest]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { Dialog } from "@base-ui/react/dialog";
import { QRCodeSVG } from "qrcode.react";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import {
  connectWhatsappIngest,
  disableWhatsappGroup,
  enableWhatsappGroup,
  getWhatsappIngest,
  type WhatsappGroup,
  type WhatsappGroupRouting,
  type WhatsappIngestStatus,
} from "@/lib/api/whatsapp-ingest";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

type Copy = ReturnType<typeof useT>["studioPage"]["ingestRules"]["whatsapp"];

/** Pairing modal phases. */
type ConnectPhase =
  | { kind: "loading" }
  | { kind: "qr"; value: string }
  | { kind: "expired" }
  | { kind: "error"; message: string };

export function WhatsappIngestPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const copy = t.studioPage.ingestRules.whatsapp;

  const [status, setStatus] = useState<WhatsappIngestStatus | null>(null);
  const [loadError, setLoadError] = useState(false);
  const [connecting, setConnecting] = useState(false);
  const [phase, setPhase] = useState<ConnectPhase>({ kind: "loading" });
  const abortRef = useRef<AbortController | null>(null);

  const load = useCallback(() => {
    if (!workspaceId) return;
    setLoadError(false);
    getWhatsappIngest(workspaceId)
      .then(setStatus)
      .catch(() => {
        setStatus({ connected: false, connectedNumber: null, groups: [] });
        setLoadError(true);
      });
  }, [workspaceId]);

  // After pairing, the connect stream emits `connected` BEFORE the server has
  // finished upserting the integration, so an immediate reload can still read
  // `connected: false`. Poll a few times until the integration row lands.
  const reloadUntilConnected = useCallback(async () => {
    if (!workspaceId) return;
    for (let attempt = 0; attempt < 6; attempt++) {
      try {
        const next = await getWhatsappIngest(workspaceId);
        setStatus(next);
        if (next.connected) return;
      } catch {
        // transient — keep polling
      }
      await new Promise((r) => setTimeout(r, 700));
    }
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  // A phone-side logout (unlinking the device) flips the integration to
  // `revoked` server-side, but the panel otherwise only loads on mount - so it
  // would keep showing "Connected as <number>" until a manual reload. Re-fetch
  // on tab focus/visibility and on a light interval so the disconnected state
  // surfaces on its own. Skipped while the QR modal is open, where
  // `reloadUntilConnected` owns refresh.
  useEffect(() => {
    if (connecting) return;
    const refresh = () => {
      if (document.visibilityState === "visible") load();
    };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    const id = window.setInterval(refresh, 30_000);
    return () => {
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.clearInterval(id);
    };
  }, [connecting, load]);

  // ── QR pairing ────────────────────────────────────────────────
  const startConnect = useCallback(() => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setConnecting(true);
    setPhase({ kind: "loading" });
    connectWhatsappIngest(
      workspaceId,
      {
        onQr: (value) => setPhase({ kind: "qr", value }),
        onConnected: () => {
          controller.abort();
          setConnecting(false);
          void reloadUntilConnected();
        },
        onTimeout: () => setPhase({ kind: "expired" }),
        onError: (message) => setPhase({ kind: "error", message }),
      },
      controller.signal,
    ).catch((e: unknown) => {
      if (controller.signal.aborted) return;
      setPhase({ kind: "error", message: (e as Error).message });
    });
  }, [workspaceId, reloadUntilConnected]);

  const closeConnect = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
    setConnecting(false);
  }, []);

  useEffect(() => () => abortRef.current?.abort(), []);

  const connected = status?.connected ?? false;

  return (
    <section className="border border-border rounded-xl bg-card overflow-hidden">
      <div className="flex items-center gap-3 px-5 py-4">
        <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0">
          <ConnectorIcon connectorId="whatsapp" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium truncate">{copy.title}</span>
            <span className="text-[10px] font-medium bg-muted text-muted-foreground px-1.5 py-0.5 rounded shrink-0">
              {copy.readOnlyBadge}
            </span>
          </div>
          <div className="text-[11px] text-muted-foreground truncate">
            {connected && status?.connectedNumber
              ? copy.connectedAs.replace("{number}", status.connectedNumber)
              : copy.subtitle}
          </div>
        </div>
        <button
          onClick={startConnect}
          className={cn(
            "text-xs font-medium px-3 py-1.5 rounded-lg shrink-0 transition-colors",
            connected
              ? "border border-border text-muted-foreground hover:bg-muted"
              : "bg-primary text-primary-foreground hover:bg-primary/90",
          )}
        >
          {connected ? copy.reconnectAction : copy.connectAction}
        </button>
      </div>

      {loadError && (
        <div className="px-5 pb-3 text-[11px] text-destructive">{copy.loadError}</div>
      )}

      {connected && (
        <div className="border-t border-border bg-muted/20 px-5 py-3">
          <div className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            {copy.groupsTitle}
          </div>
          {status && status.groups.length === 0 ? (
            <p className="text-xs text-muted-foreground leading-relaxed">
              {copy.groupsEmpty}
            </p>
          ) : (
            <ul className="flex flex-col gap-2">
              {status?.groups.map((g) => (
                <GroupRow
                  key={g.chatJid}
                  group={g}
                  copy={copy}
                  workspaceId={workspaceId}
                  onChange={load}
                />
              ))}
            </ul>
          )}
        </div>
      )}

      <ConnectDialog
        open={connecting}
        phase={phase}
        copy={copy}
        onRetry={startConnect}
        onClose={closeConnect}
      />
    </section>
  );
}

// ── One seen group: enable toggle (routing is digest-only — no picker) ──────
function GroupRow({
  group,
  copy,
  workspaceId,
  onChange,
}: {
  group: WhatsappGroup;
  copy: Copy;
  workspaceId: string;
  onChange: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);

  async function setEnabled(enabled: boolean, routing: WhatsappGroupRouting) {
    setBusy(true);
    setError(false);
    try {
      if (enabled) await enableWhatsappGroup(workspaceId, group.chatJid, routing);
      else await disableWhatsappGroup(workspaceId, group.chatJid);
      onChange();
    } catch {
      setError(true);
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className="flex items-center gap-2.5">
      <div className="min-w-0 flex-1">
        <div className="text-xs font-medium truncate">
          {group.title ?? copy.untitledGroup}
        </div>
        {error && <div className="text-[10px] text-destructive">{copy.groupError}</div>}
      </div>

      {/* Routing is digest-only: realtime (per-message extraction) is disabled
          to cap token cost, so there's no picker — enabled groups always run on
          the weekday digest. See docs/architecture/channels/whatsapp.md →
          "Routing (digest-only)". */}
      {group.enabled && (
        <span
          className="text-[10px] text-muted-foreground shrink-0"
          aria-label={copy.routingLabel}
        >
          {copy.routingScheduled}
        </span>
      )}

      <button
        onClick={() => setEnabled(!group.enabled, "scheduled")}
        disabled={busy}
        className={cn(
          "text-xs font-medium px-3 py-1.5 rounded-lg shrink-0 transition-colors disabled:opacity-40",
          group.enabled
            ? "border border-border text-muted-foreground hover:text-destructive hover:border-destructive/30"
            : "bg-primary text-primary-foreground hover:bg-primary/90",
        )}
      >
        {busy ? copy.working : group.enabled ? copy.disableAction : copy.enableAction}
      </button>
    </li>
  );
}

// ── QR pairing modal ────────────────────────────────────────────
function ConnectDialog({
  open,
  phase,
  copy,
  onRetry,
  onClose,
}: {
  open: boolean;
  phase: ConnectPhase;
  copy: Copy;
  onRetry: () => void;
  onClose: () => void;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm transition-opacity duration-150",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          )}
        />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-sm -translate-x-1/2 -translate-y-1/2",
            "rounded-2xl border border-border bg-background p-5 shadow-xl ring-1 ring-foreground/5",
            "transition-all duration-150",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
          )}
        >
          <Dialog.Title className="text-sm font-semibold text-foreground">
            {copy.dialogTitle}
          </Dialog.Title>
          <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
            {copy.dialogHint}
          </p>

          <div className="mt-4 flex flex-col items-center justify-center min-h-[14rem]">
            {phase.kind === "qr" ? (
              <div className="rounded-xl bg-white p-4">
                <QRCodeSVG value={phase.value} size={196} marginSize={0} />
              </div>
            ) : phase.kind === "expired" ? (
              <div className="flex flex-col items-center gap-3 text-center">
                <p className="text-xs text-muted-foreground">{copy.dialogExpired}</p>
                <button
                  onClick={onRetry}
                  className="text-xs font-medium bg-primary text-primary-foreground px-3 py-1.5 rounded-lg hover:bg-primary/90 transition-colors"
                >
                  {copy.dialogRetry}
                </button>
              </div>
            ) : phase.kind === "error" ? (
              <p className="text-xs text-destructive text-center">
                {phase.message || copy.dialogError}
              </p>
            ) : (
              <p className="text-xs text-muted-foreground">{copy.dialogLoading}</p>
            )}
          </div>

          <div className="mt-4 flex justify-end">
            <Dialog.Close className="text-xs font-medium border border-border px-3 py-1.5 rounded-lg text-muted-foreground hover:bg-muted transition-colors">
              {copy.dialogClose}
            </Dialog.Close>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
