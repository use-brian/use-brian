"use client";

/**
 * Studio → Brand — the workspace brand record's management surface.
 *
 * Three tabs over one record:
 *   - Approved — a read view of the ACTIVE approved version. What every
 *     assistant in the workspace actually applies.
 *   - Draft    — the editor. Friendly fields for naming / strategy /
 *     messaging / colors / typography; a JSON box for the long tail
 *     (logo variants, applications, claims, rights, governance, sources).
 *   - History  — every approved version, newest first.
 *
 * **Approve is the only irreversible action here**, so it is owner/admin-only
 * (the server enforces it; `canApprove` from the API drives whether the button
 * renders at all) and it goes through `confirmDialog` with the version number
 * spelled out. Saving a draft is not consequential — a draft is a proposal —
 * so it saves without a confirm.
 *
 * The record ↔ form conversions live in `@/lib/brand-form` so the lossy-round-
 * trip risk is unit-tested; this file is the surface only.
 *
 * Backend: /api/workspaces/:workspaceId/brand
 * (use-brian/packages/api/src/routes/brand.ts).
 * Spec: docs/architecture/features/brand.md → "Management flows".
 *
 * [COMP:app-web/studio-brand]
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";
import { useWorkspaces } from "@/contexts/workspace-context";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { StudioTopbarActions } from "@/components/studio/studio-topbar";
import { Button } from "@/components/ui/button";
import {
  formToPatch,
  isDirty,
  recordToForm,
  type BrandFormState,
  type BrandRecordLike,
} from "@/lib/brand-form";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type BrandSummary = {
  id: string;
  slug: string;
  name: string;
  isDefault: boolean;
  status: "draft" | "active" | "superseded";
  activeVersion: number | null;
  hasDraft: boolean;
};

type BrandDetail = BrandSummary & {
  draft: BrandRecordLike | null;
  activeRecord: BrandRecordLike | null;
};

type BrandVersion = {
  id: string;
  version: number;
  approvedBy: string | null;
  approvedAt: string;
};

type Tab = "approved" | "draft" | "history";

/** Turn a name into a slug candidate the server's pattern accepts. */
function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63);
}

