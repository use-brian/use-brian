"use client";

/**
 * Skill editor — `/w/[workspaceId]/brain/skills/[skillRowId]` (app-web).
 *
 * The full-page editing surface for one workspace skill
 * (docs/plans/brain-skill-management-ux.md §3.3), redesigned as a
 * **document + properties rail** so editing a skill feels like editing a
 * Notion page (the app's identity), not filling a form:
 *
 *   Topbar — the shared `BrainTopbar` (ONE bar, never two stacked): the
 *     breadcrumb tail carries the skill name + status badge; the right
 *     cluster carries the "Unsaved" dot and THE one primary Save button.
 *     Save applies D2 (edit = confirm) SERVER-side: a human save of
 *     name/content stamps the verifier, lifts confidence, and activates a
 *     Suggested skill — so the button reads "Save & activate" while
 *     Suggested with the consequence in its tooltip (plan §10). Disabled
 *     until `buildSkillPatch` has a diff.
 *   Main column (the document) — borderless title-as-H1 (`.doc-page-title`,
 *     same face as the doc surface), borderless muted description subtitle,
 *     the when-to-use routing copy as a compact callout block, then the
 *     markdown body as a borderless auto-growing textarea.
 *   Right rail (the properties) — three compact groups, ACTIONS FIRST (the
 *     trust decision is the page's primary job): Actions (full-width primary
 *     Confirm-without-editing with a consequence hint while Suggested;
 *     full-width destructive Delete behind `confirmDialog`), About (status,
 *     source, confidence bar, re-derivations, verified, last used, the CL-8
 *     counters as one usage line, connector chips), and Access (sensitivity
 *     select with inherited/manual hint + apply-on-toggle assistant
 *     switches over GET/PUT `/api/skills/:id/access`, degrading to a note
 *     on 501/404; the allowlist is the single offering scope — suggested
 *     skills arrive with the proposer pre-enabled, mig 264).
 *
 * The skill is resolved through the workspace list (`getWorkspaceSkill`) —
 * there is no single-row GET and the list already carries the projection.
 * Every mutation fires `requestBrainRefresh` so the library/grouped view
 * behind the back link never goes stale.
 *
 * [COMP:app-web/brain-skill-editor]
 */

