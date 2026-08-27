"use client";

import { Suspense, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type Preview = { workspaceName: string; inviterName: string | null; role: "admin" | "member"; email: string; status: "pending" | "expired" | "accepted" };
type Phase = { kind: "loading" } | { kind: "missing" } | { kind: "error" } | { kind: "mismatch"; invited: string; current: string } | { kind: "preview"; value: Preview };

function currentEmail(): string | null {
  const raw = document.cookie.split(";").map((part) => part.trim()).find((part) => part.startsWith("user="))?.slice(5);
  if (!raw) return null;
  try { return (JSON.parse(decodeURIComponent(raw)) as { email?: string }).email ?? null; } catch { return null; }
}

function Invite() {
  const t = useT();
  const token = useSearchParams().get("token") ?? "";
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [busy, setBusy] = useState(false);
  const email = typeof document === "undefined" ? null : currentEmail();
  const next = `/invite?token=${encodeURIComponent(token)}`;

  const load = useCallback(async () => {
    if (!token) return setPhase({ kind: "missing" });
    try {
      const response = await fetch(`/api/invitations/${encodeURIComponent(token)}`, { cache: "no-store" });
      if (response.status === 404) return setPhase({ kind: "missing" });
      if (!response.ok) return setPhase({ kind: "error" });
      setPhase({ kind: "preview", value: await response.json() as Preview });
    } catch { setPhase({ kind: "error" }); }
  }, [token]);

  useEffect(() => { void load(); }, [load]);

  const accept = async () => {
    setBusy(true);
    try {
      const response = await fetch("/api/invitations/accept", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ token }) });
      const body = await response.json().catch(() => ({})) as { appUrl?: string; workspaceId?: string; invitedEmail?: string };
      if (response.ok && body.appUrl) return window.location.assign(body.workspaceId ? `${body.appUrl}/w/${body.workspaceId}` : body.appUrl);
      if (response.status === 403) return setPhase({ kind: "mismatch", invited: body.invitedEmail ?? "", current: email ?? "" });
      await load();
    } catch { setPhase({ kind: "error" }); } finally { setBusy(false); }
  };

  let content: React.ReactNode;
  if (phase.kind === "loading") content = <p className="message">{t.invite.loading}</p>;
  else if (phase.kind === "missing") content = <><h1 className="title">{t.invite.missingTitle}</h1><p className="body">{t.invite.missingBody}</p></>;
  else if (phase.kind === "error") content = <><h1 className="title">{t.invite.missingTitle}</h1><p className="body">{t.invite.error}</p></>;
  else if (phase.kind === "mismatch") content = <><h1 className="title">{t.invite.mismatchTitle}</h1><p className="body">{format(t.invite.mismatchBody, phase)}</p><a className="button stack" href={`/api/auth/logout?next=${encodeURIComponent(new URL(`/login?next=${encodeURIComponent(next)}`, window.location.origin).toString())}`}>{t.invite.switchAccount}</a></>;
  else if (phase.value.status === "expired") content = <><h1 className="title">{t.invite.expiredTitle}</h1><p className="body">{t.invite.expiredBody}</p></>;
  else if (phase.value.status === "accepted") content = <><h1 className="title">{t.invite.acceptedTitle}</h1><p className="body">{t.invite.acceptedBody}</p><a className="button stack" href="/api/auth/return-to-app">{t.invite.openApp}</a></>;
  else content = <><h1 className="title">{format(t.invite.title, { workspace: phase.value.workspaceName })}</h1><p className="body">{phase.value.inviterName ? format(t.invite.from, { inviter: phase.value.inviterName, workspace: phase.value.workspaceName }) : format(t.invite.generic, { workspace: phase.value.workspaceName })}</p><p className="message">{phase.value.role === "admin" ? t.invite.admin : t.invite.member}</p>{email ? <button className="button stack" onClick={() => void accept()} disabled={busy}>{busy ? t.invite.accepting : t.invite.accept}</button> : <a className="button stack" href={`/login?next=${encodeURIComponent(next)}`}>{format(t.invite.signIn, { email: phase.value.email })}</a>}</>;
  return <main className="shell"><section className="card"><div className="brand">{t.common.product}</div>{content}</section></main>;
}

export default function InvitePage() { return <Suspense fallback={null}><Invite /></Suspense>; }
