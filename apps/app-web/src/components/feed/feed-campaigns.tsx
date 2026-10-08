"use client";

/** Native Feed campaign workspace. [COMP:app-web/feed-campaigns] */
import { FormEvent, useEffect, useMemo, useState } from "react";
import { ExternalLink, Link2, Megaphone, Plus } from "lucide-react";
import {
  getCampaign,
  getCampaignResults,
  listCampaigns,
  runCampaignCommand,
  type CampaignPlacement,
  type CampaignResults,
  type CampaignSummary,
} from "@/lib/api/campaigns";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { CampaignEmailPanel } from "./campaign-email-panel";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

type CampaignChannel = "instagram" | "threads" | "twitter" | "xhs" | "linkedin" | "email";
const CAMPAIGN_CHANNELS: CampaignChannel[] = ["instagram", "threads", "twitter", "xhs", "linkedin", "email"];

function key(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function slug(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 100) || "campaign";
}

export function FeedCampaigns(props: {
  workspaceId: string;
  initialCampaigns?: CampaignSummary[];
  initialResults?: CampaignResults;
}) {
  const t = useT().feedPage;
  const tc = t.campaigns;
  const [campaigns, setCampaigns] = useState<CampaignSummary[]>(props.initialCampaigns ?? []);
  const [selectedId, setSelectedId] = useState<string | null>(props.initialCampaigns?.[0]?.id ?? null);
  const [selected, setSelected] = useState<CampaignSummary | null>(props.initialCampaigns?.[0] ?? null);
  const [loading, setLoading] = useState(props.initialCampaigns === undefined);
  const [results, setResults] = useState<CampaignResults | null>(props.initialResults ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [objective, setObjective] = useState("");
  const [sessionId, setSessionId] = useState("");
  const [channel, setChannel] = useState<CampaignChannel>("linkedin");
  const [placementId, setPlacementId] = useState("");
  const [destination, setDestination] = useState("");
  const [permalink, setPermalink] = useState("");

  async function reload(preferredId?: string) {
    const next = await listCampaigns(props.workspaceId);
    setCampaigns(next);
    const id = preferredId ?? selectedId ?? next[0]?.id ?? null;
    setSelectedId(id);
    if (id) setSelected(await getCampaign(props.workspaceId, id));
    else setSelected(null);
  }

  useEffect(() => {
    if (props.initialCampaigns !== undefined) return;
    let cancelled = false;
    listCampaigns(props.workspaceId)
      .then(async (rows) => {
        if (cancelled) return;
        setCampaigns(rows);
        const id = rows[0]?.id ?? null;
        setSelectedId(id);
        if (id) setSelected(await getCampaign(props.workspaceId, id));
      })
      .catch((reason: unknown) => {
        if (!cancelled) setError(reason instanceof Error ? reason.message : tc.loadFailed);
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [props.initialCampaigns, props.workspaceId, tc.loadFailed]);

  useEffect(() => {
    if (!selectedId || props.initialCampaigns?.some((item) => item.id === selectedId)) {
      setSelected(props.initialCampaigns?.find((item) => item.id === selectedId) ?? selected);
      return;
    }
    let cancelled = false;
    getCampaign(props.workspaceId, selectedId)
      .then((campaign) => { if (!cancelled) setSelected(campaign); })
      .catch((reason: unknown) => { if (!cancelled) setError(reason instanceof Error ? reason.message : tc.loadFailed); });
    return () => { cancelled = true; };
    // The selected object is intentionally not a dependency: it is the result.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.initialCampaigns, props.workspaceId, selectedId, tc.loadFailed]);

  useEffect(() => {
    if (!selectedId || props.initialResults) return;
    let cancelled = false;
    setResults(null);
    getCampaignResults(props.workspaceId, selectedId)
      .then((value) => { if (!cancelled) setResults(value); })
      .catch(() => { if (!cancelled) setResults({ state: "failed", reason: tc.resultsFailed }); });
    return () => { cancelled = true; };
  }, [props.initialResults, props.workspaceId, selectedId, tc.resultsFailed]);

  const placements = selected?.placements ?? [];
  const activePlacementId = placementId || placements[0]?.id || "";
  const activePlacement = useMemo(
    () => placements.find((item) => item.id === activePlacementId) ?? null,
    [activePlacementId, placements],
  );

  async function action(run: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await run(); } catch (reason) {
      setError(reason instanceof Error ? reason.message : tc.saveFailed);
    } finally { setBusy(false); }
  }

  function createCampaign(event: FormEvent) {
    event.preventDefault();
    if (!name.trim() || !objective.trim()) return;
    void action(async () => {
      const result = await runCampaignCommand<{ campaign: CampaignSummary }>({
        workspaceId: props.workspaceId,
        idempotencyKey: key("campaign-create"),
        command: {
          kind: "save_campaign",
          name: name.trim(),
          objective: objective.trim(),
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
          primaryConversion: "enquiry_submitted",
        },
      });
      setName("");
      setObjective("");
      await reload(result.campaign.id);
    });
  }

  function attachDraft(event: FormEvent) {
    event.preventDefault();
    if (!selected || !sessionId.trim()) return;
    void action(async () => {
      await runCampaignCommand({
        workspaceId: props.workspaceId,
        idempotencyKey: key("campaign-attach"),
        command: {
          kind: "attach_content",
          campaignId: selected.id,
          sessionId: sessionId.trim(),
          channel,
          placementKind: channel === "email" ? "email_body" : "body",
          placementKey: `${channel}_body`,
        },
      });
      setSessionId("");
      await reload(selected.id);
    });
  }

  function createLink(event: FormEvent) {
    event.preventDefault();
    if (!selected || !activePlacement || !destination.trim()) return;
    void action(async () => {
      await runCampaignCommand({
        workspaceId: props.workspaceId,
        idempotencyKey: key("campaign-link"),
        command: {
          kind: "create_link",
          campaignId: selected.id,
          placementId: activePlacement.id,
          destination: destination.trim(),
          utm: {
            source: activePlacement.channel === "email" ? "newsletter" : activePlacement.channel,
            medium: activePlacement.channel === "email" ? "email" : "organic_social",
            campaign: slug(selected.name),
            content: activePlacement.placementKey,
          },
          existingAttribution: "reject",
        },
      });
      setDestination("");
      await reload(selected.id);
    });
  }

  function recordPublication(event: FormEvent) {
    event.preventDefault();
    if (!selected || !activePlacement || !permalink.trim()) return;
    void action(async () => {
      await runCampaignCommand({
        workspaceId: props.workspaceId,
        idempotencyKey: key("campaign-published"),
        command: {
          kind: "record_manual_publication",
          placementId: activePlacement.id,
          permalink: permalink.trim(),
          publishedAt: new Date().toISOString(),
          approvedRevision: 0,
        },
      });
      setPermalink("");
      await reload(selected.id);
    });
  }

  return (
    <main className="mx-auto w-full max-w-6xl p-4 md:p-6" data-campaign-surface>
      <header className="mb-5">
        <div className="flex items-center gap-2">
          <Megaphone className="size-5" aria-hidden />
          <h1 className="text-xl font-semibold">{tc.title}</h1>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">{tc.subtitle}</p>
      </header>

      {error ? <p role="alert" className="mb-4 rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">{error}</p> : null}

      <div className="grid gap-5 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]">
        <section className="space-y-4" aria-label={tc.listLabel}>
          <form onSubmit={createCampaign} className="space-y-3 rounded-xl border border-border p-4">
            <h2 className="font-medium">{tc.createTitle}</h2>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">{tc.nameLabel}</span>
              <input value={name} onChange={(event) => setName(event.target.value)} maxLength={200} className="h-9 w-full rounded-lg border border-input bg-background px-3" />
            </label>
            <label className="block text-sm">
              <span className="mb-1 block text-muted-foreground">{tc.objectiveLabel}</span>
              <textarea value={objective} onChange={(event) => setObjective(event.target.value)} maxLength={5000} rows={3} className="w-full rounded-lg border border-input bg-background px-3 py-2" />
            </label>
            <Button type="submit" disabled={busy || !name.trim() || !objective.trim()}>
              <Plus className="size-4" aria-hidden /> {tc.createAction}
            </Button>
          </form>

          <div className="space-y-2">
            {loading ? <p className="text-sm text-muted-foreground">{tc.loading}</p> : null}
            {!loading && campaigns.length === 0 ? <p className="rounded-xl border border-dashed p-4 text-sm text-muted-foreground">{tc.empty}</p> : null}
            {campaigns.map((campaign) => (
              <button key={campaign.id} type="button" onClick={() => setSelectedId(campaign.id)}
                className={`w-full rounded-xl border p-3 text-left ${selectedId === campaign.id ? "border-foreground/35 bg-muted/50" : "border-border"}`}>
                <span className="block font-medium">{campaign.name}</span>
                <span className="mt-1 block line-clamp-2 text-sm text-muted-foreground">{campaign.objective}</span>
              </button>
            ))}
          </div>
        </section>

        <section className="min-w-0 rounded-xl border border-border p-4" aria-label={tc.detailLabel}>
          {!selected ? <p className="text-sm text-muted-foreground">{tc.chooseCampaign}</p> : (
            <div className="space-y-5">
              <div>
                <h2 className="text-lg font-semibold">{selected.name}</h2>
                <p className="text-sm text-muted-foreground">{selected.objective}</p>
                <div className="mt-3 text-sm">
                  <strong>{tc.resultsTitle}</strong>
                  {!results ? <p className="mt-1 text-muted-foreground">{tc.resultsLoading}</p>
                    : results.state === "available" ? (
                      <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                        <Result label={tc.pageViews} value={results.pageViews ?? 0} />
                        <Result label={tc.sessions} value={results.sessions ?? tc.unavailable} />
                        <Result label={tc.visitors} value={results.visitors ?? tc.unavailable} />
                        <Result label={tc.verifiedConversions} value={results.verifiedConversions ?? 0} />
                        <Result label={tc.smtpAccepted} value={results.emailAccepted ?? 0} />
                        <p className="col-span-full mt-1 text-xs text-muted-foreground">{tc.observedLimitation}</p>
                      </div>
                    ) : <p className="mt-1 text-muted-foreground">{results.reason ?? (results.state === "not_installed" ? tc.trackingNotConnected : tc.resultsUnavailable)}</p>}
                </div>
              </div>

              <form onSubmit={attachDraft} className="space-y-3 border-t border-border pt-4">
                <h3 className="font-medium">{tc.attachTitle}</h3>
                <div className="grid gap-3 sm:grid-cols-2">
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">{tc.sessionLabel}</span>
                    <input value={sessionId} onChange={(event) => setSessionId(event.target.value)} placeholder={tc.sessionPlaceholder} className="h-9 w-full rounded-lg border border-input bg-background px-3" />
                  </label>
                  <label className="text-sm">
                    <span className="mb-1 block text-muted-foreground">{tc.channelLabel}</span>
                    <Select items={CAMPAIGN_CHANNELS.map((item) => ({ value: item, label: t.platformLabels[item] }))} value={channel} onValueChange={(value) => { if (value) setChannel(value as CampaignChannel); }}>
                      <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                      <SelectContent>{CAMPAIGN_CHANNELS.map((item) => <SelectItem key={item} value={item}>{t.platformLabels[item]}</SelectItem>)}</SelectContent>
                    </Select>
                  </label>
                </div>
                <Button type="submit" variant="outline" disabled={busy || !sessionId.trim()}>{tc.attachAction}</Button>
                <p className="text-xs text-muted-foreground">{tc.manualHint}</p>
              </form>

              <div className="space-y-2 border-t border-border pt-4">
                <h3 className="font-medium">{tc.placementsTitle}</h3>
                {placements.length === 0 ? <p className="text-sm text-muted-foreground">{tc.noPlacements}</p> : (
                  <Select items={placements.map((item) => ({ value: item.id, label: `${item.channel === "email" ? tc.emailChannel : t.platformLabels[item.channel]}: ${item.placementKey}` }))} value={activePlacementId} onValueChange={(value) => setPlacementId(value ?? "")}>
                    <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                    <SelectContent>{placements.map((item) => <SelectItem key={item.id} value={item.id}>{item.channel === "email" ? tc.emailChannel : t.platformLabels[item.channel]}: {item.placementKey}</SelectItem>)}</SelectContent>
                  </Select>
                )}
              </div>

              {activePlacement?.channel === "email" ? <CampaignEmailPanel workspaceId={props.workspaceId} campaignId={selected.id} placementId={activePlacement.id} /> : null}

              <form onSubmit={createLink} className="space-y-2">
                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">{tc.destinationLabel}</span>
                  <input type="url" value={destination} onChange={(event) => setDestination(event.target.value)} placeholder="https://example.com/offer" className="h-9 w-full rounded-lg border border-input bg-background px-3" />
                </label>
                <Button type="submit" variant="outline" disabled={busy || !activePlacement || !destination.trim()}><Link2 className="size-4" aria-hidden /> {tc.trackLinkAction}</Button>
              </form>

              {activePlacement?.channel !== "email" ? <form onSubmit={recordPublication} className="space-y-2">
                <label className="block text-sm">
                  <span className="mb-1 block text-muted-foreground">{tc.permalinkLabel}</span>
                  <input type="url" value={permalink} onChange={(event) => setPermalink(event.target.value)} placeholder="https://social.example/post/123" className="h-9 w-full rounded-lg border border-input bg-background px-3" />
                </label>
                <Button type="submit" variant="outline" disabled={busy || !activePlacement || !permalink.trim()}><ExternalLink className="size-4" aria-hidden /> {tc.recordPublicationAction}</Button>
              </form> : null}

              {(selected.links ?? []).length > 0 ? (
                <div className="space-y-2 border-t border-border pt-4">
                  <h3 className="font-medium">{tc.linksTitle}</h3>
                  {(selected.links ?? []).map((link) => <code key={link.id} className="block break-all rounded-lg bg-muted p-2 text-xs">{link.destination}</code>)}
                </div>
              ) : null}
            </div>
          )}
        </section>
      </div>
    </main>
  );
}

function Result({ label, value }: { label: string; value: number | string }) {
  return <div><span className="block text-xs text-muted-foreground">{label}</span><strong className="text-base tabular-nums">{value}</strong></div>;
}
