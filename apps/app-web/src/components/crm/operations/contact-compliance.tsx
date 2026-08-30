"use client";

/** Contact consent, suppression, and fail-closed sendability panel. [COMP:app-web/crm-operations] */

import { useEffect, useState } from "react";
import { ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  checkCrmSendability,
  getCrmCompliance,
  recordCrmConsent,
  recordCrmSuppression,
  type CrmCompliance,
  type CrmDeliveryChannel,
  type CrmSendabilityVerdict,
} from "@/lib/api/crm";
import { useT } from "@/lib/i18n/client";

export function CrmContactCompliance({ workspaceId, contactId }: { workspaceId: string; contactId: string }) {
  const t = useT().crmPage.operations;
  const [compliance, setCompliance] = useState<CrmCompliance | null>(null);
  const [purposeKey, setPurposeKey] = useState("");
  const [channel, setChannel] = useState<CrmDeliveryChannel>("email");
  const [verdict, setVerdict] = useState<CrmSendabilityVerdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function reload() {
    const next = await getCrmCompliance(workspaceId, contactId);
    setCompliance(next);
    setPurposeKey((current) => current || next.purposes.find((purpose) => !purpose.archivedAt)?.purposeKey || "");
  }

  useEffect(() => {
    setCompliance(null);
    setVerdict(null);
    void reload().catch(() => setError(t.complianceLoadFailed));
  }, [workspaceId, contactId]);

  useEffect(() => {
    if (!purposeKey) { setVerdict(null); return; }
    void checkCrmSendability(workspaceId, contactId, channel, purposeKey)
      .then(setVerdict)
      .catch(() => setVerdict(null));
  }, [workspaceId, contactId, channel, purposeKey, compliance]);

  async function consent(action: "granted" | "withdrawn") {
    if (!purposeKey || busy) return;
    if (action === "withdrawn" && !await confirmDialog({
      title: t.withdrawTitle, description: t.withdrawDescription,
      confirmLabel: t.withdraw, cancelLabel: t.cancel, variant: "destructive",
    })) return;
    setBusy(true); setError(null);
    try {
      await recordCrmConsent(workspaceId, contactId, { purposeKey, action, source: "manual" });
      await reload();
    } catch { setError(t.complianceSaveFailed); }
    finally { setBusy(false); }
  }

  async function suppression(action: "suppressed" | "released") {
    if (busy) return;
    if (action === "released" && !await confirmDialog({
      title: t.releaseTitle, description: t.releaseDescription,
      confirmLabel: t.release, cancelLabel: t.cancel,
    })) return;
    setBusy(true); setError(null);
    try {
      await recordCrmSuppression(workspaceId, contactId, {
        channel, action, reasonCode: "manual_do_not_contact", source: "manual",
      });
      await reload();
    } catch { setError(t.complianceSaveFailed); }
    finally { setBusy(false); }
  }

  return (
    <section className="mt-4 border-t border-border/60 pt-4" data-crm-contact-compliance>
      <div className="mb-2 flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60"><ShieldCheck className="size-3.5" aria-hidden />{t.compliance}</div>
      {error && <div className="mb-2 text-xs text-destructive">{error}</div>}
      {!compliance ? <div className="text-xs text-muted-foreground">{t.loading}</div> : compliance.purposes.length === 0 ? <div className="text-xs text-muted-foreground">{t.noPurposesForContact}</div> : <>
        <div className="grid gap-2 sm:grid-cols-2">
          <Select value={purposeKey} onValueChange={(value) => setPurposeKey(value ?? "")}>
            <SelectTrigger><SelectValue placeholder={t.pickPurpose} /></SelectTrigger>
            <SelectContent>{compliance.purposes.map((purpose) => <SelectItem key={purpose.id} value={purpose.purposeKey}>{purpose.label}</SelectItem>)}</SelectContent>
          </Select>
          <Select value={channel} onValueChange={(value) => setChannel((value ?? "email") as CrmDeliveryChannel)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>{(["email", "sms", "phone", "whatsapp", "telegram", "slack"] as const).map((item) => <SelectItem key={item} value={item}>{t.channelLabels[item]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
        <div className={`mt-2 rounded-lg px-3 py-2 text-xs ${verdict?.verdict === "allowed" ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : verdict?.verdict === "blocked" ? "bg-destructive/10 text-destructive" : "bg-amber-500/10 text-amber-700 dark:text-amber-300"}`}>
          <div className="font-semibold">{verdict ? t.verdictLabels[verdict.verdict] : t.checking}</div>
          {verdict?.reasons.length ? <div className="mt-1">{verdict.reasons.map((reason) => t.reasonLabels[reason]).join(", ")}</div> : null}
        </div>
        <div className="mt-2 flex flex-wrap gap-1">
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void consent("granted")}>{t.grant}</Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void consent("withdrawn")}>{t.withdraw}</Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void suppression("suppressed")}>{t.suppress}</Button>
          <Button size="xs" variant="outline" disabled={busy} onClick={() => void suppression("released")}>{t.release}</Button>
        </div>
        <div className="mt-3 space-y-1 text-[11px] text-muted-foreground">
          {[...compliance.events.map((event) => ({ id: event.id, text: `${event.purposeKey}: ${t.consentActionLabels[event.action]}`, at: event.occurredAt })), ...compliance.suppressions.map((event) => ({ id: event.id, text: `${event.channel}: ${t.suppressionActionLabels[event.action]}`, at: event.occurredAt }))].sort((left, right) => right.at.localeCompare(left.at)).slice(0, 10).map((event) => <div key={event.id} className="flex justify-between gap-3"><span>{event.text}</span><time dateTime={event.at}>{new Date(event.at).toLocaleDateString()}</time></div>)}
        </div>
      </>}
    </section>
  );
}
