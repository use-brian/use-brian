"use client";

import { Suspense, useEffect, useId, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { LocaleSwitcher } from "@/components/locale-switcher";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type LoginFormProps = {
  emailEnabled: boolean;
  oidcEnabled: boolean;
  oidcProviderName?: string;
};
type LoginError = "linkExpired" | "enrollment" | "oidcFailed" | "unavailable" | "locked" | "invalidCode";
type Pending = "send" | "resend" | "verify" | null;

function Form({ emailEnabled, oidcEnabled, oidcProviderName }: LoginFormProps) {
  const t = useT();
  const params = useSearchParams();
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState<Pending>(null);
  const [notice, setNotice] = useState(false);
  const [error, setError] = useState<LoginError | null>(() => {
    const value = params.get("error");
    if (value === "link_expired") return "linkExpired";
    if (value === "enrollment_required") return "enrollment";
    if (value === "oidc_failed") return "oidcFailed";
    return value ? "unavailable" : null;
  });
  const inFlight = useRef(false);
  const emailInput = useRef<HTMLInputElement>(null);
  const codeInput = useRef<HTMLInputElement>(null);
  const focusTarget = useRef<"email" | "code" | null>(null);
  const errorId = useId();
  const recipientId = useId();
  const busy = pending !== null;
  const nextPath = params.get("next");
  const oidcStart = `/api/auth/oidc/start${nextPath ? `?next=${encodeURIComponent(nextPath)}` : ""}`;

  useEffect(() => {
    if (pending !== null || !focusTarget.current) return;
    (focusTarget.current === "email" ? emailInput : codeInput).current?.focus();
    focusTarget.current = null;
  });

  const requestSignInEmail = async (resend: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setPending(resend ? "resend" : "send");
    setCode("");
    setError(null);
    setNotice(false);
    try {
      await fetch("/api/auth/email/request-link", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email, nextPath, locale: document.documentElement.lang }),
      });
      focusTarget.current = "code";
      setSent(true);
      setNotice(resend);
    } catch {
      setError("unavailable");
      focusTarget.current = resend ? "code" : "email";
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };

  const requestLink = (event: React.FormEvent) => {
    event.preventDefault();
    void requestSignInEmail(false);
  };

  const changeEmail = () => {
    if (inFlight.current) return;
    focusTarget.current = "email";
    setCode("");
    setError(null);
    setNotice(false);
    setSent(false);
  };

  const verifyCode = async (event: React.FormEvent) => {
    event.preventDefault();
    if (inFlight.current) return;
    inFlight.current = true;
    setPending("verify");
    setError(null);
    setNotice(false);
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
      setError(response.status === 429 ? "locked" : response.status === 401 ? "invalidCode" : body.error === "enrollment_required" ? "enrollment" : "unavailable");
      focusTarget.current = "code";
    } catch {
      setError("unavailable");
      focusTarget.current = "code";
    } finally {
      inFlight.current = false;
      setPending(null);
    }
  };

  const body = sent ? t.login.sentBody : emailEnabled ? t.login.body : t.login.ssoBody;
  return <main className="shell"><section className="card">
    <div className="brand">{t.common.product}</div>
    <h1 className="title">{sent ? t.login.sentHeading : t.login.heading}</h1>
    <p className="body">{body}</p>
    {!sent && oidcEnabled && oidcProviderName ? <a className="button stack oidc-button" href={oidcStart}>{format(t.login.continueWithProvider, { provider: oidcProviderName })}</a> : null}
    {!sent && emailEnabled && oidcEnabled ? <div className="separator"><span>{t.login.or}</span></div> : null}
    {sent ? <>
      <p className="message recipient" id={recipientId}>{format(t.login.sentTo, { email })}</p>
      <form className="stack" onSubmit={verifyCode} aria-busy={busy}>
        <label className="label">{t.login.codeLabel}<input ref={codeInput} className="input" inputMode="numeric" autoComplete="one-time-code" maxLength={6} pattern="[0-9]{6}" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, ""))} required disabled={busy} aria-invalid={error === "invalidCode" || undefined} aria-describedby={`${recipientId}${error ? ` ${errorId}` : ""}`} /></label>
        <button className="button" type="submit" disabled={busy || code.length !== 6}>{pending === "verify" ? t.login.verifying : t.login.verify}</button>
      </form>
      <div className="recovery-actions">
        <button className="recovery-button" type="button" onClick={changeEmail} disabled={busy}>{t.login.changeEmail}</button>
        <button className="recovery-button" type="button" onClick={() => void requestSignInEmail(true)} disabled={busy}>{pending === "resend" ? t.login.resending : t.login.resend}</button>
      </div>
    </> : emailEnabled ? <form className="stack" onSubmit={requestLink} aria-busy={busy}>
      <label className="label">{t.login.emailLabel}<input ref={emailInput} className="input" type="email" autoComplete="email" placeholder={t.login.emailPlaceholder} value={email} onChange={(event) => setEmail(event.target.value)} required disabled={busy} aria-describedby={error ? errorId : undefined} /></label>
      <button className="button" type="submit" disabled={busy}>{pending === "send" ? t.login.sending : t.login.send}</button>
    </form> : null}
    {error ? <p className="message error" id={errorId} role="alert">{t.login[error]}</p> : null}
    {notice ? <p className="message" role="status">{t.login.requestAccepted}</p> : null}
    <LocaleSwitcher disabled={busy} />
  </section></main>;
}

export function LoginForm(props: LoginFormProps) {
  return <Suspense fallback={null}><Form {...props} /></Suspense>;
}
