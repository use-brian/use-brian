"use client";

/**
 * Feed voice — the team voice-memories surface, ported faithfully from
 * `apps/feed-web/src/app/w/[workspaceId]/voice/page.tsx`
 * (docs/plans/feed-web-consolidation.md §7.3): the team-scope memories that
 * shape draft tone and content, with admin-gated add/edit/delete forms, a
 * per-type filter strip, a compact rule navigator, and a readable selected
 * rule whose refine action seeds the floating tuning chat.
 *
 * Port deltas (disposition rules §6):
 *   - `useWorkspaceContext()` → `useFeedWorkspace()`.
 *   - Memory CRUD rides the feed SDK (`fetchFeedVoiceMemories`,
 *     `createFeedVoiceMemory`, `updateFeedVoiceMemory`,
 *     `deleteFeedVoiceMemory`) instead of inline `authFetch`.
 *   - feed-web's `useConfirm()` (in-page dialog element) → the app-root
 *     `confirmDialog()` promise.
 *   - The form's native `<select>`s → `@/components/ui/select` (the repo's
 *     no-native-dialogs rule); fixed enum options get label maps with a
 *     raw-value fallback for arbitrary server data.
 *   - Guided build and refine actions seed the FEED bus
 *     (`requestFeedChatSeed`, `feed-chat-seed`).
 *   - The no-assistant state's CTA links to the feed home (`feedPath`) —
 *     feed-web's `/onboarding` route is not ported (§5 route map).
 *   - All copy via `useT().feedPage.voice`.
 *
 * [COMP:app-web/feed-voice]
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { brandVoiceSummary } from "@/lib/feed-brand";
import { cn } from "@/lib/utils";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import {
  createFeedVoiceMemory,
  deleteFeedVoiceMemory,
  fetchFeedVoiceMemories,
  updateFeedVoiceMemory,
  type FeedVoiceMemory,
} from "@/lib/api/feed";
import { feedPath } from "@/lib/feed-nav";
import { CardSkeletonList } from "@/components/skeleton";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { requestFeedChatSeed } from "@/lib/feed-chat-seed";
import {
  FEED_PLATFORMS,
  defaultFeedPlatform,
  isFeedPlatform,
  type FeedPlatform,
} from "@/lib/feed-nav";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type FeedPageDict = ReturnType<typeof useT>["feedPage"];
type VoiceDict = FeedPageDict["voice"];

type Sensitivity = "public" | "internal" | "confidential";

/**
 * What the rail can select: one platform, or the baseline every platform
 * inherits. Not a union with "all" - see the state comment in `FeedVoice`.
 */
type VoiceScope = FeedPlatform | "company";

const MEMORY_TYPES = ["voice", "identity", "policy", "style", "example"] as const;
const SENSITIVITIES: Sensitivity[] = ["public", "internal", "confidential"];

type FormState = {
  summary: string;
  detail: string;
  type: string;
  tags: string;
  sensitivity: Sensitivity;
};

const DEFAULT_FORM: FormState = {
  summary: "",
  detail: "",
  type: "voice",
  tags: "",
  sensitivity: "internal",
};

/** Split a comma-separated tag string into trimmed, non-empty tags. Pure. */
export function parseTags(raw: string): string[] {
  return raw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

export type VoiceDetailBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; ordered: boolean; items: string[] };

/**
 * Turn the plain-text memory detail into readable prose without pretending it
 * is trusted Markdown. Imported voice analyses commonly contain short
 * headings and dash/number lists; preserving that structure is the difference
 * between a useful rule and one dense, raw text blob.
 */
export function parseVoiceDetail(raw: string): VoiceDetailBlock[] {
  const blocks: VoiceDetailBlock[] = [];
  let paragraph: string[] = [];
  let list: Extract<VoiceDetailBlock, { kind: "list" }> | null = null;

  const flushParagraph = () => {
    const text = paragraph.join(" ").trim();
    if (text) blocks.push({ kind: "paragraph", text });
    paragraph = [];
  };
  const flushList = () => {
    if (list && list.items.length > 0) blocks.push(list);
    list = null;
  };

  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      flushList();
      continue;
    }

    const unordered = line.match(/^[-*]\s+(.+)$/);
    const ordered = line.match(/^\d+[.)]\s+(.+)$/);
    const item = unordered?.[1] ?? ordered?.[1];
    if (item) {
      flushParagraph();
      const isOrdered = Boolean(ordered);
      if (!list || list.ordered !== isOrdered) {
        flushList();
        list = { kind: "list", ordered: isOrdered, items: [] };
      }
      list.items.push(item.trim());
      continue;
    }

    flushList();
    if (line.endsWith(":") && line.length <= 80) {
      flushParagraph();
      blocks.push({ kind: "heading", text: line.slice(0, -1) });
      continue;
    }
    paragraph.push(line);
  }

  flushParagraph();
  flushList();
  return blocks;
}

/** Resolve the previous/next rule without wrapping past the list ends. */
export function adjacentVoiceId(
  items: Pick<FeedVoiceMemory, "id">[],
  currentId: string,
  direction: -1 | 1,
): string | null {
  const index = items.findIndex((item) => item.id === currentId);
  const adjacent = index + direction;
  return index >= 0 && adjacent >= 0 && adjacent < items.length
    ? items[adjacent]!.id
    : null;
}

