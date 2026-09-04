"use client";


import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/** Hosted approval page for a self-hosted Feed device code. */

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Check, Link2, ShieldCheck } from "lucide-react";
import { authFetch } from "@/lib/auth-fetch";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

type LinkRequest = {
  request: {
    code: string;
    status: "pending" | "approved" | "revoked";
    localOrigin: string;
    localWorkspaceName: string;
    localAssistantName: string;
    expiresAt: string;
  };
  workspaces: Array<{ id: string; name: string; plan: string }>;
};

export default function CloudLinkApprovalPage() {
  const t = useT().feedPage.cloudLink;
  const params = useSearchParams();
  const code = (params.get("code") ?? "").toUpperCase();
  const [data, setData] = useState<LinkRequest | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "approved" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [approving, setApproving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!code) {
        setError(t.approvalCodeMissing);
        setStatus("error");
        return;
      }
      try {
        const res = await authFetch(
          `${API_URL}/api/self-host-feed/link/request?code=${encodeURIComponent(code)}`,
        );
        const body = (await res.json().catch(() => ({}))) as LinkRequest & { error?: string };
        if (cancelled) return;
        if (!res.ok) {
          setError(body.error ?? t.approvalLoadFailed);
          setStatus("error");
          return;
        }
        setData(body);
        setSelected(body.workspaces[0]?.id ?? null);
        if (body.request.status === "revoked") {
          setError(t.approvalFailed);
          setStatus("error");
        } else {
          setStatus(body.request.status === "approved" ? "approved" : "ready");
        }
      } catch {
        if (!cancelled) {
          setError(t.approvalLoadFailed);
          setStatus("error");
        }
      }
    }
    void load();
    return () => { cancelled = true; };
  }, [code, t.approvalCodeMissing, t.approvalFailed, t.approvalLoadFailed]);

  async function approve() {
    if (!selected || approving) return;
    setApproving(true);
    setError(null);
    try {
      const res = await authFetch(`${API_URL}/api/self-host-feed/link/approve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, workspaceId: selected }),
      });
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      if (!res.ok) {
        setError(body.error ?? t.approvalFailed);
        return;
      }
      setStatus("approved");
    } catch (approveError) {
      setError(
        approveError instanceof Error ? approveError.message : t.approvalFailed,
      );
    } finally {
      setApproving(false);
    }
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-muted/20 px-4 py-10">
      <section className="w-full max-w-xl rounded-2xl border border-border bg-background p-6 shadow-sm md:p-8">
        <div className="flex size-11 items-center justify-center rounded-xl bg-foreground text-background">
          {status === "approved" ? <ShieldCheck className="size-5" /> : <Link2 className="size-5" />}
        </div>
        <h1 className="mt-5 text-xl font-semibold">
          {status === "approved" ? t.approvalCompleteTitle : t.approvalTitle}
        </h1>
        <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
          {status === "approved" ? t.approvalCompleteBody : t.approvalBody}
        </p>

        {status === "loading" ? (
          <p className="mt-6 text-sm text-muted-foreground">{t.approvalLoading}</p>
        ) : null}

        {data && status !== "approved" ? (
          <>
            <div className="mt-6 grid gap-3 rounded-xl border border-border/70 bg-muted/30 p-4 text-sm">
              <Detail label={t.approvalCode} value={data.request.code} mono />
              <Detail label={t.approvalOrigin} value={data.request.localOrigin} />
              <Detail label={t.approvalLocalWorkspace} value={data.request.localWorkspaceName} />
              <Detail label={t.approvalAssistant} value={data.request.localAssistantName} />
            </div>

            <div className="mt-6">
              <h2 className="text-sm font-medium">{t.approvalChooseWorkspace}</h2>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                {t.approvalChooseWorkspaceBody}
              </p>
              {data.workspaces.length ? (
                <div className="mt-3 grid gap-2">
                  {data.workspaces.map((workspace) => {
                    const active = selected === workspace.id;
                    return (
                      <button
                        key={workspace.id}
                        type="button"
                        onClick={() => setSelected(workspace.id)}
                        className={cn(
                          "flex w-full items-center gap-3 rounded-xl border p-3 text-left transition-colors",
                          active
                            ? "border-foreground bg-foreground/[0.04]"
                            : "border-border hover:bg-muted/50",
                        )}
                      >
                        <span className={cn(
                          "flex size-5 items-center justify-center rounded-full border",
                          active ? "border-foreground bg-foreground text-background" : "border-border",
                        )}>
                          {active ? <Check className="size-3" /> : null}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium">{workspace.name}</span>
                          <span className="block text-xs text-muted-foreground">{workspace.plan}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <p className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-800 dark:text-amber-200">
                  {t.approvalNoPaidWorkspace}
                </p>
              )}
            </div>

            <div className="mt-6 rounded-lg border border-border/60 p-3 text-xs leading-relaxed text-muted-foreground">
              <p>{t.disclosureSent}</p>
              <p className="mt-1">{t.disclosureLocal}</p>
            </div>

            {error ? <p className="mt-4 text-sm text-destructive">{error}</p> : null}
            <Button className="mt-5 w-full" disabled={!selected || approving} onClick={() => void approve()}>
              {t.approvalConfirm}
            </Button>
          </>
        ) : null}

        {status === "error" ? (
          <p className="mt-6 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </section>
    </main>
  );
}

function Detail(props: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="grid gap-1 sm:grid-cols-[9rem_1fr] sm:gap-3">
      <span className="text-xs text-muted-foreground">{props.label}</span>
      <span className={cn("break-all text-sm", props.mono && "font-mono font-semibold tracking-wider")}>{props.value}</span>
    </div>
  );
}
