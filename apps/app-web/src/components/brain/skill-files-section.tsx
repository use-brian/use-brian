"use client";

/**
 * Support-file bundle for one skill — the editor's "Files" section.
 *
 * A skill is a folder, not a lone body: `workspace_skill_files` holds its
 * reference / template / script files, and the body reaches them through
 * portable relative links in v2 and `{{kind:name}}` pointers in legacy v1. This section is
 * the HUMAN half of that surface. Before it existed the rows were write-once
 * at import, so the background curator's `add_support_file` could attach a
 * file the owning user could never see, edit, or delete.
 *
 * Shape follows the editor's document column: quiet full-width rows, no card
 * chrome, one inline editor open at a time. Each row shows the link or pointer
 * (click to copy) because a file the body never points at is inert — that
 * token is the whole contract between the bundle and the prompt.
 *
 * Deletes route through `confirmDialog` (never `window.confirm`), and every
 * string comes from `useT()`.
 *
 * Spec: docs/architecture/engine/skill-system.md → "Skill bundles and support files".
 *
 * [COMP:app-web/brain-skill-files]
 */

import * as React from "react";
import { Check, Copy, FileBox, FileCode2, FileText, Plus, Trash2, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  deleteSkillFile,
  listSkillFiles,
  saveSkillFile,
  skillFileMarkdownLink,
  skillFilePointer,
  SKILL_FILE_KINDS,
  type SkillFile,
  type SkillFileKind,
} from "@/lib/api/skills";

type Props = {
  skillRowId: string;
  /** The skill body — used only to tell "pointed at" from "inert". */
  content: string;
  bundleVersion?: 1 | 2;
};

type Draft = {
  /** The row being edited, or `null` for a new file. */
  original: { kind: SkillFileKind; name: string } | null;
  kind: SkillFileKind;
  name: string;
  /** Canonical bundle-relative path. Kept even though the compact editor only
   * exposes the basename so editing a nested imported file never flattens it. */
  path: string | null;
  content: string;
  /** Round-tripped, not just displayed: `PUT` replaces the whole row, so a
   *  draft that dropped this would wipe a curator-written description. */
  description: string;
};

const KIND_ICON: Record<SkillFileKind, typeof FileText> = {
  reference: FileText,
  asset: FileBox,
  template: FileText,
  script: FileCode2,
};

function emptyDraft(): Draft {
  return { original: null, kind: "reference", name: "", path: null, content: "", description: "" };
}

function defaultPath(kind: SkillFileKind, name: string): string {
  const root =
    kind === "reference"
      ? "references"
      : kind === "asset"
        ? "assets"
        : kind === "template"
          ? "templates"
          : "scripts";
  return `${root}/${name}`;
}

export function skillFileDraftPath(
  kind: SkillFileKind,
  name: string,
  currentPath: string | null,
): string {
  if (!currentPath) return defaultPath(kind, name);
  const parts = currentPath.split("/").filter(Boolean);
  const nested = parts.length > 2 ? parts.slice(1, -1) : [];
  const root = defaultPath(kind, name).split("/")[0]!;
  return [root, ...nested, name].join("/");
}