/**
 * The "Discuss" seed prompt for one rule — the rule quoted in the composer,
 * with its tags when present. Null when the rule has no summary (nothing to
 * quote). Pure — unit-tested directly.
 */
export function buildDiscussPrompt(
  t: Pick<VoiceDict, "discussPrompt" | "discussPromptTags">,
  m: Pick<FeedVoiceMemory, "summary" | "tags">,
): string | null {
  const summary = (m.summary ?? "").trim();
  if (!summary) return null;
  const tagSuffix =
    m.tags && m.tags.length > 0
      ? format(t.discussPromptTags, { tags: m.tags.join(", ") })
      : "";
  return format(t.discussPrompt, { tagSuffix, summary });
}

/** Fixed-enum label with a raw-value fallback for arbitrary server data. */
function typeLabel(t: VoiceDict, type: string): string {
  return (t.types as Record<string, string>)[type] ?? type;
}
function sensitivityLabel(t: VoiceDict, sensitivity: string): string {
  return (t.sensitivities as Record<string, string>)[sensitivity] ?? sensitivity;
}

export function FeedVoice({ scope }: { scope: VoiceScope }) {
  const team = useFeedWorkspace();
  const feedT = useT().feedPage;

  /**
   * Platform-agnostic voice import (feed-create-split.md D4): the operator
   * pastes past posts; the tuning chat analyzes them and proposes voice
   * rules with the same propose-then-approve flow as the X import. The
   * dialog hosts the textarea; this closure owns the value (the `content`
   * contract in confirm-dialog.tsx). The samples ride a seeded tuning-chat
   * message — no new backend tool.
   */
  async function importFromSamples() {
    let samples = "";
    // The import inherits the rail's scope: training X voice from X posts is
    // the whole point, and a baseline import stays one click away.
    let platform: FeedPlatform | null =
      voicePlatform === "company" ? null : voicePlatform;
    const ok = await confirmDialog({
      title: t.importSamplesTitle,
      description: t.importSamplesBody,
      confirmLabel: t.importSamplesCta,
      content: (
        <ImportSamplesContent
          initialPlatform={platform}
          onSamplesChange={(v) => {
            samples = v;
          }}
          onPlatformChange={(p) => {
            platform = p;
          }}
        />
      ),
    });
    const trimmed = samples.trim().slice(0, 20_000);
    if (!ok || !trimmed) return;
    const base = format(t.importSamplesPrompt, { samples: trimmed });
    // Platform-scoped import (per-platform voice): tell the assistant which
    // platform the samples belong to and to tag proposed rules with it.
    const chosen = platform as FeedPlatform | null;
    const prefill = chosen
      ? `${format(t.importSamplesPlatformNote, {
          platform: feedT.platformLabels[chosen],
          tag: chosen,
        })}\n\n${base}`
      : base;
    requestFeedChatSeed({ prefill });
  }

  /**
   * Voice import by X handle (feed-import-account.md D8): the operator names
   * any PUBLIC X account and the tuning chat runs the `import-voice-from-x`
   * skill for it — fetch, analyze, propose, approve. Same seeded-chat
   * pattern as the paste-in import: the dialog collects the handle + scope,
   * the chat owns everything else. No new backend route.
   */
  async function importFromHandle() {
    let handle = "";
    let platform: FeedPlatform | null =
      voicePlatform === "company" ? null : voicePlatform;
    const ok = await confirmDialog({
      title: t.importHandleTitle,
      description: t.importHandleBody,
      confirmLabel: t.importHandleCta,
      content: (
        <ImportHandleContent
          initialPlatform={platform}
          onHandleChange={(v) => {
            handle = v;
          }}
          onPlatformChange={(p) => {
            platform = p;
          }}
        />
      ),
    });
    const trimmed = handle.trim().replace(/^@/, "").slice(0, 30);
    if (!ok || !trimmed) return;
    const base = format(t.importHandlePrompt, { handle: trimmed });
    const chosen = platform as FeedPlatform | null;
    const prefill = chosen
      ? `${format(t.importHandlePlatformNote, {
          platform: feedT.platformLabels[chosen],
          tag: chosen,
        })}\n\n${base}`
      : base;
    requestFeedChatSeed({ prefill });
  }
  const t = feedT.voice;
  const tb = feedT.brand;
  // D37. Read-only, company scope only, and null unless the workspace has an
  // APPROVED brand with something to say.
  const brandVoice = useMemo(
    () => brandVoiceSummary(team.brand),
    [team.brand],
  );
  // Create split (feed-create-split.md D7): voice works with zero
  // connections — fall back to the workspace's brand-voice assistant when
  // no profile is connected.
  const primaryAssistant = team.profiles[0]?.assistant ?? team.assistants[0];
  const isAdmin = team.role === "admin" || team.role === "owner";

  const [items, setItems] = useState<FeedVoiceMemory[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Scope comes from the ROUTE now (feed-revamp.md D13): `/feed/voice` is
  // company-wide, `/feed/<platform>/voice` is that platform. The sidebar
  // owns the switcher, so an in-page scope rail would be a second picker
  // for the same thing.
  const voicePlatform = scope;

  // Add form
  const [showAdd, setShowAdd] = useState(false);
  const [addForm, setAddForm] = useState<FormState>(DEFAULT_FORM);
  const [addBusy, setAddBusy] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);
  const addSummaryRef = useRef<HTMLTextAreaElement>(null);

  // Edit form (keyed by memory id)
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editForm, setEditForm] = useState<FormState>(DEFAULT_FORM);
  const [editBusy, setEditBusy] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Delete
  const [deletingId, setDeletingId] = useState<string | null>(null);

  async function load() {
    if (!primaryAssistant) return;
    try {
      const body = await fetchFeedVoiceMemories(primaryAssistant.id, { limit: 100 });
      setItems(body.memories);
      setTotal(body.total);
    } catch {
      setError(t.loadFailed);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!primaryAssistant) {
      setLoading(false);
      return;
    }
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [primaryAssistant?.id]);

  useEffect(() => {
    if (showAdd) {
      setTimeout(() => addSummaryRef.current?.focus(), 50);
    }
  }, [showAdd]);

  async function submitAdd() {
    if (!primaryAssistant) return;
    if (!addForm.summary.trim()) {
      setAddError(t.summaryRequired);
      return;
    }
    setAddBusy(true);
    setAddError(null);
    try {
      const result = await createFeedVoiceMemory(primaryAssistant.id, {
        summary: addForm.summary.trim(),
        detail: addForm.detail.trim() || undefined,
        type: addForm.type,
        tags: parseTags(addForm.tags),
        sensitivity: addForm.sensitivity,
      });
      if (!result.ok) {
        setAddError(result.error ?? t.saveFailed);
        return;
      }
      setShowAdd(false);
      setAddForm(DEFAULT_FORM);
      await load();
    } catch {
      setAddError(t.saveFailed);
    } finally {
      setAddBusy(false);
    }
  }

  function startEdit(m: FeedVoiceMemory) {
    setEditingId(m.id);
    setEditForm({
      summary: m.summary ?? "",
      detail: m.detail ?? "",
      type: m.type ?? "voice",
      tags: (m.tags ?? []).join(", "),
      sensitivity: (m.sensitivity as Sensitivity | null) ?? "internal",
    });
    setEditError(null);
  }

  async function submitEdit() {
    if (!primaryAssistant || !editingId) return;
    if (!editForm.summary.trim()) {
      setEditError(t.summaryRequired);
      return;
    }
    setEditBusy(true);
    setEditError(null);
    try {
      const result = await updateFeedVoiceMemory(primaryAssistant.id, editingId, {
        summary: editForm.summary.trim(),
        detail: editForm.detail.trim() || undefined,
        tags: parseTags(editForm.tags),
        sensitivity: editForm.sensitivity,
      });
      if (!result.ok) {
        setEditError(result.error ?? t.saveFailed);
        return;
      }
      setEditingId(null);
      await load();
    } catch {
      setEditError(t.saveFailed);
    } finally {
      setEditBusy(false);
    }
  }

  async function deleteMemory(id: string) {
    if (!primaryAssistant) return;
    const ok = await confirmDialog({
      title: t.deleteConfirmTitle,
      description: t.deleteConfirmDescription,
      confirmLabel: t.deleteConfirmLabel,
      variant: "destructive",
    });
    if (!ok) return;
    setDeletingId(id);
    try {
      await deleteFeedVoiceMemory(primaryAssistant.id, id);
      setItems((prev) => prev.filter((m) => m.id !== id));
      setTotal((prev) => prev - 1);
    } catch {
      /* keep item visible on error */
    } finally {
      setDeletingId(null);
    }
  }

  function discussMemory(m: FeedVoiceMemory) {
    const prompt = buildDiscussPrompt(t, m);
    if (!prompt) return;
    // Open the floating chat (mounted by the feed surface shell) with the
    // rule quoted in the composer.
    requestFeedChatSeed({ prefill: prompt });
  }

  function buildVoiceInChat() {
    const label =
      voicePlatform === "company"
        ? t.baselineLabel
        : feedT.platformLabels[voicePlatform];
    requestFeedChatSeed({
      prefill: format(t.buildPrompt, { scope: label }),
    });
  }

  const types = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) if (it.type) set.add(it.type);
    return ["all", ...Array.from(set)];
  }, [items]);

  const filtered = useMemo(
    () => (filter === "all" ? items : items.filter((m) => m.type === filter)),
    [items, filter],
  );

  // The exact set a draft session for this scope injects: the platform's own
  // rules, plus the baseline every platform inherits. Rules scoped only to
  // other platforms live in their own rail entry.
  const platformTagsOf = (m: FeedVoiceMemory) =>
    (m.tags ?? []).filter(isFeedPlatform);
  const baselineRules = useMemo(
    () => filtered.filter((m) => platformTagsOf(m).length === 0),
    [filtered],
  );
  const scopedRules = useMemo(
    () =>
      voicePlatform === "company"
        ? []
        : filtered.filter((m) => platformTagsOf(m).includes(voicePlatform)),
    [filtered, voicePlatform],
  );
  const visible = useMemo(
    () => (voicePlatform === "company" ? baselineRules : [...scopedRules, ...baselineRules]),
    [voicePlatform, baselineRules, scopedRules],
  );

  // Keep a real selection as filters, edits, and deletes reshape the list.
  // The derived fallback avoids a blank detail pane during the effect tick.
  const selectedMemory =
    visible.find((memory) => memory.id === selectedId) ?? visible[0] ?? null;
  const selectedIndex = selectedMemory
    ? visible.findIndex((memory) => memory.id === selectedMemory.id)
    : -1;

  useEffect(() => {
    if (!selectedMemory) {
      setSelectedId(null);
      return;
    }
    if (selectedId !== selectedMemory.id) setSelectedId(selectedMemory.id);
  }, [selectedId, selectedMemory]);

  const renderRuleListItem = (m: FeedVoiceMemory) => (
    <VoiceRuleListItem
      key={m.id}
      memory={m}
      selected={m.id === selectedMemory?.id}
      onSelect={() => setSelectedId(m.id)}
    />
  );

  if (!primaryAssistant) {
    return (
      <div className="px-4 md:px-6 py-6 max-w-2xl space-y-4">
        <h1 className="text-[15px] font-semibold">
          {t.noVoiceTitle}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t.noVoiceBody}
        </p>
        <Link
          href={feedPath(team.workspaceId)}
          className="inline-flex items-center justify-center rounded-lg bg-action px-3 h-8 text-[12.5px] font-medium text-action-foreground hover:bg-action/90"
        >
          {t.noVoiceCta}
        </Link>
      </div>
    );
  }

  const scopeLabel =
    voicePlatform === "company"
      ? t.baselineLabel
      : feedT.platformLabels[voicePlatform];

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-[1480px] space-y-5 px-4 py-5 md:px-6 lg:px-8">
          <header className="flex flex-wrap items-start justify-between gap-4 border-b border-border/60 pb-5">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <h1 className="text-[15px] font-semibold">
                  {format(t.scopeHeading, { scope: scopeLabel })}
                </h1>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {total === 1 ? t.ruleCountOne : format(t.ruleCount, { count: total })}
                </span>
              </div>
              <p className="max-w-xl text-sm leading-relaxed text-muted-foreground">
                {voicePlatform === "company"
                  ? t.baselineScopeSubtitle
                  : format(t.platformScopeSubtitle, { platform: scopeLabel })}
              </p>
            </div>
            <div className="flex w-full flex-wrap items-center gap-1.5 sm:w-auto sm:justify-end">
              {isAdmin ? (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <Button variant="outline" size="sm" type="button">
                        {t.importMenu}
                        <ChevronDownIcon />
                      </Button>
                    }
                  />
                  <DropdownMenuContent>
                    <DropdownMenuItem onClick={() => void importFromHandle()}>
                      {t.importHandle}
                    </DropdownMenuItem>
                    <DropdownMenuItem onClick={() => void importFromSamples()}>
                      {t.importSamples}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              ) : null}
              {isAdmin && !showAdd ? (
                <Button
                  variant="outline"
                  size="sm"
                  type="button"
                  onClick={() => {
                    // A new rule inherits the rail's scope; the form's chips
                    // can widen or clear it.
                    setAddForm({
                      ...DEFAULT_FORM,
                      tags: voicePlatform === "company" ? "" : voicePlatform,
                    });
                    setShowAdd(true);
                  }}
                >
                  <PlusIcon />
                  {t.injectRule}
                </Button>
              ) : null}
              {isAdmin ? (
                <Button
                  size="sm"
                  type="button"
                  onClick={buildVoiceInChat}
                  className="w-full sm:w-auto"
                >
                  <ChatBubbleSmallIcon />
                  {t.buildWithChat}
                </Button>
              ) : null}
            </div>
          </header>

          {/*
            D37. The approved brand's voice, above the Feed's own rules and
            READ-ONLY. Studio owns the record; two editors over one record is
            how they drift. Company scope only - the brand does not have a
            per-platform voice, and repeating it under every platform would
            imply it does.
          */}
          {voicePlatform === "company" && brandVoice ? (
            <section className="space-y-2.5 rounded-xl border border-border/60 p-4 shadow-xs">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <h2 className="text-[13px] font-semibold">{tb.voiceTitle}</h2>
                  <p className="text-[11px] text-muted-foreground">
                    {tb.voiceSubtitle}
                  </p>
                </div>
                <Link
                  href={`/w/${team.workspaceId}/studio/brand`}
                  className="text-[12px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
                >
                  {tb.voiceEditInStudio}
                </Link>
              </div>

              {brandVoice.traits.length > 0 ? (
                <ul className="space-y-1.5">
                  {brandVoice.traits.map((trait) => (
                    <li key={trait.trait} className="text-[12.5px] leading-relaxed">
                      <span className="font-medium">{trait.trait}</span>
                      <span className="text-muted-foreground">
                        {" "}
                        {tb.voiceMeans}: {trait.means}
                        {trait.avoid ? ` · ${tb.voiceAvoid}: ${trait.avoid}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}

              {brandVoice.toneNotes.length > 0 ? (
                <p className="text-[12px] text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {tb.voiceTone}:
                  </span>{" "}
                  {brandVoice.toneNotes.join(" · ")}
                </p>
              ) : null}

              {brandVoice.capitalization ? (
                <p className="text-[12px] text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {tb.voiceCapitalization}:
                  </span>{" "}
                  {brandVoice.capitalization}
                </p>
              ) : null}
            </section>
          ) : null}

          {types.length > 2 ? (
            <div className="flex items-center gap-1 overflow-x-auto -mx-1 px-1 pb-1">
              {types.map((ty) => {
                const active = ty === filter;
                return (
                  <button
                    key={ty}
                    type="button"
                    onClick={() => setFilter(ty)}
                    className={
                      "shrink-0 rounded-full px-3 py-1 text-[12px] font-medium transition-colors capitalize " +
                      (active
                        ? "bg-foreground text-background"
                        : "bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground")
                    }
                  >
                    {ty === "all" ? t.filterAll : typeLabel(t, ty)}
                  </button>
                );
              })}
            </div>
          ) : null}

          {error ? (
            <div
              role="alert"
              className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}

          {showAdd ? (
            <div className="space-y-4 rounded-xl border border-border/60 bg-card p-4 shadow-xs">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium">{t.addTitle}</span>
                <button
                  type="button"
                  onClick={() => { setShowAdd(false); setAddForm(DEFAULT_FORM); setAddError(null); }}
                  className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  <XIcon />
                </button>
              </div>
              <VoiceForm
                form={addForm}
                onChange={setAddForm}
                error={addError}
                busy={addBusy}
                summaryRef={addSummaryRef}
                onSubmit={submitAdd}
                onCancel={() => { setShowAdd(false); setAddForm(DEFAULT_FORM); setAddError(null); }}
                submitLabel={t.saveRule}
              />
            </div>
          ) : null}

          {loading ? (
            <CardSkeletonList count={4} lines={2} />
          ) : items.length === 0 ? (
            <div className="space-y-2 rounded-xl border border-dashed border-border bg-card/40 p-8 text-center">
              <p className="text-sm font-medium">{t.emptyTitle}</p>
              <p className="mx-auto max-w-sm text-xs text-muted-foreground">
                {t.emptyBodyBefore} <strong>{t.injectRule}</strong> {t.emptyBodyAfter}
              </p>
            </div>
          ) : visible.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center text-xs text-muted-foreground">
              {filter !== "all" ? (
                <>
                  {t.typeEmptyBefore} <strong>{typeLabel(t, filter)}</strong> {t.typeEmptyAfter}
                </>
              ) : voicePlatform === "company" ? (
                t.baselineSectionEmpty
              ) : (
                format(t.platformSectionEmpty, {
                  platform: feedT.platformLabels[voicePlatform],
                })
              )}
            </div>
          ) : (
            <div className="grid items-start gap-4 pb-4 lg:grid-cols-[minmax(280px,360px)_minmax(0,1fr)] xl:gap-6">
              <nav
                aria-label={t.ruleNavigatorAria}
                className="max-h-[50vh] space-y-5 overflow-y-auto pr-1 lg:sticky lg:top-5 lg:max-h-none lg:overflow-visible lg:pr-0"
              >
                {voicePlatform !== "company" ? (
                  <section className="space-y-2">
                    <h2 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {format(t.platformSection, {
                        platform: feedT.platformLabels[voicePlatform],
                      })}
                    </h2>
                    {scopedRules.length > 0 ? (
                      <ul className="space-y-2">
                        {scopedRules.map(renderRuleListItem)}
                      </ul>
                    ) : (
                      <p className="rounded-xl border border-dashed border-border bg-card/40 p-4 text-xs leading-relaxed text-muted-foreground">
                        {format(t.platformSectionEmpty, {
                          platform: feedT.platformLabels[voicePlatform],
                        })}
                      </p>
                    )}
                  </section>
                ) : null}

                {baselineRules.length > 0 ? (
                  <section className="space-y-2">
                    <h2 className="px-1 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                      {voicePlatform === "company"
                        ? t.baselineSection
                        : t.inheritedSection}
                    </h2>
                    <ul className="space-y-2">
                      {baselineRules.map(renderRuleListItem)}
                    </ul>
                  </section>
                ) : null}
              </nav>

              <section className="min-w-0 overflow-hidden rounded-2xl border border-border/70 bg-card shadow-xs">
                {selectedMemory && editingId === selectedMemory.id ? (
                  <div className="space-y-5 p-5 md:p-7">
                    <div className="flex items-center justify-between gap-3 border-b border-border/60 pb-4">
                      <div>
                        <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                          {t.ruleEditorEyebrow}
                        </p>
                        <h2 className="mt-1 text-base font-semibold">{t.editTitle}</h2>
                      </div>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        type="button"
                        aria-label={t.cancel}
                        onClick={() => {
                          setEditingId(null);
                          setEditError(null);
                        }}
                      >
                        <XIcon />
                      </Button>
                    </div>
                    <VoiceForm
                      form={editForm}
                      onChange={setEditForm}
                      error={editError}
                      busy={editBusy}
                      onSubmit={submitEdit}
                      onCancel={() => {
                        setEditingId(null);
                        setEditError(null);
                      }}
                      submitLabel={t.saveChanges}
                    />
                  </div>
                ) : selectedMemory ? (
                  <VoiceRuleDetail
                    memory={selectedMemory}
                    isAdmin={isAdmin}
                    deleting={deletingId === selectedMemory.id}
                    position={selectedIndex + 1}
                    total={visible.length}
                    previousId={adjacentVoiceId(visible, selectedMemory.id, -1)}
                    nextId={adjacentVoiceId(visible, selectedMemory.id, 1)}
                    onSelect={setSelectedId}
                    onEdit={() => startEdit(selectedMemory)}
                    onDelete={() => void deleteMemory(selectedMemory.id)}
                    onDiscuss={() => discussMemory(selectedMemory)}
                  />
                ) : null}
              </section>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Voice form ───────────────────────────────────────────────────────────

function VoiceForm({
  form,
  onChange,
  error,
  busy,
  summaryRef,
  onSubmit,
  onCancel,
  submitLabel,
}: {
  form: FormState;
  onChange: (f: FormState) => void;
  error: string | null;
  busy: boolean;
  summaryRef?: React.RefObject<HTMLTextAreaElement | null>;
  onSubmit: () => void;
  onCancel: () => void;
  submitLabel: string;
}) {
  const feedT = useT().feedPage;
  const t = feedT.voice;
  const platformLabels = feedT.platformLabels;
  const feedPlatforms = FEED_PLATFORMS;
  const set = (key: keyof FormState) => (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => onChange({ ...form, [key]: e.target.value });

  // Platform tags ride the same comma string as free-form tags — the chips
  // and the text input edit one source of truth.
  const selectedPlatforms = parseTags(form.tags).filter(isFeedPlatform);
  const togglePlatform = (p: FeedPlatform) => {
    const tags = parseTags(form.tags);
    const next = tags.includes(p) ? tags.filter((tag) => tag !== p) : [...tags, p];
    onChange({ ...form, tags: next.join(", ") });
  };

  return (
    <div className="space-y-3">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{t.summaryLabel}</label>
        <textarea
          ref={summaryRef}
          value={form.summary}
          onChange={set("summary")}
          rows={2}
          maxLength={500}
          placeholder={t.summaryPlaceholder}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
        />
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{t.detailLabel}</label>
        <textarea
          value={form.detail}
          onChange={set("detail")}
          rows={3}
          placeholder={t.detailPlaceholder}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring resize-none"
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t.typeLabel}</label>
          <Select
            value={form.type}
            onValueChange={(v) => { if (v) onChange({ ...form, type: v }); }}
          >
            <SelectTrigger className="w-full rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {MEMORY_TYPES.map((ty) => (
                <SelectItem key={ty} value={ty}>{typeLabel(t, ty)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>

        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">{t.sensitivityLabel}</label>
          <Select
            value={form.sensitivity}
            onValueChange={(v) => { if (v) onChange({ ...form, sensitivity: v as Sensitivity }); }}
          >
            <SelectTrigger className="w-full rounded-xl">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {SENSITIVITIES.map((s) => (
                <SelectItem key={s} value={s}>{sensitivityLabel(t, s)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Platform scope — toggles platform tags inside the same comma
          string the free-form field edits (per-platform voice; none
          selected = the rule applies to every platform). */}
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{t.platformScopeLabel}</label>
        <div className="flex flex-wrap items-center gap-1.5">
          {feedPlatforms.map((p) => {
            const active = selectedPlatforms.includes(p);
            return (
              <button
                key={p}
                type="button"
                onClick={() => togglePlatform(p)}
                aria-pressed={active}
                className={
                  "press h-7 rounded-full border px-3 text-xs font-medium transition-colors " +
                  (active
                    ? "border-transparent bg-foreground text-background"
                    : "border-border bg-background/60 text-muted-foreground hover:bg-accent")
                }
              >
                {platformLabels[p]}
              </button>
            );
          })}
        </div>
        <p className="text-[11px] text-muted-foreground">{t.platformScopeHint}</p>
      </div>

      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">{t.tagsLabel}</label>
        <input
          type="text"
          value={form.tags}
          onChange={set("tags")}
          placeholder={t.tagsPlaceholder}
          className="w-full rounded-xl border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </div>

      {error ? (
        <p className="text-xs text-destructive">{error}</p>
      ) : null}

      <div className="flex justify-end gap-2 pt-1">
        <button
          type="button"
          onClick={onCancel}
          disabled={busy}
          className="rounded-xl border border-border px-4 h-9 text-sm hover:bg-accent disabled:opacity-50"
        >
          {t.cancel}
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={busy || !form.summary.trim()}
          className="rounded-lg bg-action text-action-foreground px-4 h-9 text-sm font-medium hover:bg-action/90 disabled:opacity-50"
        >
          {busy ? t.saving : submitLabel}
        </button>
      </div>
    </div>
  );
}

// ── Rule navigator + readable detail ─────────────────────────────────────

function VoiceRuleListItem({
  memory: m,
  selected,
  onSelect,
}: {
  memory: FeedVoiceMemory;
  selected: boolean;
  onSelect: () => void;
}) {
  const feedT = useT().feedPage;
  const t = feedT.voice;
  const platformLabels = feedT.platformLabels;
  const platformTags = (m.tags ?? []).filter(isFeedPlatform);
  return (
    <li>
      <button
        type="button"
        aria-current={selected ? "true" : undefined}
        onClick={onSelect}
        className={cn(
          "group w-full rounded-xl border px-3.5 py-3 text-left transition-all",
          selected
            ? "border-foreground/20 bg-foreground/[0.045] shadow-xs ring-1 ring-foreground/5"
            : "border-border/60 bg-card hover:border-border hover:bg-muted/35",
        )}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="rounded-full bg-muted/70 px-2 py-0.5 text-[9px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {typeLabel(t, m.type)}
            </span>
            {platformTags.map((p) => (
              <span
                key={p}
                className="rounded-full border border-border px-2 py-0.5 text-[9px] font-medium text-muted-foreground"
              >
                {platformLabels[p]}
              </span>
            ))}
          </div>
          <ChevronRightIcon />
        </div>
        <p className="mt-2 line-clamp-2 text-[13px] font-medium leading-5 text-foreground">
          {m.summary || t.untitledRule}
        </p>
        {m.detail && m.detail !== m.summary ? (
          <p className="mt-1 line-clamp-2 text-[11.5px] leading-[1.1rem] text-muted-foreground">
            {m.detail}
          </p>
        ) : null}
      </button>
    </li>
  );
}

export function VoiceRuleDetail({
  memory: m,
  isAdmin,
  deleting,
  position,
  total,
  previousId,
  nextId,
  onSelect,
  onEdit,
  onDelete,
  onDiscuss,
}: {
  memory: FeedVoiceMemory;
  isAdmin: boolean;
  deleting: boolean;
  position: number;
  total: number;
  previousId: string | null;
  nextId: string | null;
  onSelect: (id: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  onDiscuss: () => void;
}) {
  const feedT = useT().feedPage;
  const t = feedT.voice;
  const platformLabels = feedT.platformLabels;
  const platformTags = (m.tags ?? []).filter(isFeedPlatform);
  const descriptiveTags = (m.tags ?? []).filter((tag) => !isFeedPlatform(tag));
  const detailBlocks = parseVoiceDetail(m.detail ?? "");

  return (
    <div className="flex min-h-[430px] flex-col">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3 md:px-7">
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span>{format(t.rulePosition, { current: position, total })}</span>
          <span aria-hidden>·</span>
          <span className="tabular-nums">
            {new Date(m.updatedAt).toLocaleDateString()}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={!previousId}
            onClick={() => previousId && onSelect(previousId)}
          >
            <ChevronLeftIcon />
            {t.previousRule}
          </Button>
          <Button
            variant="ghost"
            size="sm"
            type="button"
            disabled={!nextId}
            onClick={() => nextId && onSelect(nextId)}
          >
            {t.nextRule}
            <ChevronRightIcon />
          </Button>
        </div>
      </div>

      <div className="flex-1 px-5 py-6 md:px-7 md:py-8">
        <div className="mx-auto max-w-3xl">
          <div className="flex flex-wrap items-center gap-2">
            <span className="rounded-full bg-muted/70 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {typeLabel(t, m.type)}
            </span>
            {m.sensitivity && m.sensitivity !== "internal" ? (
              <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
                {sensitivityLabel(t, m.sensitivity)}
              </span>
            ) : null}
            {platformTags.map((p) => (
              <span
                key={p}
                className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
              >
                {platformLabels[p]}
              </span>
            ))}
          </div>

          <h2 className="mt-4 text-xl font-semibold leading-7 tracking-[-0.01em] text-foreground md:text-2xl md:leading-8">
            {m.summary || t.untitledRule}
          </h2>

          {detailBlocks.length > 0 ? (
            <div className="mt-6 space-y-4 text-[14px] leading-7 text-foreground/75">
              {detailBlocks.map((block, index) => {
                if (block.kind === "heading") {
                  return (
                    <h3
                      key={`${block.kind}-${index}`}
                      className="pt-2 text-[13px] font-semibold uppercase tracking-wide text-foreground"
                    >
                      {block.text}
                    </h3>
                  );
                }
                if (block.kind === "list") {
                  const List = block.ordered ? "ol" : "ul";
                  return (
                    <List
                      key={`${block.kind}-${index}`}
                      className={cn(
                        "space-y-1 pl-5 marker:text-muted-foreground",
                        block.ordered ? "list-decimal" : "list-disc",
                      )}
                    >
                      {block.items.map((item, itemIndex) => (
                        <li key={`${item}-${itemIndex}`} className="pl-1">
                          {item}
                        </li>
                      ))}
                    </List>
                  );
                }
                return <p key={`${block.kind}-${index}`}>{block.text}</p>;
              })}
            </div>
          ) : null}

          {descriptiveTags.length > 0 ? (
            <div className="mt-6 flex flex-wrap gap-1.5 border-t border-border/60 pt-4">
              {descriptiveTags.map((tag) => (
                <span
                  key={tag}
                  className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border/60 bg-muted/15 px-5 py-3 md:px-7">
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          {t.refineHint}
        </p>
        <div className="flex items-center gap-1.5">
          {isAdmin ? (
            <>
              <Button variant="ghost" size="sm" type="button" onClick={onEdit}>
                <PencilIcon />
                {t.edit}
              </Button>
              <Button
                variant="ghost"
                size="icon-sm"
                type="button"
                onClick={onDelete}
                disabled={deleting}
                className="text-muted-foreground hover:text-destructive"
                aria-label={t.delete}
              >
                <TrashIcon />
              </Button>
            </>
          ) : null}
          <Button size="sm" type="button" onClick={onDiscuss}>
            <ChatBubbleSmallIcon />
            {t.refineInChat}
          </Button>
        </div>
      </div>
    </div>
  );
}

// ── Icons ────────────────────────────────────────────────────────────────

function PlusIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}
function ChevronDownIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  );
}
function ChevronLeftIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  );
}
function ChevronRightIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground" aria-hidden>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  );
}
function XIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  );
}
function PencilIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
      <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
    </svg>
  );
}
function TrashIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <polyline points="3 6 5 6 21 6" />
      <path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" />
      <path d="M10 11v6" />
      <path d="M14 11v6" />
      <path d="M9 6V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2" />
    </svg>
  );
}
function ChatBubbleSmallIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}


/**
 * Paste-in voice-import dialog body — textarea + platform scope chips.
 * Stateful so the chips highlight; the values flow OUT through the two
 * callbacks into the caller's closure (the confirm-dialog `content`
 * contract: the caller owns the values, the dialog hosts the node).
 * "All platforms" = null platform = general brand voice, no tagging note.
 */
/**
 * Dialog body for the X handle import (feed-import-account.md D8): one
 * handle input + the same platform-scope chips as the paste-in dialog.
 */
function ImportHandleContent({
  initialPlatform = null,
  onHandleChange,
  onPlatformChange,
}: {
  /** Pre-selected scope — the Voice page's active platform (D12). */
  initialPlatform?: FeedPlatform | null;
  onHandleChange: (v: string) => void;
  onPlatformChange: (p: FeedPlatform | null) => void;
}) {
  const feedT = useT().feedPage;
  const t = feedT.voice;
  const [platform, setPlatform] = useState<FeedPlatform | null>(initialPlatform);
  const pick = (p: FeedPlatform | null) => {
    setPlatform(p);
    onPlatformChange(p);
  };
  const chip = (active: boolean) =>
    "press h-7 rounded-full border px-3 text-xs font-medium transition-colors " +
    (active
      ? "border-transparent bg-foreground text-background"
      : "border-border bg-background/60 text-muted-foreground hover:bg-accent");
  return (
    <div className="space-y-3">
      <input
        type="text"
        autoFocus
        placeholder={t.importHandlePlaceholder}
        onChange={(e) => onHandleChange(e.target.value)}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none"
      />
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">{t.importSamplesPlatformLabel}</div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => pick(null)} aria-pressed={platform === null} className={chip(platform === null)}>
            {t.importSamplesAllPlatforms}
          </button>
          {FEED_PLATFORMS.map((p) => (
            <button key={p} type="button" onClick={() => pick(p)} aria-pressed={platform === p} className={chip(platform === p)}>
              {feedT.platformLabels[p]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function ImportSamplesContent({
  initialPlatform = null,
  onSamplesChange,
  onPlatformChange,
}: {
  /** Pre-selected scope — the Voice page's active platform (D12). */
  initialPlatform?: FeedPlatform | null;
  onSamplesChange: (v: string) => void;
  onPlatformChange: (p: FeedPlatform | null) => void;
}) {
  const feedT = useT().feedPage;
  const t = feedT.voice;
  const [platform, setPlatform] = useState<FeedPlatform | null>(initialPlatform);
  const pick = (p: FeedPlatform | null) => {
    setPlatform(p);
    onPlatformChange(p);
  };
  const chip = (active: boolean) =>
    "press h-7 rounded-full border px-3 text-xs font-medium transition-colors " +
    (active
      ? "border-transparent bg-foreground text-background"
      : "border-border bg-background/60 text-muted-foreground hover:bg-accent");
  return (
    <div className="space-y-3">
      <textarea
        rows={8}
        placeholder={t.importSamplesPlaceholder}
        onChange={(e) => onSamplesChange(e.target.value)}
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none resize-y"
      />
      <div className="space-y-1">
        <div className="text-xs text-muted-foreground">{t.importSamplesPlatformLabel}</div>
        <div className="flex flex-wrap items-center gap-1.5">
          <button type="button" onClick={() => pick(null)} aria-pressed={platform === null} className={chip(platform === null)}>
            {t.importSamplesAllPlatforms}
          </button>
          {FEED_PLATFORMS.map((p) => (
            <button key={p} type="button" onClick={() => pick(p)} aria-pressed={platform === p} className={chip(platform === p)}>
              {feedT.platformLabels[p]}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
