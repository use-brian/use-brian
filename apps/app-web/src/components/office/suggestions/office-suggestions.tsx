"use client";

import { buttonVariants } from "@/components/ui/button";
import { officeTextareaClassName } from "@/components/office/office-chrome";

/** Author and review stored Office suggestions without speculative canonical mutation. [COMP:app-web/office-suggestions] */
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { documentRangePreimageHash, type OfficeCommand } from "@use-brian/office-model";
import { decideOfficeSuggestion, listOfficeSuggestions, submitOfficeCommand, type OfficeSuggestion, OfficeApiError } from "@/lib/office/api";
import { useOptionalWorkspaceContext } from "@/lib/workspace-context";
import { getUserInfo } from "@/lib/user";
import { Skeleton } from "@/components/skeleton";
import { useOfficeMetadataResource } from "@/lib/office/surface-cache";
import { officeMetadataRemaining } from "@/lib/office/metadata";
import { officePanelCachePrefix, officePanelCacheKey } from "@/lib/surface-prefetch";
import { invalidateSurfaceCache, readSurfaceCache } from "@/lib/surface-cache";
import { useT } from "@/lib/i18n/client";
import type { DocumentSuggestionRange } from "../document/comment-anchor";
import { appendOfflineCommand } from "@/lib/office/offline";

type OfficeSuggestionsProps = {
  workspaceId: string;
  artifactId: string;
  canDecide: boolean;
  canSuggest?: boolean;
  actorId?: string;
  baseVersion?: number;
  expectedSeq?: number;
  proposal?: DocumentSuggestionRange | null;
  onApplied?(): void | Promise<void>;
  offline?: boolean;
  onSuggestionsChange?(suggestions: OfficeSuggestion[]): void;
};

const EMPTY_SUGGESTIONS: OfficeSuggestion[] = [];

export function OfficeSuggestions(props: OfficeSuggestionsProps) {
  const workspace = useOptionalWorkspaceContext();
  const viewerId = workspace?.workspaceId === props.workspaceId ? workspace.me.id : "";
  const prefix = viewerId ? officePanelCachePrefix(props.workspaceId, viewerId) : null;
  const cacheKey = officePanelCacheKey(prefix, "suggestions", props.artifactId);
  const read = useOfficeMetadataResource(props.offline ? null : cacheKey, viewerId, () => listOfficeSuggestions(props.artifactId));
  const items = props.offline ? EMPTY_SUGGESTIONS : read.data;
  const t = useT().office;
  useLayoutEffect(() => {
    props.onSuggestionsChange?.(items ?? EMPTY_SUGGESTIONS);
    return () => props.onSuggestionsChange?.(EMPTY_SUGGESTIONS);
  }, [items, props.onSuggestionsChange]);
  if (!items) return <section aria-label={t.suggestions}><h2 className="text-sm font-semibold">{t.suggestions}</h2>{read.error ? <p role="alert" className="text-xs text-destructive">{t.loadFailed}</p> : <Skeleton className="h-24 w-full"/>}</section>;
  return <OfficeSuggestionsContent key={`${cacheKey}:${Boolean(props.offline)}`} {...props} viewerId={viewerId} items={items} cacheKey={cacheKey} refresh={read.refresh} />;
}

