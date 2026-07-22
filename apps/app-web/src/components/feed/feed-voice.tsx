"use client";

/**
 * Feed voice — the team voice-memories surface, ported faithfully from
 * `apps/feed-web/src/app/w/[workspaceId]/voice/page.tsx`
 * (docs/plans/feed-web-consolidation.md §7.3): the team-scope memories that
 * shape draft tone and content, with admin-gated add/edit/delete forms, a
 * per-type filter strip, and a per-card "Discuss" that seeds the floating
 * tuning chat with the rule quoted in the composer.
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
 *   - "Discuss" seeds the FEED bus (`requestFeedChatSeed`, `feed-chat-seed`).
 *   - The no-assistant state's CTA links to the feed home (`feedPath`) —
 *     feed-web's `/onboarding` route is not ported (§5 route map).
 *   - All copy via `useT().feedPage.voice`.
 *
 * [COMP:app-web/feed-voice]
 */

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
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

export function FeedVoice() {
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
    // Platform-first (feed-create-split.md D12): the import scope defaults
    // to the page's selected platform; "All platforms" stays one click away.
    let platform: FeedPlatform | null =
      voicePlatform === "all" ? null : voicePlatform;
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
  const t = feedT.voice;
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

  // Platform-first entry (feed-create-split.md D12): the page opens on one
  // platform's view (baseline + that platform's rules — exactly what draft
  // sessions inject) with "All" one chip away. The stored pick applies in an
  // effect, not the initializer, so SSR/client first paints stay identical.
  const [voicePlatform, setVoicePlatform] = useState<FeedPlatform | "all">(
    FEED_PLATFORMS[0],
  );
  const pickAppliedRef = useRef(false);
  useEffect(() => {
    if (pickAppliedRef.current) return;
    pickAppliedRef.current = true;
    setVoicePlatform(
      defaultFeedPlatform(
        team.workspaceId,
        team.profiles.map((p) => p.platform),
      ),
    );
  }, [team.workspaceId, team.profiles]);

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

  const types = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) if (it.type) set.add(it.type);
    return ["all", ...Array.from(set)];
  }, [items]);

  const filtered = useMemo(
    () => (filter === "all" ? items : items.filter((m) => m.type === filter)),
    [items, filter],
  );

  // Platform view (D12): show the baseline (no platform tag) + the selected
  // platform's scoped rules — the exact set a draft session for that
  // platform injects. Rules scoped only to other platforms live in their
  // own platform's view.
  const platformTagsOf = (m: FeedVoiceMemory) =>
    (m.tags ?? []).filter(isFeedPlatform);
  const visible = useMemo(() => {
    if (voicePlatform === "all") return filtered;
    return filtered.filter((m) => {
      const scoped = platformTagsOf(m);
      return scoped.length === 0 || scoped.includes(voicePlatform);
    });
  }, [filtered, voicePlatform]);
  const baselineRules = useMemo(
    () => visible.filter((m) => platformTagsOf(m).length === 0),
    [visible],
  );
  const scopedRules = useMemo(
    () => visible.filter((m) => platformTagsOf(m).length > 0),
    [visible],
  );

  // One rule row — shared by the flat "All" grid and the platform view's
  // two sections; the in-place edit card swaps in for the row being edited.
  const renderRule = (m: FeedVoiceMemory) =>
    editingId === m.id ? (
      <li key={m.id} className="rounded-xl border border-border bg-card p-4 space-y-4 shadow-xs xl:col-span-2">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t.editTitle}</span>
          <button
            type="button"
            onClick={() => { setEditingId(null); setEditError(null); }}
            className="text-muted-foreground hover:text-foreground"
          >
            <XIcon />
          </button>
        </div>
        <VoiceForm
          form={editForm}
          onChange={setEditForm}
          error={editError}
          busy={editBusy}
          onSubmit={submitEdit}
          onCancel={() => { setEditingId(null); setEditError(null); }}
          submitLabel={t.saveChanges}
        />
      </li>
    ) : (
      <MemoryCard
        key={m.id}
        memory={m}
        isAdmin={isAdmin}
        deleting={deletingId === m.id}
        onEdit={() => startEdit(m)}
        onDelete={() => void deleteMemory(m.id)}
        onDiscuss={() => discussMemory(m)}
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
          className="inline-flex items-center justify-center rounded-lg bg-primary px-3 h-8 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90"
        >
          {t.noVoiceCta}
        </Link>
      </div>
    );
  }

  return (
    <div className="relative h-screen overflow-hidden">
      <div className="h-full overflow-y-auto">
        {/* Memories — full width; the tuning chat lives in the floating dock. */}
        <div className="px-4 md:px-6 py-5 max-w-4xl mx-auto space-y-5">
          <header className="flex items-start justify-between gap-4">
            <div className="space-y-1.5">
              <div className="flex items-center gap-2">
                <h1 className="text-[15px] font-semibold">
                  {feedT.sections.voice}
                </h1>
                <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  {total === 1 ? t.ruleCountOne : format(t.ruleCount, { count: total })}
                </span>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed max-w-xl">
                {t.subtitle}
              </p>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {isAdmin ? (
                <button
                  type="button"
                  onClick={() => void importFromSamples()}
                  className="inline-flex items-center gap-1.5 rounded-xl border border-border px-4 h-9 text-sm font-medium hover:bg-accent transition-colors"
                >
                  {t.importSamples}
                </button>
              ) : null}
              {isAdmin && !showAdd ? (
                <button
                  type="button"
                  onClick={() => {
                    // New rules default their scope to the page's selected
                    // platform (D12); the form's chips can widen/clear it.
                    setAddForm({
                      ...DEFAULT_FORM,
                      tags: voicePlatform === "all" ? "" : voicePlatform,
                    });
                    setShowAdd(true);
                  }}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 h-8 text-[12.5px] font-medium text-primary-foreground hover:bg-primary/90 active:bg-primary/85 transition-colors press"
                >
                  <PlusIcon />
                  {t.injectRule}
                </button>
              ) : null}
            </div>
          </header>

          {/* Platform switcher (D12) — the page is entered with a platform
              selected; "All" shows every rule with its platform badges. */}
          <nav
            aria-label={t.platformSwitcherAria}
            className="flex flex-wrap items-center gap-1.5"
          >
            {FEED_PLATFORMS.map((p) => {
              const active = voicePlatform === p;
              return (
                <button
                  key={p}
                  type="button"
                  onClick={() => setVoicePlatform(p)}
                  aria-pressed={active}
                  className={
                    "press h-8 rounded-full border px-3.5 text-[13px] font-medium transition-colors " +
                    (active
                      ? "border-transparent bg-foreground text-background"
                      : "border-border bg-background/60 text-muted-foreground hover:bg-accent")
                  }
                >
                  {feedT.platformLabels[p]}
                </button>
              );
            })}
            <button
              type="button"
              onClick={() => setVoicePlatform("all")}
              aria-pressed={voicePlatform === "all"}
              className={
                "press h-8 rounded-full border px-3.5 text-[13px] font-medium transition-colors " +
                (voicePlatform === "all"
                  ? "border-transparent bg-foreground text-background"
                  : "border-border bg-background/60 text-muted-foreground hover:bg-accent")
              }
            >
              {t.filterAllPlatforms}
            </button>
          </nav>

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
            <div className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive animate-pop-in">
              {error}
            </div>
          ) : null}

          {showAdd ? (
            <div className="rounded-xl border border-border bg-card p-4 space-y-4 animate-pop-in shadow-xs">
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
            <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center space-y-2 animate-pop-in">
              <p className="text-sm font-medium">{t.emptyTitle}</p>
              <p className="text-xs text-muted-foreground max-w-sm mx-auto">
                {t.emptyBodyBefore} <strong>{t.injectRule}</strong> {t.emptyBodyAfter}
              </p>
            </div>
          ) : visible.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-card/40 p-8 text-center text-xs text-muted-foreground">
              {t.typeEmptyBefore} <strong>{typeLabel(t, filter)}</strong> {t.typeEmptyAfter}
            </div>
          ) : voicePlatform === "all" ? (
            <ul className="grid grid-cols-1 xl:grid-cols-2 gap-3 animate-stagger pb-4">
              {visible.map(renderRule)}
            </ul>
          ) : (
            // Platform view (D12): baseline first (applies everywhere), then
            // the selected platform's scoped rules — mirroring the injection
            // order draft sessions use.
            <div className="space-y-5 pb-4">
              {baselineRules.length > 0 ? (
                <section className="space-y-2">
                  <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t.baselineSection}
                  </h2>
                  <ul className="grid grid-cols-1 xl:grid-cols-2 gap-3 animate-stagger">
                    {baselineRules.map(renderRule)}
                  </ul>
                </section>
              ) : null}
              <section className="space-y-2">
                <h2 className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                  {format(t.platformSection, {
                    platform: feedT.platformLabels[voicePlatform],
                  })}
                </h2>
                {scopedRules.length > 0 ? (
                  <ul className="grid grid-cols-1 xl:grid-cols-2 gap-3 animate-stagger">
                    {scopedRules.map(renderRule)}
                  </ul>
                ) : (
                  <p className="rounded-xl border border-dashed border-border bg-card/40 p-5 text-center text-xs text-muted-foreground">
                    {format(t.platformSectionEmpty, {
                      platform: feedT.platformLabels[voicePlatform],
                    })}
                  </p>
                )}
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
          className="rounded-xl bg-primary text-primary-foreground px-4 h-9 text-sm font-medium hover:bg-primary/90 disabled:opacity-50"
        >
          {busy ? t.saving : submitLabel}
        </button>
      </div>
    </div>
  );
}

