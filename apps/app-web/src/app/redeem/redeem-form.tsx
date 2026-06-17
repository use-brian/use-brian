"use client";

// [COMP:app-web/redeem] — see docs/architecture/features/promo-codes.md
//
// Client half of the in-app redeem page. The server component
// (`page.tsx`) resolves the target workspace and passes it in, so this
// form has no workspace-context hydration of its own — it just POSTs the
// code to /api/promo/redeem for that workspace.

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { authFetch, refreshUserCookie } from "@/lib/auth-fetch";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type RedeemResult =
  | { kind: "idle" }
  | { kind: "submitting" }
  | { kind: "error"; message: string }
  | { kind: "success"; plan: string; planExpiresAt: string | null };

export function RedeemForm({
  targetWorkspaceId,
  prefilledCode,
}: {
  targetWorkspaceId: string | null;
  prefilledCode: string;
}) {
  const t = useT();
  const [code, setCode] = useState(prefilledCode);
  const [result, setResult] = useState<RedeemResult>({ kind: "idle" });

  const submit = useCallback(async () => {
    const trimmed = code.trim();
    if (!trimmed) {
      setResult({ kind: "error", message: t.redeem.enterCode });
      return;
    }
    if (!targetWorkspaceId) {
      setResult({ kind: "error", message: t.redeem.noWorkspace });
      return;
    }
    setResult({ kind: "submitting" });
    try {
      const res = await authFetch(`${API_URL}/api/promo/redeem`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ workspace_id: targetWorkspaceId, code: trimmed }),
      });
      const body = (await res.json().catch(() => ({}))) as {
        error?: string;
        plan?: string;
        planExpiresAt?: string | null;
      };
      if (!res.ok) {
        setResult({ kind: "error", message: body.error ?? `Failed (${res.status})` });
        return;
      }
      // Plan changed — refresh the user cookie so the chrome's plan badge
      // reflects the new plan on next navigation.
      await refreshUserCookie().catch(() => {});
      setResult({
        kind: "success",
        plan: body.plan ?? "pro",
        planExpiresAt: body.planExpiresAt ?? null,
      });
    } catch (err) {
      setResult({
        kind: "error",
        message: err instanceof Error ? err.message : t.redeem.networkError,
      });
    }
  }, [code, t, targetWorkspaceId]);

  // Shareable links arrive pre-filled (`?code=`) — auto-submit so they
  // "just work". The server already resolved the workspace, so there's no
  // hydration race to wait on.
  useEffect(() => {
    if (prefilledCode && targetWorkspaceId) {
      void submit();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex min-h-screen items-center justify-center bg-background px-4">
      <div className="w-full max-w-sm space-y-8">
        <div className="text-center space-y-2">
          <h1 className="text-2xl font-bold tracking-tight">{t.redeem.title}</h1>
          <p className="text-sm text-muted-foreground">{t.redeem.subtitle}</p>
        </div>

        {result.kind !== "success" && (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              void submit();
            }}
          >
            <input
              type="text"
              autoFocus
              placeholder={t.redeem.placeholder}
              value={code}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setCode(e.target.value.toUpperCase())
              }
              className="flex h-12 w-full rounded-xl border border-input bg-transparent px-3 py-1 text-center text-sm tracking-widest uppercase shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              disabled={result.kind === "submitting"}
            />
            <button
              type="submit"
              className="w-full h-12 rounded-xl text-sm font-medium bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:cursor-not-allowed disabled:opacity-50"
              disabled={
                result.kind === "submitting" || !code.trim() || !targetWorkspaceId
              }
            >
              {result.kind === "submitting" ? t.redeem.submitting : t.redeem.submit}
            </button>
          </form>
        )}

        {result.kind === "error" && (
          <p className="text-center text-sm text-destructive">{result.message}</p>
        )}

        {result.kind === "success" && (
          <div className="rounded-xl border border-border p-6 text-center space-y-3">
            <p className="text-sm text-foreground">
              {format(t.redeem.success, { plan: result.plan })}
            </p>
            {result.planExpiresAt && (
              <p className="text-xs text-muted-foreground">
                {format(t.redeem.activeUntil, {
                  date: new Date(result.planExpiresAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "short",
                    day: "numeric",
                  }),
                })}
              </p>
            )}
            <div className="flex justify-center pt-2">
              <Link
                href={targetWorkspaceId ? `/w/${targetWorkspaceId}/p` : "/"}
                className="text-sm text-foreground underline hover:no-underline"
              >
                {t.redeem.goToWorkspace}
              </Link>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