export default function StudioBrandPage() {
  const t = useT();
  const copy = t.studioPage.brandPage;
  const { activeId: workspaceId } = useWorkspaces();

  const [brand, setBrand] = useState<BrandDetail | null>(null);
  const [canApprove, setCanApprove] = useState(false);
  const [versions, setVersions] = useState<BrandVersion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);
  const [tab, setTab] = useState<Tab>("draft");
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [newSlug, setNewSlug] = useState("");

  const [form, setForm] = useState<BrandFormState>(() => recordToForm(null));
  const [seed, setSeed] = useState<BrandFormState>(() => recordToForm(null));

  const base = workspaceId ? `${API_URL}/api/workspaces/${workspaceId}/brand` : null;

  const seedFrom = useCallback((detail: BrandDetail | null) => {
    // The draft is the editable body; falling back to the approved record is
    // what makes "the next edit opens a new draft" true in the UI as well as
    // in the store.
    const next = recordToForm(detail?.draft ?? detail?.activeRecord ?? null);
    setForm(next);
    setSeed(next);
  }, []);

  const load = useCallback(async () => {
    if (!base) return;
    setLoading(true);
    setError(null);
    try {
      const res = await authFetch(`${base}/default`);
      if (res.status === 404) {
        setBrand(null);
        seedFrom(null);
        const listRes = await authFetch(base);
        if (listRes.ok) setCanApprove(Boolean((await listRes.json()).canApprove));
        return;
      }
      if (!res.ok) throw new Error(String(res.status));
      const body = await res.json();
      setBrand(body.brand as BrandDetail);
      setCanApprove(Boolean(body.canApprove));
      seedFrom(body.brand as BrandDetail);
      setTab((body.brand as BrandDetail).activeRecord ? "approved" : "draft");
      const vRes = await authFetch(`${base}/${(body.brand as BrandDetail).id}/versions`);
      if (vRes.ok) setVersions(((await vRes.json()).versions ?? []) as BrandVersion[]);
    } catch {
      setError(copy.loadError);
    } finally {
      setLoading(false);
    }
  }, [base, copy.loadError, seedFrom]);

  useEffect(() => {
    void load();
  }, [load]);

  const dirty = useMemo(() => isDirty(form, seed), [form, seed]);

  const set = <K extends keyof BrandFormState>(key: K) =>
    (e: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: e.target.value }));

  async function handleCreate() {
    if (!base) return;
    const name = newName.trim();
    if (!name) return;
    setError(null);
    const res = await authFetch(base, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name, slug: (newSlug.trim() || slugify(name)) }),
    });
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? copy.saveError);
      return;
    }
    setCreating(false);
    setNewName("");
    setNewSlug("");
    await load();
  }

  async function handleSave() {
    if (!base || !brand) return;
    setIssues([]);
    setError(null);
    const built = formToPatch(form);
    if (!built.ok) {
      setIssues([copy.advancedHint]);
      return;
    }
    setSaving(true);
    try {
      const res = await authFetch(`${base}/${brand.id}/draft`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ changes: built.patch }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        // Field paths, so the person editing can fix the exact box rather than
        // hunting through a form that "did not save".
        setIssues(
          Array.isArray(body.issues) && body.issues.length > 0
            ? body.issues.map((i: { path: string; message: string }) => `${i.path}: ${i.message}`)
            : [body.error ?? copy.saveError],
        );
        return;
      }
      const body = await res.json();
      setBrand(body.brand as BrandDetail);
      setSeed(form);
      setSavedAt(Date.now());
    } catch {
      setError(copy.saveError);
    } finally {
      setSaving(false);
    }
  }

  async function handleRevert() {
    const ok = await confirmDialog({
      title: copy.revertTitle,
      description: copy.revertBody,
      confirmLabel: copy.revertConfirm,
      cancelLabel: copy.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    seedFrom(brand);
    setIssues([]);
  }

  async function handleApprove() {
    if (!base || !brand) return;
    if (!brand.hasDraft) {
      setError(copy.approveNothing);
      return;
    }
    const nextVersion = (brand.activeVersion ?? 0) + 1;
    const ok = await confirmDialog({
      title: copy.approveTitle,
      description: format(copy.approveBody, { version: String(nextVersion) }),
      confirmLabel: copy.approveConfirm,
      cancelLabel: copy.cancel,
    });
    if (!ok) return;
    const res = await authFetch(`${base}/${brand.id}/approve`, { method: "POST" });
    if (!res.ok) {
      setError((await res.json().catch(() => ({}))).error ?? copy.saveError);
      return;
    }
    await load();
    setTab("approved");
  }

  // ── Render helpers ──────────────────────────────────────────────────────

  const field = (label: string, key: keyof BrandFormState, hint?: string, rows = 1) => (
    <label className="block space-y-1">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {rows > 1 ? (
        <textarea
          rows={rows}
          value={form[key]}
          onChange={set(key)}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm font-mono"
        />
      ) : (
        <input
          value={form[key]}
          onChange={set(key)}
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
        />
      )}
      {hint ? <span className="block text-xs text-muted-foreground">{hint}</span> : null}
    </label>
  );

  const readGroup = (heading: string, rows: Array<[string, string]>) => {
    const shown = rows.filter(([, v]) => v.length > 0);
    if (shown.length === 0) return null;
    return (
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">{heading}</h3>
        <dl className="space-y-1">
          {shown.map(([k, v]) => (
            <div key={k} className="grid grid-cols-[10rem_1fr] gap-2 text-sm">
              <dt className="text-muted-foreground">{k}</dt>
              <dd className="whitespace-pre-wrap">{v}</dd>
            </div>
          ))}
        </dl>
      </section>
    );
  };

  const approvedForm = useMemo(() => recordToForm(brand?.activeRecord ?? null), [brand]);

  if (loading) {
    return <div className="p-6 text-sm text-muted-foreground">{copy.heading}</div>;
  }

  if (!brand) {
    return (
      <div className="p-6 space-y-4">
        <h1 className="text-lg font-semibold">{copy.heading}</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">{copy.intro}</p>
        <p className="max-w-2xl text-sm text-muted-foreground">{copy.empty}</p>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {creating ? (
          <div className="max-w-md space-y-3 rounded-lg border border-border p-4">
            <h2 className="text-sm font-semibold">{copy.createHeading}</h2>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{copy.nameLabel}</span>
              <input
                value={newName}
                placeholder={copy.namePlaceholder}
                onChange={(e) => setNewName(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
            </label>
            <label className="block space-y-1">
              <span className="text-xs font-medium text-muted-foreground">{copy.slugLabel}</span>
              <input
                value={newSlug}
                placeholder={slugify(newName)}
                onChange={(e) => setNewSlug(e.target.value)}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-sm"
              />
              <span className="block text-xs text-muted-foreground">{copy.slugHint}</span>
            </label>
            <div className="flex gap-2">
              <Button size="sm" onClick={() => void handleCreate()}>
                {copy.create}
              </Button>
              <Button size="sm" variant="outline" onClick={() => setCreating(false)}>
                {copy.cancel}
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" onClick={() => setCreating(true)}>
            {copy.createCta}
          </Button>
        )}
      </div>
    );
  }

  const statusLabel =
    brand.status === "active" ? copy.statusActive : brand.status === "superseded" ? copy.statusSuperseded : copy.statusDraft;

  return (
    <div className="p-6 space-y-5">
      <StudioTopbarActions>
        {canApprove ? (
          <Button size="sm" onClick={() => void handleApprove()} disabled={!brand.hasDraft}>
            {copy.approve}
          </Button>
        ) : null}
      </StudioTopbarActions>

      <header className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-lg font-semibold">{brand.name}</h1>
          <span className="rounded-full border border-border px-2 py-0.5 text-xs">{statusLabel}</span>
          {brand.isDefault ? (
            <span className="rounded-full border border-border px-2 py-0.5 text-xs">{copy.defaultBadge}</span>
          ) : null}
          {brand.hasDraft ? (
            <span className="rounded-full border border-primary px-2 py-0.5 text-xs text-primary">
              {copy.unapprovedBadge}
            </span>
          ) : null}
        </div>
        <p className="max-w-2xl text-sm text-muted-foreground">{copy.intro}</p>
        <p className="text-xs text-muted-foreground">
          {brand.activeVersion
            ? format(copy.approvedVersion, { version: String(brand.activeVersion) })
            : copy.neverApproved}
        </p>
        {!canApprove ? <p className="text-xs text-muted-foreground">{copy.approveOnlyOwner}</p> : null}
      </header>

      <nav className="flex gap-1 border-b border-border">
        {(["approved", "draft", "history"] as const).map((key) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={cn(
              "px-3 py-1.5 text-sm",
              tab === key ? "border-b-2 border-primary font-medium" : "text-muted-foreground",
            )}
          >
            {key === "approved" ? copy.tabApproved : key === "draft" ? copy.tabDraft : copy.tabHistory}
          </button>
        ))}
      </nav>

      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      {tab === "approved" ? (
        brand.activeRecord ? (
          <div className="max-w-3xl space-y-5">
            {readGroup(copy.groupNaming, [
              [copy.fieldName, approvedForm.name],
              [copy.fieldPublicName, approvedForm.publicName],
              [copy.fieldDescriptor, approvedForm.descriptor],
              [copy.fieldTagline, approvedForm.tagline],
              [copy.fieldCapitalization, approvedForm.capitalization],
              [copy.fieldRestrictedTerms, approvedForm.restrictedTerms],
            ])}
            {readGroup(copy.groupMessaging, [
              [copy.fieldOneLine, approvedForm.oneLine],
              [copy.fieldElevator, approvedForm.elevator],
              [copy.fieldVoice, approvedForm.voice],
              [copy.fieldPreferred, approvedForm.preferred],
              [copy.fieldAvoid, approvedForm.avoid],
            ])}
            {readGroup(copy.groupStrategy, [
              [copy.fieldPositioning, approvedForm.positioning],
              [copy.fieldAudience, approvedForm.audience],
              [copy.fieldDifferentiators, approvedForm.differentiators],
            ])}
            {readGroup(copy.groupColors, [[copy.groupColors, approvedForm.colors]])}
            {readGroup(copy.groupTypography, [[copy.groupTypography, approvedForm.typography]])}
            {readGroup(copy.groupAdvanced, [[copy.groupAdvanced, approvedForm.advancedJson]])}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">{copy.approvedEmpty}</p>
        )
      ) : null}

      {tab === "draft" ? (
        <div className="max-w-3xl space-y-6">
          {!brand.hasDraft ? <p className="text-sm text-muted-foreground">{copy.draftEmpty}</p> : null}

          {issues.length > 0 ? (
            <div className="rounded-md border border-destructive/50 p-3 text-sm">
              <p className="font-medium">{copy.invalid}</p>
              <ul className="mt-1 list-disc pl-5 text-muted-foreground">
                {issues.map((i) => (
                  <li key={i}>{i}</li>
                ))}
              </ul>
            </div>
          ) : null}

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{copy.groupNaming}</h2>
            {field(copy.fieldName, "name")}
            {field(copy.fieldPublicName, "publicName")}
            {field(copy.fieldDescriptor, "descriptor")}
            {field(copy.fieldTagline, "tagline")}
            {field(copy.fieldCapitalization, "capitalization")}
            {field(copy.fieldRestrictedTerms, "restrictedTerms", copy.listHint, 3)}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{copy.groupMessaging}</h2>
            {field(copy.fieldOneLine, "oneLine")}
            {field(copy.fieldElevator, "elevator", undefined, 3)}
            {field(copy.fieldVoice, "voice", copy.voiceHint, 4)}
            {field(copy.fieldPreferred, "preferred", copy.listHint, 3)}
            {field(copy.fieldAvoid, "avoid", copy.listHint, 3)}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{copy.groupStrategy}</h2>
            {field(copy.fieldPositioning, "positioning", undefined, 3)}
            {field(copy.fieldAudience, "audience", copy.listHint, 3)}
            {field(copy.fieldDifferentiators, "differentiators", copy.listHint, 3)}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{copy.groupColors}</h2>
            {field(copy.groupColors, "colors", copy.colorsHint, 5)}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{copy.groupTypography}</h2>
            {field(copy.groupTypography, "typography", copy.typographyHint, 4)}
          </section>

          <section className="space-y-3">
            <h2 className="text-sm font-semibold">{copy.groupAdvanced}</h2>
            {field(copy.groupAdvanced, "advancedJson", copy.advancedHint, 12)}
          </section>

          <div className="flex items-center gap-2">
            <Button size="sm" onClick={() => void handleSave()} disabled={saving || !dirty}>
              {saving ? copy.saving : copy.save}
            </Button>
            <Button size="sm" variant="outline" onClick={() => void handleRevert()} disabled={!dirty}>
              {copy.revert}
            </Button>
            {savedAt && !dirty ? (
              <span className="text-xs text-muted-foreground">{copy.saved}</span>
            ) : null}
          </div>
        </div>
      ) : null}

      {tab === "history" ? (
        versions.length === 0 ? (
          <p className="text-sm text-muted-foreground">{copy.historyEmpty}</p>
        ) : (
          <ul className="max-w-2xl divide-y divide-border">
            {versions.map((v) => (
              <li key={v.id} className="flex items-center justify-between py-2 text-sm">
                <span>{format(copy.historyVersion, { version: String(v.version) })}</span>
                <span className="text-xs text-muted-foreground">
                  {format(copy.historyApproved, { when: new Date(v.approvedAt).toLocaleDateString() })}
                </span>
              </li>
            ))}
          </ul>
        )
      ) : null}
    </div>
  );
}