import { use, useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { cn } from "@/lib/utils";
import { useT, useLocale, format } from "@/lib/i18n/client";
import { useWorkspaces } from "@/contexts/workspace-context";
import {
  confirmSkill,
  deleteSkill,
  getSkillAccess,
  getWorkspaceSkill,
  setSkillAccess,
  updateSkill,
  type SkillAccessAssistant,
  type SkillSensitivity,
  type WorkspaceSkillSummary,
} from "@/lib/api/skills";
import { buildSkillPatch, skillStatus } from "@/lib/skills-view";
import { SKILL_BODY_MAX_CHARS } from "@/lib/skill-markdown";
import { requestBrainRefresh } from "@/lib/brain-events";
import { chatDockSuppression } from "@/lib/chat-dock-suppress";
import { SkillDocument } from "@/components/brain/skill-document";
import { SkillIterationChat } from "@/components/brain/skill-iteration-chat";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { BrainTopbar } from "@/components/brain/brain-topbar";
import { Switch } from "@/components/ui/switch";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function SkillEditorInner({ skillRowId }: { skillRowId: string }) {
  const t = useT();
  const { activeId } = useWorkspaces();
  const copy = t.brainPage.skillEditor;
  const backHref = activeId ? `/w/${activeId}/brain?view=skills` : "/";

  // The editor embeds its own iteration chat (rail Chat tab) — hold the
  // floating-dock suppression for the whole route so two docks never
  // coexist (chat-dock-suppress.ts).
  useEffect(() => chatDockSuppression.suppress(), []);

  // undefined = loading, null = not found, value = loaded.
  const [skill, setSkill] = useState<WorkspaceSkillSummary | null | undefined>(
    undefined,
  );

  const reload = useCallback(async () => {
    if (!activeId) return;
    const next = await getWorkspaceSkill(activeId, skillRowId);
    setSkill(next);
  }, [activeId, skillRowId]);

  useEffect(() => {
    setSkill(undefined);
    void reload();
  }, [reload]);

  if (skill === undefined) {
    return (
      <>
        <BrainTopbar
          workspaceId={activeId ?? ""}
          tail={<span className="text-muted-foreground">…</span>}
        />
        <div className="max-w-3xl mx-auto w-full px-6 py-10 text-sm text-muted-foreground">
          …
        </div>
      </>
    );
  }

  if (skill === null) {
    return (
      <>
        <BrainTopbar
          workspaceId={activeId ?? ""}
          tail={
            <span className="text-muted-foreground">{copy.notFoundTitle}</span>
          }
        />
        <div className="max-w-3xl mx-auto w-full px-6 py-20 text-center flex flex-col gap-3">
          <div className="font-medium">{copy.notFoundTitle}</div>
          <p className="text-sm text-muted-foreground">{copy.notFoundBody}</p>
          <BackButton
            href={backHref}
            label={t.brainPage.skillsLibrary.back}
            className="mx-auto"
          />
        </div>
      </>
    );
  }

  return (
    <SkillEditor
      workspaceId={activeId!}
      skill={skill}
      backHref={backHref}
      onSaved={() => void reload()}
    />
  );
}

// ── The loaded editor — Brain topbar + document column + properties rail ──

function SkillEditor({
  workspaceId,
  skill,
  backHref,
  onSaved,
}: {
  workspaceId: string;
  skill: WorkspaceSkillSummary;
  backHref: string;
  onSaved: () => void;
}) {
  const t = useT();
  const router = useRouter();
  const skillsCopy = t.brainPage.skills;
  const copy = t.brainPage.skillEditor;

  const status = skillStatus(skill);
  const suggested = status === "suggested";

  // The document drafts. Hoisted here (not in a child section) so the sticky
  // header's Save button and the unsaved dot read the same diff.
  const [name, setName] = useState(skill.name);
  const [description, setDescription] = useState(skill.description);
  const [whenToUse, setWhenToUse] = useState(skill.whenToUse ?? "");
  const [content, setContent] = useState(skill.content);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Rail segment: the properties (About) or the iteration chat. The chat
  // revises the SAME drafts the document edits — Save stays the one commit
  // (PATCH + D2 trust stamp), so an AI revision is always human-reviewed.
  const [railTab, setRailTab] = useState<"about" | "chat">("about");

  // Resync drafts when the loaded row changes (a reload after save/confirm).
  useEffect(() => {
    setName(skill.name);
    setDescription(skill.description);
    setWhenToUse(skill.whenToUse ?? "");
    setContent(skill.content);
    setError(null);
  }, [skill]);

  const patch = buildSkillPatch(skill, { name, description, whenToUse, content });
  const dirty = Object.keys(patch).length > 0;

  async function save() {
    if (!name.trim()) {
      setError(skillsCopy.nameRequired);
      return;
    }
    if (!content.trim()) {
      setError(skillsCopy.contentRequired);
      return;
    }
    // The API caps the body at 5000 chars — fail before the wire.
    if (content.length > SKILL_BODY_MAX_CHARS) {
      setError(format(copy.overLimit, { max: SKILL_BODY_MAX_CHARS }));
      return;
    }
    setBusy(true);
    setError(null);
    const result = await updateSkill(skill.rowId, patch);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    requestBrainRefresh(workspaceId);
    onSaved();
  }

  return (
    <>
      {/* The ONE bar — the Brain topbar carries the editor's breadcrumb tail
          (name + status badge) and the save cluster; never a second stacked
          header. */}
      <BrainTopbar
        workspaceId={workspaceId}
        tail={
          <>
            <span className="min-w-0 truncate">{skill.name}</span>
            <StatusBadge status={status} />
          </>
        }
        right={
          <>
            {dirty && (
              <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span
                  aria-hidden
                  className="inline-block h-1.5 w-1.5 rounded-full bg-amber-500"
                />
                {copy.unsaved}
              </span>
            )}
            {/* D2 — while Suggested, a save also activates; the label says so
                and the tooltip carries the full consequence. */}
            <Button
              size="sm"
              disabled={busy || !dirty}
              onClick={() => void save()}
              title={suggested ? copy.saveActivateHint : undefined}
            >
              {suggested ? copy.saveActivate : copy.save}
            </Button>
          </>
        }
      />

      <div className="mx-auto w-full max-w-6xl px-6 py-8 lg:grid lg:grid-cols-[minmax(0,1fr)_300px] lg:gap-10">
        {/* ── Main column — the skill as a document ─────────────────── */}
        <div className="min-w-0 flex flex-col">
          {error && (
            <p className="mb-4 text-xs text-red-500" role="alert">
              {error}
            </p>
          )}

          <SkillDocument
            name={name}
            onNameChange={setName}
            description={description}
            onDescriptionChange={setDescription}
            whenToUse={whenToUse}
            onWhenToUseChange={setWhenToUse}
            content={content}
            onContentChange={setContent}
          />
        </div>

        {/* ── Right rail — a two-segment pill switches it between the
            properties (About: Suggested decision first, then About + Access
            soft cards, destructive Delete last) and the iteration CHAT,
            which revises the same document drafts (Save stays the one
            commit). ─────────────────────────────────────────────────────── */}
        <aside className="mt-10 flex flex-col gap-4 text-sm lg:mt-0">
          <div
            role="tablist"
            aria-label={copy.railTabsLabel}
            className="flex shrink-0 rounded-lg bg-muted/40 p-0.5"
          >
            {(["about", "chat"] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                role="tab"
                aria-selected={railTab === tab}
                onClick={() => setRailTab(tab)}
                className={cn(
                  "flex-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
                  railTab === tab
                    ? "bg-background text-foreground shadow-xs"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                {tab === "about" ? copy.railAboutTab : copy.railChatTab}
              </button>
            ))}
          </div>

          {railTab === "about" ? (
            <>
              {suggested && (
                <SuggestedCard
                  workspaceId={workspaceId}
                  skill={skill}
                  onConfirmed={onSaved}
                />
              )}
              <AboutGroup skill={skill} status={status} />
              <AccessGroup
                workspaceId={workspaceId}
                skill={skill}
                onChanged={onSaved}
              />
              <DangerZone
                workspaceId={workspaceId}
                skill={skill}
                onDeleted={() => router.push(backHref)}
              />
            </>
          ) : (
            // Sticky under the brain topbar (h-11) on lg so the chat rides
            // along while the document scrolls. Sensitivity is governance
            // (the About tab's Access group) — an agent revision never
            // changes it here, only the four document fields.
            <div className="lg:sticky lg:top-[60px]">
              <SkillIterationChat
                workspaceId={workspaceId}
                getDraft={() => ({
                  name,
                  description,
                  whenToUse,
                  content,
                  sensitivity: skill.sensitivity,
                })}
                onDraft={(draft) => {
                  setName(draft.name);
                  setDescription(draft.description);
                  setWhenToUse(draft.whenToUse);
                  setContent(draft.content);
                }}
                className="h-[60vh] lg:h-[calc(100vh-7rem)]"
              />
            </div>
          )}
        </aside>
      </div>
    </>
  );
}

function StatusBadge({
  status,
}: {
  status: ReturnType<typeof skillStatus>;
}) {
  const t = useT();
  const skillsCopy = t.brainPage.skills;
  return (
    <span
      className={cn(
        "shrink-0 px-2 py-0.5 rounded text-[11px] uppercase tracking-wide font-medium border",
        status === "active" &&
          "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400 border-emerald-500/20",
        status === "suggested" &&
          "bg-amber-500/10 text-amber-700 dark:text-amber-400 border-amber-500/20",
        status === "stale" && "bg-muted text-muted-foreground border-border",
      )}
    >
      {status === "active"
        ? skillsCopy.statusActive
        : status === "suggested"
          ? skillsCopy.statusSuggested
          : skillsCopy.statusStale}
    </span>
  );
}

/** One rail card — soft chrome with the tiny uppercase header INSIDE, so
 *  each group reads as a clearly bounded segment instead of running into
 *  its neighbours. */
function RailCard({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    // Borderless segmentation (user-locked): the tinted wash IS the card
    // boundary — same family as the document column's when-to-use callout.
    <section className="rounded-lg bg-muted/40 px-3 py-2.5">
      <h3 className="pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/60">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** One compact label/value property row — uniform `py-1.5` rhythm; the
 *  parent dl draws the hairlines between rows (`divide-y`). */
function PropRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <dt className="shrink-0 text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-right text-xs">{children}</dd>
    </div>
  );
}

// ── About — metadata + governance, merged into one glance ─────────────

function AboutGroup({
  skill,
  status,
}: {
  skill: WorkspaceSkillSummary;
  status: ReturnType<typeof skillStatus>;
}) {
  const t = useT();
  const locale = useLocale();
  const skillsCopy = t.brainPage.skills;
  const copy = t.brainPage.skillEditor;

  const intlLocale = locale === "zh" ? "zh-Hant" : locale;
  const dateFmt = (iso: string) =>
    new Date(iso).toLocaleDateString(intlLocale, { dateStyle: "medium" });
  const pct = Math.round(skill.confidence * 100);

  return (
    <RailCard title={copy.aboutHeading}>
      {/* Identity chips lead — status + source side-by-side, then the
          metric rows in a uniform hairline rhythm. */}
      <div className="flex flex-wrap items-center gap-1.5 pb-1.5">
        <StatusBadge status={status} />
        <span className="inline-block rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          {skillsCopy.inductionSource[skill.inductionSource]}
        </span>
      </div>
      <dl className="divide-y divide-border/40">
        <PropRow label={skillsCopy.confidenceLabel}>
          <span className="flex w-28 items-center gap-2">
            <span className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-muted">
              <span
                aria-hidden
                className="block h-full rounded-full bg-emerald-500"
                style={{ width: `${pct}%` }}
              />
            </span>
            <span className="shrink-0 tabular-nums text-muted-foreground">
              {pct}%
            </span>
          </span>
        </PropRow>
        <PropRow label={copy.rederivations}>
          <span className="tabular-nums">{skill.rederivationCount}</span>
        </PropRow>
        <PropRow label={copy.verifiedAt}>
          {skill.verifiedAt ? dateFmt(skill.verifiedAt) : copy.notVerified}
        </PropRow>
        <PropRow label={copy.lastUsedLabel}>
          {skill.lastInvokedAt
            ? dateFmt(skill.lastInvokedAt)
            : t.brainPage.skillsLibrary.neverUsed}
        </PropRow>
        {/* CL-8 counters as one line — "7 runs · 6 ok · 1 corrected". */}
        <PropRow label={copy.usageLabel}>
          <span className="tabular-nums text-muted-foreground">
            {format(copy.usageSummary, {
              runs: skill.invocations,
              ok: skill.succeeded,
              corrected: skill.userCorrectedAfter,
            })}
          </span>
        </PropRow>
        {skill.requiresConnectors.length > 0 && (
          <div className="flex flex-col gap-1.5 py-1.5">
            <dt className="text-xs text-muted-foreground">
              {copy.connectorsLabel}
            </dt>
            <dd className="flex flex-wrap gap-1">
              {skill.requiresConnectors.map((c) => (
                <span
                  key={c}
                  className="rounded border border-border bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                >
                  {c}
                </span>
              ))}
            </dd>
          </div>
        )}
      </dl>
    </RailCard>
  );
}

// ── Access — sensitivity override + apply-on-toggle assistant matrix ──

function AccessGroup({
  workspaceId,
  skill,
  onChanged,
}: {
  workspaceId: string;
  skill: WorkspaceSkillSummary;
  onChanged: () => void;
}) {
  const t = useT();
  const skillsCopy = t.brainPage.skills;
  const copy = t.brainPage.skillEditor;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Assistant matrix. undefined = loading, null = unavailable (501/404).
  const [assistants, setAssistants] = useState<
    SkillAccessAssistant[] | null | undefined
  >(undefined);
  // One PUT in flight at a time — toggles disable while it lands so racing
  // writes can't ship stale sets.
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setAssistants(undefined);
    void getSkillAccess(skill.rowId).then((result) => {
      if (cancelled) return;
      setAssistants(result.ok ? result.assistants : null);
    });
    return () => {
      cancelled = true;
    };
  }, [skill.rowId]);

  async function changeSensitivity(next: SkillSensitivity) {
    if (next === skill.sensitivity) return;
    setBusy(true);
    setError(null);
    const result = await updateSkill(skill.rowId, { sensitivity: next });
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    requestBrainRefresh(workspaceId);
    onChanged();
  }

  /** Apply-on-toggle: flip optimistically, PUT the new set, revert + show
   *  the error if it fails. No separate save button — the switch IS the
   *  action. */
  async function toggleAssistant(id: string, checked: boolean) {
    if (assistants == null) return;
    const prev = assistants;
    const next = prev.map((a) => (a.id === id ? { ...a, enabled: checked } : a));
    setAssistants(next);
    setSaving(true);
    setError(null);
    const result = await setSkillAccess(
      skill.rowId,
      next.filter((a) => a.enabled).map((a) => a.id),
    );
    setSaving(false);
    if (!result.ok) {
      setAssistants(prev);
      setError(result.error);
      return;
    }
    setAssistants(result.assistants);
    requestBrainRefresh(workspaceId);
  }

  return (
    <RailCard title={copy.accessHeading}>
      <div className="flex flex-col gap-1.5 pb-3">
        <label
          className="text-xs text-muted-foreground"
          htmlFor="skill-sensitivity"
        >
          {skillsCopy.sensitivityLabel}
        </label>
        <Select
          value={skill.sensitivity}
          onValueChange={(v) => {
            if (v) void changeSensitivity(v as SkillSensitivity);
          }}
          disabled={busy}
          items={{
            public: skillsCopy.sensitivity.public,
            internal: skillsCopy.sensitivity.internal,
            confidential: skillsCopy.sensitivity.confidential,
          }}
        >
          <SelectTrigger id="skill-sensitivity" size="sm" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent alignItemWithTrigger={false}>
            <SelectItem value="public">
              {skillsCopy.sensitivity.public}
            </SelectItem>
            <SelectItem value="internal">
              {skillsCopy.sensitivity.internal}
            </SelectItem>
            <SelectItem value="confidential">
              {skillsCopy.sensitivity.confidential}
            </SelectItem>
          </SelectContent>
        </Select>
        {/* Inherited (from how the skill was learned) vs manually set —
            `sensitivity_overridden` flips on the first human change. */}
        <span className="text-[11px] text-muted-foreground/80">
          {skill.sensitivityOverridden
            ? copy.sensitivityManual
            : copy.sensitivityInherited}
        </span>
      </div>

      {/* Inner hairline — the sensitivity and assistant clusters are two
          decisions; the boundary keeps them from reading as one blob. */}
      <div className="flex flex-col gap-1.5 border-t border-border/40 pt-3">
        <span className="text-xs text-muted-foreground">
          {copy.assistantsLabel}
        </span>
        <span className="text-[11px] text-muted-foreground/70">
          {copy.assistantsHint}
        </span>

        {assistants === undefined ? (
          <p className="text-xs text-muted-foreground">…</p>
        ) : assistants === null ? (
          <p className="text-xs text-muted-foreground">
            {copy.accessUnavailable}
          </p>
        ) : assistants.length === 0 ? (
          <p className="text-xs text-muted-foreground">{copy.noAssistants}</p>
        ) : (
          <ul className="flex flex-col">
            {assistants.map((assistant) => (
              <li
                key={assistant.id}
                className="flex items-center justify-between gap-3 rounded-md px-1.5 py-1.5 hover:bg-muted/50"
              >
                <span className="min-w-0 flex-1 truncate text-sm">
                  {assistant.name}
                </span>
                <Switch
                  checked={assistant.enabled}
                  onCheckedChange={(checked) =>
                    void toggleAssistant(assistant.id, checked)
                  }
                  disabled={saving}
                  aria-label={assistant.name}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
    </RailCard>
  );
}

// ── Suggested-state card — the constructive decision leads the rail ────

/** Amber soft card shown only while the skill is Suggested: a one-line
 *  state explainer + the confirm-without-editing action. Active/Stale
 *  skills render nothing here. */
function SuggestedCard({
  workspaceId,
  skill,
  onConfirmed,
}: {
  workspaceId: string;
  skill: WorkspaceSkillSummary;
  onConfirmed: () => void;
}) {
  const t = useT();
  const copy = t.brainPage.skillEditor;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleConfirm() {
    setBusy(true);
    setError(null);
    const result = await confirmSkill(workspaceId, skill.rowId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    requestBrainRefresh(workspaceId);
    onConfirmed();
  }

  return (
    <section className="flex flex-col gap-2.5 rounded-lg bg-amber-500/10 p-3">
      <p className="text-[11px] leading-snug text-amber-700 dark:text-amber-400">
        {copy.suggestedNote}
      </p>
      {/* Solid (user-locked): the rail's one constructive action carries real
          weight. Emerald = the Active state it produces; not primary blue. */}
      <Button
        size="sm"
        disabled={busy}
        onClick={() => void handleConfirm()}
        className="w-full bg-emerald-600 text-white shadow-sm hover:bg-emerald-700 active:bg-emerald-700/90 dark:bg-emerald-600 dark:hover:bg-emerald-500"
      >
        {copy.confirmWithoutEditing}
      </Button>
      {error && (
        <p className="text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

// ── Danger zone — last, never a card: hairline + quiet red ghost ──────

function DangerZone({
  workspaceId,
  skill,
  onDeleted,
}: {
  workspaceId: string;
  skill: WorkspaceSkillSummary;
  onDeleted: () => void;
}) {
  const t = useT();
  const skillsCopy = t.brainPage.skills;
  const review = t.memoriesReview;

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleDelete() {
    const ok = await confirmDialog({
      title: skillsCopy.deleteTitle,
      description: skillsCopy.deleteBody,
      confirmLabel: skillsCopy.deleteConfirm,
      cancelLabel: review.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    setBusy(true);
    setError(null);
    const result = await deleteSkill(skill.rowId);
    setBusy(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    requestBrainRefresh(workspaceId);
    onDeleted();
  }

  return (
    <div className="border-t border-border/60 pt-3">
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={() => void handleDelete()}
        className="w-full text-red-500 hover:bg-red-500/10 hover:text-red-600 dark:hover:text-red-400"
      >
        {review.delete}
      </Button>
      {error && (
        <p className="mt-2 text-xs text-red-500" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

export default function BrainSkillEditorPage({
  params,
}: {
  params: Promise<{ skillRowId: string }>;
}) {
  const { skillRowId } = use(params);
  return (
    <div className="h-full w-full overflow-y-auto">
      <SkillEditorInner skillRowId={skillRowId} />
    </div>
  );
}