export function SkillFilesSection({ skillRowId, content, bundleVersion = 1 }: Props) {
  const t = useT();
  const copy = t.brainPage.skillFiles;

  const [files, setFiles] = React.useState<SkillFile[] | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [copied, setCopied] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    const res = await listSkillFiles(skillRowId);
    if (!res.ok) {
      setError(res.error);
      setFiles([]);
      return;
    }
    setFiles(res.files);
  }, [skillRowId]);

  React.useEffect(() => {
    void load();
  }, [load]);

  const kindLabel = React.useCallback(
    (kind: SkillFileKind) => copy.kinds[kind],
    [copy],
  );

  async function save() {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name || !draft.content.trim()) return;
    setBusy(true);
    setError(null);

    // A rename is a move: write the new (kind, name), then drop the old row —
    // the pair is the primary key, so an upsert alone would leave both.
    const res = await saveSkillFile(skillRowId, {
      kind: draft.kind,
      name,
      path: bundleVersion === 2 ? skillFileDraftPath(draft.kind, name, draft.path) : undefined,
      content: draft.content,
      description: draft.description.trim() || null,
    });
    if (!res.ok) {
      setBusy(false);
      setError(res.error);
      return;
    }
    const moved =
      draft.original &&
      (draft.original.kind !== draft.kind || draft.original.name !== name);
    if (moved) {
      const dropped = await deleteSkillFile(
        skillRowId,
        draft.original!.kind,
        draft.original!.name,
      );
      // The new row is already written; a failed drop leaves BOTH, which is
      // the duplicate state the move exists to avoid. Say so rather than
      // closing the form on a half-finished rename.
      if (!dropped.ok) {
        setBusy(false);
        setError(
          format(copy.renameLeftBehind, {
            name: draft.original!.name,
            error: dropped.error,
          }),
        );
        await load();
        return;
      }
    }
    setBusy(false);
    setDraft(null);
    await load();
  }

  async function remove(file: SkillFile) {
    const confirmed = await confirmDialog({
      title: copy.deleteTitle,
      description: format(copy.deleteBody, { name: file.name }),
      confirmLabel: copy.delete,
      variant: "destructive",
    });
    if (!confirmed) return;
    setBusy(true);
    setError(null);
    const res = await deleteSkillFile(skillRowId, file.kind, file.name);
    setBusy(false);
    if (!res.ok) {
      setError(res.error);
      return;
    }
    await load();
  }

  async function copyReference(file: SkillFile) {
    const reference = bundleVersion === 2
      ? (skillFileMarkdownLink(file) ?? skillFilePointer(file))
      : skillFilePointer(file);
    try {
      await navigator.clipboard.writeText(reference);
      setCopied(reference);
      window.setTimeout(() => setCopied(null), 1500);
    } catch {
      // Clipboard denied — the token is visible on the row regardless.
    }
  }

  // Loading: render nothing rather than a skeleton. The section sits below
  // the body, so a flash of empty chrome reads as "this skill has no files".
  if (files === null) return null;

  return (
    <section className="mt-10 border-t border-border pt-6">
      <div className="flex items-baseline justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{copy.heading}</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            {copy.explainer}
          </p>
        </div>
        {draft === null && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setError(null);
              setDraft(emptyDraft());
            }}
          >
            <Plus className="size-3.5" aria-hidden />
            {copy.add}
          </Button>
        )}
      </div>

      {error && (
        <p role="alert" className="mt-3 text-xs leading-relaxed text-red-500">
          {error}
        </p>
      )}

      {files.length === 0 && draft === null && (
        <p className="mt-4 text-xs text-muted-foreground">{copy.empty}</p>
      )}

      {files.length > 0 && (
        <ul className="mt-4">
          {files.map((file) => {
            const pointer = skillFilePointer(file);
            const markdownLink = skillFileMarkdownLink(file);
            const reference = bundleVersion === 2 && markdownLink ? markdownLink : pointer;
            const referenced = content.includes(pointer) || Boolean(markdownLink && content.includes(markdownLink));
            const Icon = KIND_ICON[file.kind];
            const editing =
              draft?.original?.kind === file.kind && draft?.original?.name === file.name;
            return (
              <li
                key={`${file.kind}:${file.name}`}
                className="border-b border-border last:border-b-0"
              >
                <div className="flex items-center gap-3 py-2.5">
                  <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm text-foreground">{file.name}</span>
                      <span className="shrink-0 rounded border border-border px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-muted-foreground">
                        {kindLabel(file.kind)}
                      </span>
                    </div>
                    <button
                      type="button"
                      onClick={() => void copyReference(file)}
                      title={copy.copyPointer}
                      className={cn(
                        "mt-0.5 inline-flex items-center gap-1 font-mono text-[11px] transition-colors",
                        referenced
                          ? "text-muted-foreground hover:text-foreground"
                          : "text-amber-600 hover:text-amber-500 dark:text-amber-500",
                      )}
                    >
                      {copied === reference ? (
                        <Check className="size-3" aria-hidden />
                      ) : (
                        <Copy className="size-3" aria-hidden />
                      )}
                      {reference}
                    </button>
                    {!referenced && (
                      <p className="mt-0.5 text-[11px] text-muted-foreground">
                        {copy.notReferenced}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => {
                        setError(null);
                        setDraft(
                          editing
                            ? null
                            : {
                                original: { kind: file.kind, name: file.name },
                                kind: file.kind,
                                name: file.name,
                                path: file.path,
                                content: file.content,
                                description: file.description ?? "",
                              },
                        );
                      }}
                    >
                      {editing ? copy.close : copy.edit}
                    </Button>
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={copy.delete}
                      onClick={() => void remove(file)}
                    >
                      <Trash2 className="size-3.5 text-muted-foreground" aria-hidden />
                    </Button>
                  </div>
                </div>
                {editing && <DraftEditor {...{ draft, setDraft, save, busy, copy }} />}
              </li>
            );
          })}
        </ul>
      )}

      {draft !== null && draft.original === null && (
        <div className="mt-4 border-t border-border pt-4">
          <DraftEditor {...{ draft, setDraft, save, busy, copy }} />
        </div>
      )}
    </section>
  );
}