// ── Memory card ──────────────────────────────────────────────────────────

function MemoryCard({
  memory: m,
  isAdmin,
  deleting,
  onEdit,
  onDelete,
  onDiscuss,
}: {
  memory: FeedVoiceMemory;
  isAdmin: boolean;
  deleting: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onDiscuss: () => void;
}) {
  const feedT = useT().feedPage;
  const t = feedT.voice;
  const platformLabels = feedT.platformLabels;
  return (
    <li className="group relative flex h-full flex-col rounded-xl border border-border/60 bg-card p-4 space-y-2 shadow-xs transition-all hover:shadow-md">

      <div className="relative flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground rounded-full bg-muted/60 px-2 py-0.5">
            {typeLabel(t, m.type)}
          </span>
          {m.sensitivity && m.sensitivity !== "internal" ? (
            <span className="rounded-full border border-border px-2 py-0.5 text-[10px] text-muted-foreground">
              {sensitivityLabel(t, m.sensitivity)}
            </span>
          ) : null}
          {/* Platform scope — a platform tag narrows the rule to that
              platform's drafts (per-platform voice); no badge = general. */}
          {(m.tags ?? []).filter(isFeedPlatform).map((p) => (
            <span
              key={p}
              className="rounded-full border border-border px-2 py-0.5 text-[10px] font-medium text-muted-foreground"
            >
              {platformLabels[p]}
            </span>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <span className="text-[11px] text-muted-foreground mr-1 tabular-nums">
            {new Date(m.updatedAt).toLocaleDateString()}
          </span>
          <div className="flex items-center gap-0.5 opacity-0 -translate-x-1 group-hover:opacity-100 group-hover:translate-x-0 transition-all duration-200">
            <button
              type="button"
              onClick={onDiscuss}
              className="inline-flex items-center gap-1 rounded-lg px-2 h-7 text-[11px] font-medium text-primary bg-primary/10 hover:bg-primary/15 transition-colors"
              aria-label={t.discussAria}
              title={t.discussAria}
            >
              <ChatBubbleSmallIcon />
              <span>{t.discuss}</span>
            </button>
            {isAdmin ? (
              <>
                <button
                  type="button"
                  onClick={onEdit}
                  className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  aria-label={t.edit}
                >
                  <PencilIcon />
                </button>
                <button
                  type="button"
                  onClick={onDelete}
                  disabled={deleting}
                  className="inline-flex items-center justify-center w-7 h-7 rounded-lg text-muted-foreground hover:text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-40"
                  aria-label={t.delete}
                >
                  <TrashIcon />
                </button>
              </>
            ) : null}
          </div>
        </div>
      </div>
      {m.summary ? (
        <div className="relative text-sm font-medium leading-snug">{m.summary}</div>
      ) : null}
      {m.detail && m.detail !== m.summary ? (
        <div className="relative text-sm text-muted-foreground whitespace-pre-wrap leading-relaxed">{m.detail}</div>
      ) : null}
      {m.tags && m.tags.length > 0 ? (
        <div className="relative flex flex-wrap gap-1.5 pt-1">
          {m.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-muted-foreground"
            >
              {tag}
            </span>
          ))}
        </div>
      ) : null}
    </li>
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
        className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:border-primary/50 resize-y"
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
