"use client";

import { Suspense, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type LoginFormProps = {
  emailEnabled: boolean;
  oidcEnabled: boolean;
  oidcProviderName?: string;
};

function Form({ emailEnabled, oidcEnabled, oidcProviderName }: LoginFormProps) {
  const t = useT();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(() => {
    const value = params.get("error");
    if (value === "link_expired") return t.login.linkExpired;
    if (value === "enrollment_required") return t.login.enrollment;
    if (value === "oidc_failed") return t.login.oidcFailed;
    return value ? t.login.unavailable : null;
  });
  const nextPath = params.get("next");
  const oidcStart = `/api/auth/oidc/start${nextPath ? `?next=${encodeURIComponent(nextPath)}` : ""}`;

  const requestLink = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await fetch("/api/auth/email/request-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, nextPath, locale: document.documentElement.lang }),
      });
      setSent(true);
    } catch {
      setError(t.login.unavailable);
    } finally {
      setBusy(false);
    }
  };

  const verifyCode = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch("/api/auth/email/verify-code", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, code, timezone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
      });
      const body = (await response.json().catch(() => ({}))) as { error?: string; redirect?: string };
      if (response.ok && body.redirect) {
        window.location.assign(body.redirect);
        return;
      }
      setError(response.status === 429 ? t.login.locked : response.status === 401 ? t.login.invalidCode : body.error === "enrollment_required" ? t.login.enrollment : t.login.unavailable);
    } catch {
      setError(t.login.unavailable);
    } finally {
      setBusy(false);
    }
  };

  const body = sent ? t.login.sentBody : emailEnabled ? t.login.body : t.login.ssoBody;
  return <main className="shell"><section className="card"><div className="brand">{t.common.product}</div><h1 className="title">{sent ? t.login.sentHeading : t.login.heading}</h1><p className="body">{body}</p>{!sent && oidcEnabled && oidcProviderName ? <a className="button stack oidc-button" href={oidcStart}>{format(t.login.continueWithProvider, { provider: oidcProviderName })}</a> : null}{!sent && emailEnabled && oidcEnabled ? <div className="separator"><span>{t.login.or}</span></div> : null}{sent ? <form className="stack" onSubmit={verifyCode}><label className="label">{t.login.codeLabel}<input className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} required /></label><button className="button" type="submit" disabled={busy || code.length !== 6}>{busy ? t.login.verifying : t.login.verify}</button></form> : emailEnabled ? <form className="stack" onSubmit={requestLink}><label className="label">{t.login.emailLabel}<input className="input" type="email" autoComplete="email" placeholder={t.login.emailPlaceholder} value={email} onChange={(event) => setEmail(event.target.value)} required /></label><button className="button" type="submit" disabled={busy}>{busy ? t.login.sending : t.login.send}</button></form> : null}{error ? <p className="message error">{error}</p> : null}<LocaleSwitcher /></section></main>;
}

export function LoginForm(props: LoginFormProps) {
  return <Suspense fallback={null}><Form {...props} /></Suspense>;
}
