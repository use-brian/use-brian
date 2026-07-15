"use client";

/**
 * Skill creator — the agent-backed "+ New skill" flow AND the Skills
 * section's md+ LANDING (docs/plans/brain-skill-management-ux.md §3.2,
 * D3 + D4, as amended for conversational iteration).
 *
 * Two render modes, switched by the optional `onBack`:
 *   - LANDING (no `onBack`) — what the Brain page renders for the Skills
 *     section on md+. The intent stage is a hero: centred display-font
 *     heading + a composer CARD.
 *   - TAKEOVER (`onBack` set) — the explicit "+ New skill" open on `<md`;
 *     a BackButton leads the pane.
 *
 * Two stages (the old structured `questions` form and the one-shot
 * "Regenerate with feedback" box are RETIRED — refinement is a chat now):
 *
 *   intent — the hero composer (centred icon badge + display-font heading
 *            in BOTH modes): ONE box + attach, the chat-composer grammar.
 *            Describe the skill or paste material to distill straight into
 *            the textarea; documents attach via paperclip/drag-drop and ride
 *            the auto-sent first turn (the old separate paste-reference
 *            textarea was duplicate UX and is gone, along with the wire
 *            `reference` field). Templates have ONE surface too (§11d): a
 *            labelled divider, rich one-tap cards for the first few entries,
 *            and a searchable browse-all combobox when the catalog holds
 *            more — there is no footer dropdown.
 *   doc    — the skill as a FULL DOCUMENT (the editor page's `SkillDocument`
 *            column: title / description / when-to-use callout / md body)
 *            with the `SkillIterationChat` rail beside it. Reached three
 *            ways:
 *              · template pick → `GET /api/skills/catalog/:slug` loads the
 *                ENTIRE template verbatim (no model call); any typed intent
 *                auto-sends as the first adaptation turn
 *              · intent submit → empty document + the intent auto-sends as
 *                the first chat turn (a clarify round comes back as a chat
 *                reply; the draft lands in the document)
 *              · "Write manually" → empty document, chat optional
 *            The chat composer carries the full chat UX — model tier picker,
 *            deep-research toggle, file attachments. While the doc stage is
 *            mounted it holds the floating-dock suppression (one dock per
 *            surface).
 *
 * Save → `createSkill` with `workspaceId` + `sensitivity` (action-row
 * select) + `enabledAssistantIds: 'all'` (D4 — authored skills are born
 * offered to every assistant); the parent navigates to the editor for the
 * new row. Draft-endpoint failures degrade: 501/503/404/500 surface the
 * sticky "drafting unavailable" notice and the document stays hand-editable
 * (manual authoring IS the doc stage).
 *
 * [COMP:app-web/brain-skill-creator]
 */