/** The add / edit form — one is open at a time, inline under its row. */
function DraftEditor({
  draft,
  setDraft,
  save,
  busy,
  copy,
}: {
  draft: Draft;
  setDraft: (d: Draft | null) => void;
  save: () => Promise<void>;
  busy: boolean;
  copy: ReturnType<typeof useT>["brainPage"]["skillFiles"];
}) {
  const canSave = draft.name.trim().length > 0 && draft.content.trim().length > 0;
  return (
    <div className="pb-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="w-40">
          <span className="text-xs font-medium text-foreground">{copy.kindLabel}</span>
          <div className="mt-1.5">
            <SearchableSelect
              value={draft.kind}
              onValueChange={(value) =>
                setDraft({ ...draft, kind: (value || "reference") as SkillFileKind })
              }
              items={SKILL_FILE_KINDS.map((kind) => ({
                value: kind,
                label: copy.kinds[kind],
              }))}
              placeholder={copy.kindLabel}
              aria-label={copy.kindLabel}
            />
          </div>
        </div>
        <div className="min-w-0 flex-1">
          <label className="text-xs font-medium text-foreground" htmlFor="skill-file-name">
            {copy.nameLabel}
          </label>
          <input
            id="skill-file-name"
            value={draft.name}
            placeholder={copy.namePlaceholder}
            spellCheck={false}
            onChange={(e) => setDraft({ ...draft, name: e.target.value })}
            className="mt-1.5 h-9 w-full rounded-md border border-border bg-background px-3 font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </div>
      </div>
      <div className="mt-3">
        <label className="text-xs font-medium text-foreground" htmlFor="skill-file-description">
          {copy.descriptionLabel}
        </label>
        <input
          id="skill-file-description"
          value={draft.description}
          placeholder={copy.descriptionPlaceholder}
          onChange={(e) => setDraft({ ...draft, description: e.target.value })}
          className="mt-1.5 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
        />
      </div>
      <textarea
        value={draft.content}
        placeholder={copy.contentPlaceholder}
        rows={8}
        spellCheck={false}
        onChange={(e) => setDraft({ ...draft, content: e.target.value })}
        className="mt-3 w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
      />
      <div className="mt-3 flex items-center justify-end gap-2">
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setDraft(null)}>
          <X className="size-3.5" aria-hidden />
          {copy.cancel}
        </Button>
        <Button variant="default" size="sm" disabled={!canSave || busy} onClick={() => void save()}>
          {busy ? copy.saving : copy.save}
        </Button>
      </div>
    </div>
  );
}