function OfficeSuggestionsContent({ workspaceId, artifactId, canDecide, canSuggest = false, actorId, baseVersion = 0, expectedSeq = 1, proposal, onApplied, offline = false, viewerId, items, cacheKey, refresh }: OfficeSuggestionsProps & {viewerId: string; items: OfficeSuggestion[]; cacheKey: string | null; refresh: () => Promise<OfficeSuggestion[] | undefined>}) {
  const offlineOwner = useMemo(() => ({workspaceId, userId: viewerId}), [workspaceId, viewerId]);
  const t = useT().office;
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [replacement, setReplacement] = useState(proposal?.text ?? "");
  const [submitError, setSubmitError] = useState(false);
  const lifetime = useRef<symbol | null>(null);
  const pending = useRef(false);
  const capabilities = useRef({suggest: canSuggest, decide: canDecide});
  useLayoutEffect(() => {capabilities.current = {suggest: canSuggest, decide: canDecide};}, [canSuggest, canDecide]);
  useLayoutEffect(() => {lifetime.current = Symbol(); return () => {lifetime.current = null;};}, []);
  function owned() {
    return lifetime.current !== null && getUserInfo()?.id === viewerId && (offline || officeMetadataRemaining(readSurfaceCache<OfficeSuggestion[]>(cacheKey).data, viewerId) > 0);
  }
  async function run(label: string, action: (current: () => boolean) => Promise<void>, capability: "suggest" | "decide" = "decide") {
    if (!owned() || pending.current || !capabilities.current[capability]) return;
    const owner = lifetime.current;
    const current = () => owner === lifetime.current && capabilities.current[capability] && owned();
    pending.current = true;setBusy(label);setSubmitError(false);
    try {await action(current);}
    catch (error) {
      if (current()) {
        if (cacheKey && error instanceof OfficeApiError && [401,403,404].includes(error.status)) invalidateSurfaceCache(cacheKey);
        else setSubmitError(true);
      }
    } finally {if (owner === lifetime.current) {pending.current = false;setBusy(null);}}
  }
  async function reload(current: () => boolean) {
    if (!current() || offline) return;
    if (readSurfaceCache(cacheKey).revalidating) {await refresh();if (!current()) return;}
    await refresh();
  }
  const actionable = (id: string) => readSurfaceCache<OfficeSuggestion[]>(cacheKey).data?.some(row => row.id === id && row.status === "open");
  useEffect(() => { setReplacement(proposal?.text ?? ""); setSubmitError(false); }, [proposal?.from, proposal?.targetId, proposal?.text, proposal?.to]);
  const visible = items.filter((item) => filter === "all" || item.status === "open" || item.status === "conflicted");

  async function submitProposal() {
    if (!canSuggest || !proposal || actorId !== viewerId || !actorId || replacement === proposal.text) return;
    const command: OfficeCommand = {
      commandId: crypto.randomUUID(),
      artifactId,
      baseVersion,
      actor: { type: "user", id: actorId },
      origin: "manual",
      kind: "replaceTextRange",
      targetId: proposal.targetId,
      from: proposal.from,
      to: proposal.to,
      preimageHash: documentRangePreimageHash(proposal.text),
      runs: replacement ? [{ id: crypto.randomUUID(), text: replacement, style: proposal.style, ...(proposal.href ? { href: proposal.href } : {}) }] : [],
    };
    await run("create", async current => {
      if (offline) {
        await appendOfflineCommand({ artifactId, seq: Date.now() * 1_000 + Math.floor(Math.random() * 1_000), kind: "suggestion", expectedSeq, command: { ...command, origin: "offline" }, createdAt: new Date().toISOString() }, offlineOwner);
      } else {
        await submitOfficeCommand(artifactId, expectedSeq, command, "suggest");
        await reload(current);
      }
    }, "suggest");
  }

  async function decide(item: OfficeSuggestion, decision: "accepted" | "rejected") {
    if (!canDecide || offline || !actionable(item.id)) return;
    await run(item.id, async current => {
      await decideOfficeSuggestion(item.id, decision);
      await reload(current);
      if (current() && decision === "accepted") await onApplied?.();
    });
  }

  async function decideAll(decision: "accepted" | "rejected") {
    if (!canDecide || offline) return;
    const open = items.filter(item => item.status === "open");
    await run("all", async current => {
      for (const item of open) {
        if (!current() || !actionable(item.id)) return;
        await decideOfficeSuggestion(item.id, decision);
      }
      await reload(current);
      if (current() && decision === "accepted" && open.length > 0) await onApplied?.();
    });
  }

  return <section aria-label={t.suggestions} className="space-y-3">
    <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{t.suggestions}</h2><div className="flex gap-1"><button type="button" aria-pressed={filter === "open"} onClick={() => setFilter("open")} className={buttonVariants({ variant: "ghost", size: "sm", className: "aria-pressed:bg-muted" })}>{t.open}</button><button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")} className={buttonVariants({ variant: "ghost", size: "sm", className: "aria-pressed:bg-muted" })}>{t.allSuggestions}</button></div></div>
    {canSuggest ? <div className="space-y-2 rounded-lg border p-3">
      <p className="text-xs font-medium">{t.proposeReplacement}</p>
      {proposal ? <><p className="line-clamp-3 rounded bg-muted p-2 text-xs text-muted-foreground">{proposal.text}</p><textarea aria-label={t.replacementText} value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder={t.replacementText} className={`${officeTextareaClassName} min-h-20 w-full`} /><button type="button" disabled={busy !== null || !actorId || replacement === proposal.text} onClick={() => void submitProposal()} className={buttonVariants({ variant: "default", size: "sm" })}>{t.submitSuggestion}</button></> : <p className="text-xs text-muted-foreground">{t.selectTextToSuggest}</p>}
    </div> : null}
    {canDecide && items.some((item) => item.status === "open") ? <div className="flex gap-2"><button type="button" disabled={busy !== null} onClick={() => void decideAll("accepted")} className={buttonVariants({ variant: "default", size: "sm" })}>{t.acceptAll}</button><button type="button" disabled={busy !== null} onClick={() => void decideAll("rejected")} className={buttonVariants({ variant: "outline", size: "sm" })}>{t.rejectAll}</button></div> : null}
    <div className="space-y-2">{visible.map((item) => <article key={item.id} className="rounded-lg border p-3" data-suggestion-status={item.status}><p className="text-xs font-medium">{suggestionLabel(item, t)}</p><p className="mt-1 text-xs text-muted-foreground">{statusLabel(item.status, t)}</p>{canDecide && item.status === "open" ? <div className="mt-2 flex gap-2"><button type="button" disabled={busy !== null} onClick={() => void decide(item, "accepted")} className={buttonVariants({ variant: "default", size: "sm" })}>{t.acceptSuggestion}</button><button type="button" disabled={busy !== null} onClick={() => void decide(item, "rejected")} className={buttonVariants({ variant: "outline", size: "sm" })}>{t.rejectSuggestion}</button></div> : null}</article>)}</div>
    {submitError ? <p className="text-xs text-destructive" role="alert">{t.suggestionCreateFailed}</p> : null}
    {visible.length === 0 ? <p className="text-xs text-muted-foreground">{t.noSuggestions}</p> : null}
  </section>;
}

function suggestionLabel(item: OfficeSuggestion, t: ReturnType<typeof useT>["office"]): string {
  const command = item.commandBatch;
  if (command.kind === "replaceTextRange") return t.suggestionReplaceText;
  if (command.kind === "batch") return t.suggestionChanges.replace("{count}", String(command.commands.length));
  return t.suggestionChange;
}

function statusLabel(status: OfficeSuggestion["status"], t: ReturnType<typeof useT>["office"]): string {
  if (status === "conflicted") return t.suggestionConflicted;
  return { open: t.open, accepted: t.suggestionAccepted, rejected: t.suggestionRejected, superseded: t.suggestionSuperseded }[status];
}