import { useEffect, useRef, useState } from "react";
import { LayoutTemplate, Paperclip, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import {
  createSkill,
  getSkillTemplate,
  listSkillCatalog,
  type SkillCatalogEntry,
  type SkillImportSupportFile,
  type SkillDraft,
  type SkillSensitivity,
  type WorkspaceSkillSummary,
} from "@/lib/api/skills";
import { SKILL_BODY_MAX_CHARS } from "@/lib/skill-markdown";
import { chatDockSuppression } from "@/lib/chat-dock-suppress";
import { useFileAttachments } from "@/lib/use-file-attachments";
import { useFileDrop } from "@/lib/use-file-drop";
import {
  AttachmentChips,
  FileDropOverlay,
} from "@/components/doc/attachment-chips";
import { SkillDocument } from "@/components/brain/skill-document";
import { SkillIterationChat } from "@/components/brain/skill-iteration-chat";
import { Button } from "@/components/ui/button";
import { BackButton } from "@/components/ui/back-button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { SearchableSelect } from "@/components/ui/searchable-select";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

/** A parsed import handed in by the Import dialog: the creator opens straight
 *  in the doc stage pre-filled with the draft (the `pickTemplate` seam), and
 *  Save carries the support files + provenance through `createSkill`. Spec:
 *  skill-system.md → "Importing skills (GitHub / URL)" → "UI". */
export type SkillImportPrefill = {
  draft: {
    name: string;
    description: string;
    whenToUse?: string;
    content: string;
  };
  supportFiles: SkillImportSupportFile[];
  importSource: Record<string, unknown>;
};

type Props = {
  workspaceId: string;
  /** Leave the creator without saving (back to the `<md` flat list). Omitted
   *  when the creator IS the Skills landing — there is nothing behind it. */
  onBack?: () => void;
  /** Fired with the created projection; the parent routes to the editor. */
  onCreated: (skill: WorkspaceSkillSummary) => void;
  /** Open pre-filled with an imported draft, straight in the doc stage. */
  initialImport?: SkillImportPrefill;
};

type Stage = "intent" | "doc";

export function SkillCreator({ workspaceId, onBack, onCreated, initialImport }: Props) {
  const t = useT();
  const skillsCopy = t.brainPage.skills;
  const copy = t.brainPage.skillCreator;
  const chatCopy = t.brainPage.skillChat;

  const [stage, setStage] = useState<Stage>(initialImport ? "doc" : "intent");

  // Intent-stage inputs. `templateSlug` keeps travelling with every chat
  // turn (the endpoint is stateless), so it lives here, not in the chat.
  // Reference material has NO separate box (it read as duplicate UX next to
  // the prompt): pasted text goes straight into the textarea, documents go
  // through the same attachment affordance the chat composer has.
  const [intent, setIntent] = useState("");
  const [templateSlug, setTemplateSlug] = useState("");
  const [templateName, setTemplateName] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<SkillCatalogEntry[]>([]);
  const intentAttachments = useFileAttachments();
  const { isDragging, dropProps } = useFileDrop(intentAttachments.upload);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // The document (the doc stage's live draft). An imported draft seeds it
  // directly (the same fields pickTemplate sets), entering on the doc stage.
  const [name, setName] = useState(initialImport?.draft.name ?? "");
  const [description, setDescription] = useState(initialImport?.draft.description ?? "");
  const [whenToUse, setWhenToUse] = useState(initialImport?.draft.whenToUse ?? "");
  const [content, setContent] = useState(initialImport?.draft.content ?? "");
  const [sensitivity, setSensitivity] = useState<SkillSensitivity>("internal");
  /** The first chat turn the doc stage auto-sends (the intent path)... */
  const [firstMessage, setFirstMessage] = useState<string | null>(null);
  /** ...and the intent-composer attachments that ride along with it. */
  const [firstFileIds, setFirstFileIds] = useState<string[]>([]);

  const [busy, setBusy] = useState(false);
  const [chatBusy, setChatBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Sticky notice shown above the document after a draft-engine failure. */
  const [notice, setNotice] = useState<string | null>(null);

  // Template picker source — `[]` (fetch failed or empty catalog) hides the
  // picker entirely; the creator must not depend on it.
  useEffect(() => {
    let cancelled = false;
    void listSkillCatalog().then((entries) => {
      if (!cancelled) setCatalog(entries);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // The doc stage embeds its own chat — hold the floating-dock suppression
  // while it's on screen (one dock per surface; chat-dock-suppress.ts).
  useEffect(() => {
    if (stage !== "doc") return;
    return chatDockSuppression.suppress();
  }, [stage]);

  /** Template pick → load the ENTIRE template into the document, verbatim,
   *  no model call. Any typed intent auto-sends as the first adaptation
   *  turn once the doc stage mounts. */
  async function pickTemplate(slug: string) {
    if (!slug) {
      setTemplateSlug("");
      setTemplateName(null);
      return;
    }
    setBusy(true);
    setError(null);
    const template = await getSkillTemplate(slug);
    setBusy(false);
    if (!template) {
      setError(copy.templateLoadFailed);
      return;
    }
    setTemplateSlug(slug);
    setTemplateName(template.name);
    setName(template.name);
    setDescription(template.description);
    setWhenToUse(template.whenToUse ?? "");
    setContent(template.content);
    // Typed intent (and its staged attachments) auto-send as the first
    // adaptation turn; files can't travel without a message.
    const trimmed = intent.trim();
    setFirstMessage(trimmed || null);
    setFirstFileIds(trimmed ? intentAttachments.fileIds() : []);
    intentAttachments.clear();
    setStage("doc");
  }

  /** Intent submit → straight into the doc stage with the intent (plus any
   *  staged attachments) as the first chat turn (the draft, or a clarify
   *  reply, lands in the chat). */
  function submitIntent() {
    if (!intent.trim()) {
      setError(copy.intentRequired);
      return;
    }
    if (intentAttachments.uploading) return;
    setError(null);
    setFirstMessage(intent.trim());
    setFirstFileIds(intentAttachments.fileIds());
    intentAttachments.clear();
    setStage("doc");
  }

  function startManual() {
    setError(null);
    setFirstMessage(null);
    setStage("doc");
  }

  /** Leave the doc stage. Discards the working draft (confirmed when the
   *  document has content), then returns to the intent hero — or exits the
   *  takeover entirely when nothing was drafted yet. */
  async function backFromDoc() {
    const hasWork =
      name.trim() || description.trim() || whenToUse.trim() || content.trim();
    if (hasWork) {
      const confirmed = await confirmDialog({
        title: copy.discardTitle,
        description: copy.discardBody,
        confirmLabel: copy.discardConfirm,
        variant: "destructive",
      });
      if (!confirmed) return;
    }
    setName("");
    setDescription("");
    setWhenToUse("");
    setContent("");
    setSensitivity("internal");
    setTemplateSlug("");
    setTemplateName(null);
    setFirstMessage(null);
    setFirstFileIds([]);
    setNotice(null);
    setError(null);
    setStage("intent");
  }

  async function save() {
    const trimmedName = name.trim();
    const trimmedContent = content.trim();
    if (!trimmedName) {
      setError(skillsCopy.nameRequired);
      return;
    }
    if (!trimmedContent) {
      setError(skillsCopy.contentRequired);
      return;
    }
    // Same cap as the editor — the API rejects past it; fail before the wire.
    if (trimmedContent.length > SKILL_BODY_MAX_CHARS) {
      setError(
        format(t.brainPage.skillEditor.overLimit, { max: SKILL_BODY_MAX_CHARS }),
      );
      return;
    }
    setSaving(true);
    setError(null);
    const result = await createSkill({
      name: trimmedName,
      description: description.trim() || undefined,
      whenToUse: whenToUse.trim() || undefined,
      content: trimmedContent,
      workspaceId,
      sensitivity,
      enabledAssistantIds: "all",
      // Imported drafts carry their folder support files + provenance through
      // the save; hand-authored drafts send neither.
      supportFiles: initialImport?.supportFiles.length
        ? initialImport.supportFiles
        : undefined,
      importSource: initialImport?.importSource,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onCreated(result.skill);
  }

  const templateItems = catalog.map((entry) => ({
    value: entry.id,
    label: entry.name,
    hint: entry.category,
  }));

  // The intent stage is the hero treatment in BOTH modes (centred icon badge
  // + display-font heading + composer card); landing just pushes it down a
  // touch and the takeover leads with the BackButton.
  const landing = onBack === undefined;

  // ── Doc stage — the full document + the iteration chat rail ─────────
  if (stage === "doc") {
    return (
      <div className="flex-1 min-h-0 overflow-y-auto bg-background">
        <div className="mx-auto w-full max-w-6xl px-4 pt-5 pb-8 lg:px-6">
          {/* Action row — back, then the save cluster (sensitivity + Save).
              No BrainTopbar here: the Brain page already owns the surface
              chrome; this row is pane-local. */}
          <div className="flex flex-wrap items-center gap-2">
            <BackButton
              label={t.brainPage.skillsLibrary.back}
              onClick={() => void backFromDoc()}
            />
            <span className="min-w-0 flex-1" />
            <Select
              value={sensitivity}
              onValueChange={(v) => {
                if (v) setSensitivity(v as SkillSensitivity);
              }}
            >
              <SelectTrigger
                size="sm"
                aria-label={skillsCopy.sensitivityLabel}
                className="w-auto gap-1.5 border-transparent bg-muted/60 text-xs hover:bg-muted"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="end" alignItemWithTrigger={false}>
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
            <Button size="sm" disabled={saving || chatBusy} onClick={() => void save()}>
              {saving ? copy.saving : copy.saveCta}
            </Button>
          </div>

          {/* Orientation caption — which template seeded this document. */}
          {templateName && (
            <p className="mt-2 flex items-center gap-1.5 text-xs text-muted-foreground">
              <LayoutTemplate className="size-3.5 shrink-0" aria-hidden />
              {format(copy.templateLoadedCaption, { name: templateName })}
            </p>
          )}

          {notice && (
            <div className="mt-3 rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-xs text-amber-700 dark:text-amber-400">
              {notice}
            </div>
          )}
          {error && (
            <p className="mt-3 text-xs text-red-500" role="alert">
              {error}
            </p>
          )}

          <div className="mt-4 lg:grid lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-10">
            {/* The skill as a document — the editor page's column. */}
            <div className="min-w-0 flex flex-col">
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

            {/* The iteration chat rail — sticky beside the document on lg,
                stacked below it on smaller screens. */}
            <aside className="mt-10 lg:mt-0">
              <div className="lg:sticky lg:top-4">
                <SkillIterationChat
                  workspaceId={workspaceId}
                  getDraft={(): SkillDraft => ({
                    name,
                    description,
                    whenToUse,
                    content,
                    sensitivity,
                  })}
                  onDraft={(draft) => {
                    setName(draft.name);
                    setDescription(draft.description);
                    setWhenToUse(draft.whenToUse);
                    setContent(draft.content);
                    setSensitivity(draft.sensitivity);
                  }}
                  templateSlug={templateSlug || undefined}
                  autoSendFirst={firstMessage ?? undefined}
                  initialFileIds={
                    firstFileIds.length > 0 ? firstFileIds : undefined
                  }
                  onUnavailable={() => setNotice(copy.draftUnavailable)}
                  onBusyChange={setChatBusy}
                  className="h-[60vh] lg:h-[calc(100vh-10rem)]"
                />
              </div>
            </aside>
          </div>
        </div>
      </div>
    );
  }

  // ── Intent stage — the hero composer (landing + takeover) ────────────
  return (
    <div className="flex-1 min-h-0 overflow-y-auto bg-background">
      {/* pb-28 clears the fixed chat dock floated over the surface bottom-right. */}
      <div
        className={cn(
          "mx-auto flex w-full max-w-2xl flex-col gap-7 px-4 pb-28",
          landing ? "pt-[10vh]" : "pt-5",
        )}
      >
        {onBack && (
          <BackButton
            label={t.brainPage.skillsLibrary.back}
            onClick={onBack}
            className="self-start"
          />
        )}

        {/* Hero header — icon badge + display-font heading, centred. */}
        <header className="flex flex-col items-center gap-3 text-center">
          <div
            aria-hidden
            className="flex size-11 items-center justify-center rounded-2xl bg-gradient-to-br from-primary/15 via-primary/8 to-transparent text-primary ring-1 ring-primary/10"
          >
            <Sparkles className="size-5" />
          </div>
          <div className="flex flex-col gap-1">
            <h1
              className="text-2xl font-semibold tracking-tight"
              style={{ fontFamily: "var(--font-display)" }}
            >
              {skillsCopy.createTitle}
            </h1>
            <p className="text-sm text-muted-foreground">{copy.intro}</p>
          </div>
        </header>

        <div className="flex flex-col gap-3">
          {/* Composer card — borderless textarea over a footer row, the
              same grammar as the chat composers (one box + attach; the old
              separate paste-reference textarea was duplicate UX — pasted
              material goes straight in here, documents attach). The CARD
              carries the one focus ring (the documented composer-box recipe
              from globals.css); the textarea inside opts out of the global
              `:focus-visible` halo with `focus-visible:shadow-none`, so
              there is never an inner ring fighting the card border. */}
          <div
            {...dropProps}
            className={cn(
              "relative rounded-2xl border border-border bg-card shadow-sm transition-[border-color,box-shadow]",
              "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/35",
            )}
          >
            <FileDropOverlay active={isDragging} />
            {intentAttachments.attachments.length > 0 && (
              <div className="px-4 pt-3">
                <AttachmentChips
                  attachments={intentAttachments.attachments}
                  onRemove={intentAttachments.remove}
                />
              </div>
            )}
            <textarea
              value={intent}
              rows={3}
              maxLength={4000}
              placeholder={copy.intentPlaceholder}
              aria-label={copy.intentLabel}
              onChange={(e) => setIntent(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submitIntent();
                }
              }}
              className="w-full resize-none bg-transparent px-4 pt-4 pb-1 text-sm outline-none focus-visible:shadow-none placeholder:text-muted-foreground/70"
            />
            <div className="flex flex-wrap items-center gap-1.5 px-3 pb-3 pt-1">
              <input
                ref={fileInputRef}
                type="file"
                multiple
                className="hidden"
                onChange={(e) => {
                  if (e.target.files) void intentAttachments.upload(e.target.files);
                  e.target.value = "";
                }}
              />
              <button
                type="button"
                aria-label={chatCopy.attach}
                title={chatCopy.attach}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                <Paperclip className="size-4" aria-hidden />
              </button>
              <span className="min-w-0 flex-1" />
              <Button
                size="sm"
                disabled={busy || intentAttachments.uploading}
                onClick={submitIntent}
                className="rounded-lg"
              >
                <Sparkles className="size-3.5" aria-hidden />
                {copy.draftCta}
              </Button>
            </div>
          </div>

          {error && (
            <p className="text-center text-xs text-red-500" role="alert">
              {error}
            </p>
          )}
        </div>

        {/* Templates — THE one template surface (the old footer dropdown is
            gone): a labelled divider, rich one-tap cards for the first few
            catalog entries (picking one opens the ENTIRE template in the
            document view, no model call), and a searchable browse-all for
            the rest. Hidden when the catalog is empty/unreachable. */}
        {catalog.length > 0 && (
          <div className="flex flex-col gap-3">
            <div className="flex items-center gap-3" aria-hidden>
              <span className="h-px flex-1 bg-border/60" />
              <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground/60">
                {busy ? copy.loadingTemplate : copy.templateStripCaption}
              </span>
              <span className="h-px flex-1 bg-border/60" />
            </div>

            <div className="grid gap-2 sm:grid-cols-2">
              {catalog.slice(0, 4).map((entry) => (
                <button
                  key={entry.id}
                  type="button"
                  disabled={busy}
                  onClick={() => void pickTemplate(entry.id)}
                  className="group flex flex-col gap-1 rounded-xl border border-border bg-card p-3 text-left shadow-xs transition-all hover:-translate-y-px hover:border-foreground/25 hover:shadow-sm disabled:pointer-events-none disabled:opacity-60"
                >
                  <span className="flex items-center gap-2">
                    <LayoutTemplate
                      className="size-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground"
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate text-sm font-medium">
                      {entry.name}
                    </span>
                    <span className="shrink-0 rounded-full bg-muted px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                      {entry.category}
                    </span>
                  </span>
                  {entry.description && (
                    <span className="line-clamp-2 text-xs leading-relaxed text-muted-foreground">
                      {entry.description}
                    </span>
                  )}
                </button>
              ))}
            </div>

            {/* Browse-all — only when the catalog holds more than the cards
                show. The same themed searchable combobox, styled as a quiet
                centred trigger; its empty value keeps the placeholder. */}
            {catalog.length > 4 && (
              <SearchableSelect
                value=""
                onValueChange={(slug) => void pickTemplate(slug)}
                items={templateItems}
                placeholder={copy.templateBrowseAll}
                searchPlaceholder={copy.templateSearch}
                emptyMessage={copy.templateEmpty}
                aria-label={copy.templateLabel}
                className="mx-auto h-8 w-64 rounded-lg bg-muted/40 text-xs"
                popupClassName="w-80"
              />
            )}
          </div>
        )}

        {/* Manual escape hatch — quiet, centred, last. */}
        <div className="flex justify-center">
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={startManual}
            className="text-muted-foreground"
          >
            {copy.writeManually}
          </Button>
        </div>
      </div>
    </div>
  );
}
