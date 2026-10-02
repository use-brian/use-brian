"use client";

/** Campaign Email envelope, deterministic preview and CRM audience review. [COMP:app-web/feed-campaigns] */
import Link from "next/link";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Mail, Send } from "lucide-react";
import {
  cancelCampaignDispatch,
  getCampaignDispatch,
  getCampaignEmailCatalog,
  getCampaignEmailDraft,
  pauseCampaignDispatch,
  prepareCampaignDispatch,
  previewCampaignAudience,
  previewCampaignEmail,
  scheduleCampaignDispatch,
  sendCampaignTest,
  updateCampaignEmail,
  type CampaignAudiencePreview,
  type CampaignDispatch,
  type CampaignEmailCatalog,
  type CampaignEmailDraft,
  type CampaignEmailProjection,
} from "@/lib/api/campaigns";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { confirmDialog } from "@/components/ui/confirm-dialog";

export function CampaignEmailPanel(props: { workspaceId: string; campaignId: string; placementId: string }) {
  const t = useT().feedPage.campaigns.email;
  const [draft, setDraft] = useState<CampaignEmailDraft | null>(null);
  const [catalog, setCatalog] = useState<CampaignEmailCatalog | null>(null);
  const [subject, setSubject] = useState("");
  const [preheader, setPreheader] = useState("");
  const [senderId, setSenderId] = useState("");
  const [segmentId, setSegmentId] = useState("");
  const [purposeKey, setPurposeKey] = useState("");
  const [replyTo, setReplyTo] = useState("");
  const [fallback, setFallback] = useState("there");
  const [preview, setPreview] = useState<CampaignEmailProjection | null>(null);
  const [audience, setAudience] = useState<CampaignAudiencePreview | null>(null);
  const [testContactId, setTestContactId] = useState("");
  const [dispatch, setDispatch] = useState<CampaignDispatch | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      getCampaignEmailDraft(props.workspaceId, props.campaignId, props.placementId),
      getCampaignEmailCatalog(props.workspaceId),
    ]).then(([nextDraft, nextCatalog]) => {
      if (cancelled) return;
      setDraft(nextDraft); setCatalog(nextCatalog);
      const metadata = nextDraft.metadata;
      if (metadata) {
        setSubject(metadata.subject); setPreheader(metadata.preheader ?? ""); setSenderId(metadata.senderId);
        setSegmentId(metadata.audience.segmentId); setPurposeKey(metadata.purposeKey); setReplyTo(metadata.replyTo ?? "");
        setFallback(metadata.personalization.find((item) => item.field === "first_name")?.fallback ?? "there");
      }
      if (nextDraft.approval?.dispatchId) {
        void getCampaignDispatch(props.workspaceId, props.campaignId, nextDraft.approval.dispatchId).then((result) => {
          if (!cancelled) setDispatch(result);
        }).catch(() => {});
      }
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : t.loadFailed));
    return () => { cancelled = true; };
  }, [props.campaignId, props.placementId, props.workspaceId, t.loadFailed]);

  const segment = useMemo(() => catalog?.segments.find((item) => item.id === segmentId), [catalog, segmentId]);
  const complete = Boolean(subject.trim() && senderId && segment && purposeKey);
  const sender = catalog?.senders.find((item) => item.id === senderId);

  async function run(action: () => Promise<void>) {
    setBusy(true); setError(null); setNotice(null);
    try { await action(); } catch (reason) { setError(reason instanceof Error ? reason.message : t.actionFailed); }
    finally { setBusy(false); }
  }

  function save() {
    if (!draft || !segment || !complete) return;
    void run(async () => {
      const result = await updateCampaignEmail({
        workspaceId: props.workspaceId, campaignId: props.campaignId, placementId: props.placementId,
        mutationId: crypto.randomUUID(), expectedRevision: draft.revision,
        metadata: {
          subject: subject.trim(), ...(preheader ? { preheader } : {}), senderId,
          ...(replyTo ? { replyTo } : {}), audience: { segmentId, segmentVersion: segment.version }, purposeKey,
          personalization: [{ field: "first_name", required: false, fallback }],
          tracking: { links: true, website: true },
        },
      });
      setDraft(result.draft); setPreview(null); setAudience(null); setNotice(t.saved);
    });
  }

  function renderPreview() {
    if (!draft?.metadata) return;
    void run(async () => {
      const result = await previewCampaignEmail({
        workspaceId: props.workspaceId, campaignId: props.campaignId, placementId: props.placementId,
        values: { first_name: fallback || "there" },
      });
      setPreview(result.projection);
    });
  }

  function reviewAudience() {
    if (!draft?.metadata) return;
    void run(async () => {
      const result = await previewCampaignAudience(props.workspaceId, props.campaignId, props.placementId);
      setAudience(result); setTestContactId(result.eligible[0]?.contactId ?? "");
    });
  }

  async function refreshDispatch(dispatchId: string) {
    setDispatch(await getCampaignDispatch(props.workspaceId, props.campaignId, dispatchId));
  }

  function approveAndSend() {
    if (!draft?.metadata || !audience?.eligible.length || !sender?.broadcastCapable) return;
    const metadata = draft.metadata;
    void run(async () => {
      const ok = await confirmDialog({
        title: t.sendConfirmTitle,
        description: t.sendConfirmDescription.replace("{count}", String(audience.eligible.length)),
        confirmLabel: t.sendNow,
      });
      if (!ok) return;
      const scheduledAt = new Date().toISOString();
      const prepared = await prepareCampaignDispatch({
        workspaceId: props.workspaceId, campaignId: props.campaignId, placementId: props.placementId,
        approvedRevision: draft.revision, metadata, scheduledAt, recipients: audience.eligible,
      });
      await scheduleCampaignDispatch(props.workspaceId, prepared.dispatch.dispatchId, scheduledAt);
      await refreshDispatch(prepared.dispatch.dispatchId);
      setNotice(t.sendQueued);
    });
  }

  return (
    <section className="space-y-4 border-t border-border pt-4" data-campaign-email>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h3 className="flex items-center gap-2 font-medium"><Mail className="size-4" aria-hidden />{t.title}</h3><p className="text-xs text-muted-foreground">{t.description}</p></div>
        {draft ? <Button variant="outline" size="sm" render={<Link href={`/w/${props.workspaceId}/feed/email/posts/${draft.sessionId}`} />}>{t.openDraft}</Button> : null}
      </div>
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      {notice ? <p role="status" className="text-sm text-muted-foreground">{notice}</p> : null}
      {!draft || !catalog ? <p className="text-sm text-muted-foreground">{t.loading}</p> : (
        <>
          {draft.approval && !draft.approval.current ? <p className="rounded-lg bg-amber-500/10 p-2 text-xs text-amber-800 dark:text-amber-300">{t.approvalInvalidated}</p> : null}
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label={t.subject}><input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={998} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-base sm:text-sm" /></Field>
            <Field label={t.preheader}><input value={preheader} onChange={(e) => setPreheader(e.target.value)} maxLength={500} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-base sm:text-sm" /></Field>
            <Picker label={t.sender} value={senderId} onChange={setSenderId} placeholder={t.selectOption} items={catalog.senders.map((item) => ({ value: item.id, label: `${item.label}${item.address ? ` (${item.address})` : ""}` }))} />
            <Picker label={t.audience} value={segmentId} onChange={setSegmentId} placeholder={t.selectOption} items={catalog.segments.map((item) => ({ value: item.id, label: item.name }))} />
            <Picker label={t.purpose} value={purposeKey} onChange={setPurposeKey} placeholder={t.selectOption} items={catalog.purposes.map((item) => ({ value: item.purposeKey, label: item.label }))} />
            <Field label={t.replyTo}><input type="email" value={replyTo} onChange={(e) => setReplyTo(e.target.value)} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-base sm:text-sm" /></Field>
            <Field label={t.firstNameFallback}><input value={fallback} onChange={(e) => setFallback(e.target.value)} maxLength={500} className="h-9 w-full rounded-lg border border-input bg-background px-3 text-base sm:text-sm" /></Field>
          </div>
          {(!catalog.senders.length || !catalog.segments.length || !catalog.purposes.length) ? <p className="text-xs text-muted-foreground">{t.unconfigured}</p> : null}
          {sender && !sender.broadcastCapable ? <p className="text-xs text-amber-700 dark:text-amber-300">{t.broadcastUnsupported}</p> : null}
          <div className="flex flex-wrap gap-2">
            <Button type="button" onClick={save} disabled={busy || !complete}>{t.save}</Button>
            <Button type="button" variant="outline" onClick={renderPreview} disabled={busy || !draft.metadata}>{t.preview}</Button>
            <Button type="button" variant="outline" onClick={reviewAudience} disabled={busy || !draft.metadata}>{t.reviewAudience}</Button>
          </div>
          {preview ? <div className="space-y-2 border-l-2 border-border pl-3"><strong className="text-sm">{preview.subject}</strong>{preview.preheader ? <p className="text-xs text-muted-foreground">{preview.preheader}</p> : null}<pre className="whitespace-pre-wrap font-sans text-sm">{preview.text}</pre></div> : null}
          {audience ? <div className="space-y-3 border-t border-border pt-3">
            <p className="text-sm">{t.matched}: {audience.counts.matched} · {t.eligible}: {audience.counts.eligible} · {t.excluded}: {audience.counts.excluded}</p>
            {audience.excluded.length ? <ul className="space-y-1 text-xs text-muted-foreground">{audience.excluded.slice(0, 20).map((item) => <li key={item.contactId}>{item.address ?? item.contactId}: {item.reasons.join(", ")}</li>)}</ul> : null}
            {audience.eligible.length ? <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <Picker label={t.testRecipient} value={testContactId} onChange={setTestContactId} placeholder={t.selectOption} items={audience.eligible.map((item) => ({ value: item.contactId, label: item.address }))} />
              <Button type="button" variant="outline" disabled={busy || !testContactId} onClick={() => void run(async () => { await sendCampaignTest(props.workspaceId, props.campaignId, props.placementId, testContactId); setNotice(t.testSent); })}><Send className="size-4" aria-hidden />{t.sendTest}</Button>
              <Button type="button" disabled={busy || !sender?.broadcastCapable} onClick={approveAndSend}><Send className="size-4" aria-hidden />{t.approveAndSend}</Button>
            </div> : <p className="text-xs text-muted-foreground">{t.noEligible}</p>}
          </div> : null}
          {dispatch ? <div className="space-y-3 border-t border-border pt-3" data-campaign-dispatch>
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div><strong className="text-sm">{t.deliveryResults}</strong><p className="text-xs text-muted-foreground">{t.dispatchState}: {dispatch.dispatch.state}</p></div>
              <div className="flex gap-2">
                {(["scheduled", "sending"] as string[]).includes(dispatch.dispatch.state) ? <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void run(async () => { await pauseCampaignDispatch(props.workspaceId, dispatch.dispatch.id); await refreshDispatch(dispatch.dispatch.id); })}>{t.pause}</Button> : null}
                {!(["completed", "cancelled"] as string[]).includes(dispatch.dispatch.state) ? <Button type="button" size="sm" variant="destructive" disabled={busy} onClick={() => void run(async () => {
                  const ok = await confirmDialog({ title: t.cancelConfirmTitle, description: t.cancelConfirmDescription, confirmLabel: t.cancel, variant: "destructive" });
                  if (!ok) return; await cancelCampaignDispatch(props.workspaceId, dispatch.dispatch.id); await refreshDispatch(dispatch.dispatch.id);
                })}>{t.cancel}</Button> : null}
              </div>
            </div>
            <p className="text-sm">{t.accepted}: {dispatch.counts.accepted} · {t.rejected}: {dispatch.counts.rejected} · {t.suppressed}: {dispatch.counts.suppressed} · {t.pending}: {dispatch.counts.pending} · {t.uncertain}: {dispatch.counts.uncertain}</p>
            <p className="text-xs text-muted-foreground">{t.providerLimitations}</p>
            {dispatch.counts.uncertain > 0 ? <p className="text-xs text-amber-700 dark:text-amber-300">{t.uncertainRecovery}</p> : null}
          </div> : null}
        </>
      )}
    </section>
  );
}

function Field(props: { label: string; children: ReactNode }) { return <label className="block text-sm"><span className="mb-1 block text-muted-foreground">{props.label}</span>{props.children}</label>; }
function Picker(props: { label: string; value: string; onChange: (value: string) => void; placeholder: string; items: Array<{ value: string; label: string }> }) {
  return <label className="block min-w-0 flex-1 text-sm"><span className="mb-1 block text-muted-foreground">{props.label}</span><Select value={props.value} onValueChange={(value) => { if (value) props.onChange(value); }}><SelectTrigger className="w-full"><SelectValue placeholder={props.placeholder} /></SelectTrigger><SelectContent>{props.items.map((item) => <SelectItem key={item.value} value={item.value}>{item.label}</SelectItem>)}</SelectContent></Select></label>;
}
