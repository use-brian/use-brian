"use client";

/** Author and review stored Office suggestions without speculative canonical mutation. [COMP:app-web/office-suggestions] */
import { useEffect, useState } from "react";
import { documentRangePreimageHash, type OfficeCommand } from "@use-brian/office-model";
import { decideOfficeSuggestion, listOfficeSuggestions, submitOfficeCommand, type OfficeSuggestion } from "@/lib/office/api";
import { useT } from "@/lib/i18n/client";
import type { DocumentSuggestionRange } from "../document/comment-anchor";
import { appendOfflineCommand } from "@/lib/office/offline";

type OfficeSuggestionsProps = {
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

export function OfficeSuggestions({ artifactId, canDecide, canSuggest = false, actorId, baseVersion = 0, expectedSeq = 1, proposal, onApplied, offline = false, onSuggestionsChange }: OfficeSuggestionsProps) {
  const t = useT().office;
  const [items, setItems] = useState<OfficeSuggestion[]>([]);
  const [filter, setFilter] = useState<"open" | "all">("open");
  const [busy, setBusy] = useState<string | null>(null);
  const [replacement, setReplacement] = useState(proposal?.text ?? "");
  const [submitError, setSubmitError] = useState(false);
  const setVisibleSuggestions = (next: OfficeSuggestion[]) => { setItems(next); onSuggestionsChange?.(next); };
  const reload = () => listOfficeSuggestions(artifactId).then(setVisibleSuggestions).catch(() => setVisibleSuggestions([]));
  useEffect(() => { if (offline) setVisibleSuggestions([]); else void reload(); }, [artifactId, offline]);
  useEffect(() => { setReplacement(proposal?.text ?? ""); setSubmitError(false); }, [proposal?.from, proposal?.targetId, proposal?.text, proposal?.to]);
  const visible = items.filter((item) => filter === "all" || item.status === "open" || item.status === "conflicted");

  async function submitProposal() {
    if (!proposal || !actorId || replacement === proposal.text) return;
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
    setBusy("create"); setSubmitError(false);
    try {
      if (offline) {
        await appendOfflineCommand({ artifactId, seq: Date.now() * 1_000 + Math.floor(Math.random() * 1_000), kind: "suggestion", expectedSeq, command: { ...command, origin: "offline" }, createdAt: new Date().toISOString() });
      } else {
        await submitOfficeCommand(artifactId, expectedSeq, command, "suggest");
        await reload();
      }
    } catch {
      setSubmitError(true);
    } finally {
      setBusy(null);
    }
  }

  async function decide(item: OfficeSuggestion, decision: "accepted" | "rejected") {
    setBusy(item.id);
    try {
      await decideOfficeSuggestion(item.id, decision);
      await reload();
      if (decision === "accepted") await onApplied?.();
    } finally { setBusy(null); }
  }

  async function decideAll(decision: "accepted" | "rejected") {
    const open = items.filter((item) => item.status === "open");
    setBusy("all");
    try {
      for (const item of open) await decideOfficeSuggestion(item.id, decision);
      await reload();
      if (decision === "accepted" && open.length > 0) await onApplied?.();
    } finally { setBusy(null); }
  }

  return <section aria-label={t.suggestions} className="space-y-3">
    <div className="flex items-center justify-between"><h2 className="text-sm font-semibold">{t.suggestions}</h2><div className="flex gap-1"><button type="button" aria-pressed={filter === "open"} onClick={() => setFilter("open")} className="rounded px-2 py-1 text-xs aria-pressed:bg-muted">{t.open}</button><button type="button" aria-pressed={filter === "all"} onClick={() => setFilter("all")} className="rounded px-2 py-1 text-xs aria-pressed:bg-muted">{t.allSuggestions}</button></div></div>
    {canSuggest ? <div className="space-y-2 rounded-lg border p-3">
      <p className="text-xs font-medium">{t.proposeReplacement}</p>
      {proposal ? <><p className="line-clamp-3 rounded bg-muted p-2 text-xs text-muted-foreground">{proposal.text}</p><textarea aria-label={t.replacementText} value={replacement} onChange={(event) => setReplacement(event.target.value)} placeholder={t.replacementText} className="min-h-20 w-full resize-y rounded border bg-background p-2 text-sm" /><button type="button" disabled={busy !== null || !actorId || replacement === proposal.text} onClick={() => void submitProposal()} className="rounded bg-action px-2 py-1 text-xs text-action-foreground disabled:opacity-50">{t.submitSuggestion}</button></> : <p className="text-xs text-muted-foreground">{t.selectTextToSuggest}</p>}
      {submitError ? <p className="text-xs text-destructive" role="alert">{t.suggestionCreateFailed}</p> : null}
    </div> : null}
    {canDecide && items.some((item) => item.status === "open") ? <div className="flex gap-2"><button type="button" disabled={busy !== null} onClick={() => void decideAll("accepted")} className="rounded bg-action px-2 py-1 text-xs text-action-foreground disabled:opacity-50">{t.acceptAll}</button><button type="button" disabled={busy !== null} onClick={() => void decideAll("rejected")} className="rounded border px-2 py-1 text-xs disabled:opacity-50">{t.rejectAll}</button></div> : null}
    <div className="space-y-2">{visible.map((item) => <article key={item.id} className="rounded-lg border p-3" data-suggestion-status={item.status}><p className="text-xs font-medium">{suggestionLabel(item, t)}</p><p className="mt-1 text-xs text-muted-foreground">{statusLabel(item.status, t)}</p>{canDecide && item.status === "open" ? <div className="mt-2 flex gap-2"><button type="button" disabled={busy !== null} onClick={() => void decide(item, "accepted")} className="rounded bg-action px-2 py-1 text-xs text-action-foreground disabled:opacity-50">{t.acceptSuggestion}</button><button type="button" disabled={busy !== null} onClick={() => void decide(item, "rejected")} className="rounded border px-2 py-1 text-xs disabled:opacity-50">{t.rejectSuggestion}</button></div> : null}</article>)}</div>
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
