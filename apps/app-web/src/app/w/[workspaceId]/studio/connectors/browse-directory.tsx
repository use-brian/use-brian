"use client";

/**
 * BrowseDirectory (app-web) — the add-connector / browse-skills modal.
 *
 * Ported from `apps/web/src/app/(app)/studio/connectors/browse-directory.tsx`
 * (app consolidation §9 #5). Faithful copy with two deltas:
 *   - Every user-facing string flows through `useT()` (`t.browseDirectory`),
 *     where the apps/web original was hard-coded English.
 *   - Uses app-web's mirrored `OFFICIAL_OAUTH_SCOPES` + `ConnectorIcon`
 *     instead of `@sidanclaw/shared` (app-web does not depend on shared).
 *
 * INFRA NOTE (degraded): the OAuth "Connect" path builds the Google authorize
 * URL client-side from `NEXT_PUBLIC_GOOGLE_CLIENT_ID` (unset in app-web).
 * Non-OAuth connectors ("Add" → backend connect) and the skills tab work
 * regardless. See the connectors page header for the full infra-pending list.
 *
 * [COMP:app-web/browse-directory]
 */

import { useState, useEffect, useCallback } from "react";
import { authFetch } from "@/lib/auth-fetch";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { OFFICIAL_OAUTH_SCOPES } from "@sidanclaw/shared/builtin-connectors";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const GOOGLE_CLIENT_ID = process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID ?? "";

type DirectoryEntry = {
  id: string;
  name: string;
  description: string;
  category: "official" | "community";
  icon_url?: string;
  mcp_url?: string;
  auth_type: "none" | "oauth" | "api_key";
  oauth_required: boolean;
  author?: string;
  author_url?: string;
  tags: string[];
  enabled: boolean;
  connected: boolean;
  added: boolean;
  /** Whether another instance of this connector can be added (multi-instance). */
  addable?: boolean;
};

function DirectoryConnectorIcon({ entry }: { entry: DirectoryEntry }) {
  return (
    <ConnectorIcon
      connectorId={entry.id}
      iconUrl={entry.icon_url}
      fallback={
        <div className="w-5 h-5 rounded bg-primary/20 flex items-center justify-center text-[10px] font-bold text-primary">
          {entry.name.charAt(0).toUpperCase()}
        </div>
      }
    />
  );
}

type BrowseDirectoryProps = {
  open: boolean;
  onClose: () => void;
  onConnectorAdded: () => void;
  /**
   * Launches the connectors page's OAuth flow for an oauth_required entry
   * (Google / Notion / Fathom) — the page owns the per-provider authorize
   * URLs and threads `[:add]:<workspaceId>` through `state`, so both Connect
   * and "Add another" land on the right callback with the right intent.
   * Absent → the modal falls back to its degraded self-built Google URL
   * (legacy standalone use).
   */
  onOauthConnect?: (entry: { id: string }, opts?: { addAnother?: boolean }) => void;
};

type SkillCatalogEntry = {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  category: string;
  requiresConnectors: string[];
  source: string;
};

export function BrowseDirectory({ open, onClose, onConnectorAdded, onOauthConnect }: BrowseDirectoryProps) {
  const t = useT();
  const [activeTab, setActiveTab] = useState<"connectors" | "skills">("connectors");
  const [directory, setDirectory] = useState<DirectoryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [addingId, setAddingId] = useState<string | null>(null);

  // Skills state
  const [skillCatalog, setSkillCatalog] = useState<SkillCatalogEntry[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);
  const [showSkillEditor, setShowSkillEditor] = useState(false);
  const [skillForm, setSkillForm] = useState({ name: "", description: "", whenToUse: "", content: "", category: "custom", requiresConnectors: "" });
  const [savingSkill, setSavingSkill] = useState(false);
  const [skillError, setSkillError] = useState("");

  const fetchSkillCatalog = useCallback(async () => {
    setSkillsLoading(true);
    try {
      const [catalogRes, mineRes] = await Promise.all([
        authFetch(`${API_URL}/api/skills/catalog`),
        authFetch(`${API_URL}/api/skills/mine`),
      ]);
      const catalog = catalogRes.ok ? await catalogRes.json() : { skills: [] };
      const mine = mineRes.ok ? await mineRes.json() : { skills: [] };
      const catalogIds = new Set((catalog.skills ?? []).map((s: SkillCatalogEntry) => s.id));
      const merged = [...(catalog.skills ?? []), ...(mine.skills ?? []).filter((s: SkillCatalogEntry) => !catalogIds.has(s.id))];
      setSkillCatalog(merged);
    } catch {} finally { setSkillsLoading(false); }
  }, []);

  async function handleSaveSkill() {
    if (!skillForm.name.trim() || !skillForm.content.trim()) { setSkillError(t.browseDirectory.nameContentRequired); return; }
    setSavingSkill(true); setSkillError("");
    try {
      const res = await authFetch(`${API_URL}/api/skills`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: skillForm.name.trim(),
          description: skillForm.description.trim() || skillForm.name.trim(),
          whenToUse: skillForm.whenToUse.trim() || undefined,
          content: skillForm.content.trim(),
          category: skillForm.category,
          requiresConnectors: skillForm.requiresConnectors.split(",").map((s) => s.trim()).filter(Boolean),
        }),
      });
      if (res.ok) {
        setShowSkillEditor(false);
        setSkillForm({ name: "", description: "", whenToUse: "", content: "", category: "custom", requiresConnectors: "" });
        fetchSkillCatalog();
      } else {
        const err = await res.json().catch(() => ({}));
        setSkillError((err as { error?: string }).error ?? t.browseDirectory.failedToSave);
      }
    } catch { setSkillError(t.browseDirectory.networkError); } finally { setSavingSkill(false); }
  }

  const fetchDirectory = useCallback(async () => {
    setLoading(true);
    try {
      const res = await authFetch(`${API_URL}/api/connectors/directory`);
      if (res.ok) {
        const data = await res.json();
        setDirectory(data.directory ?? []);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (open) { fetchDirectory(); fetchSkillCatalog(); }
  }, [open, fetchDirectory, fetchSkillCatalog]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  async function handleAdd(entry: DirectoryEntry) {
    setAddingId(entry.id);
    try {
      const res = await authFetch(`${API_URL}/api/connectors/directory/${entry.id}/add`, {
        method: "POST",
      });
      if (res.ok) {
        setDirectory((prev) =>
          prev.map((e) => (e.id === entry.id ? { ...e, added: true } : e)),
        );
        onConnectorAdded();
      }
    } catch {
      // silently fail
    } finally {
      setAddingId(null);
    }
  }

  // "Add another" for a connected entry. OAuth providers go through the
  // page's OAuth flow with the `:add` intent (a directory-add here would
  // mint an orphan disconnected instance whose later plain OAuth connect
  // overwrites the primary's credentials); PAT / remote-MCP entries keep
  // the create-disconnected-instance path (the rail's PAT form targets the
  // new instance by id).
  function handleAddAnother(entry: DirectoryEntry) {
    if (entry.oauth_required && onOauthConnect) {
      onOauthConnect(entry, { addAnother: true });
      return;
    }
    handleAdd(entry);
  }

  async function handleConnect(entry: DirectoryEntry) {
    // Prefer the page's OAuth flow (correct per-provider authorize URL +
    // workspace-scoped return); the block below is the degraded fallback.
    if (entry.oauth_required && onOauthConnect) {
      onOauthConnect(entry);
      return;
    }
    setAddingId(entry.id);

    // OAuth connectors — build Google OAuth URL client-side (same pattern as login)
    const scopes = OFFICIAL_OAUTH_SCOPES[entry.id];
    if (scopes) {
      const redirectUri = `${window.location.origin}/api/auth/callback/google-connector`;
      const params = new URLSearchParams({
        client_id: GOOGLE_CLIENT_ID,
        redirect_uri: redirectUri,
        response_type: "code",
        scope: scopes.join(" "),
        access_type: "offline",
        prompt: "consent",
        state: entry.id,
      });
      window.location.href = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
      return;
    }

    // Non-OAuth connectors
    try {
      const res = await authFetch(`${API_URL}/api/connectors/${entry.id}/connect`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (res.ok) {
        setDirectory((prev) =>
          prev.map((e) => (e.id === entry.id ? { ...e, connected: true, added: true } : e)),
        );
        onConnectorAdded();
      }
    } catch {
      // silently fail
    } finally {
      setAddingId(null);
    }
  }

  if (!open) return null;

  const filtered = directory.filter((e) => {
    if (!e.enabled) return false;
    if (!search.trim()) return true;
    const q = search.toLowerCase();
    return (
      e.name.toLowerCase().includes(q) ||
      e.description.toLowerCase().includes(q) ||
      e.tags.some((tag) => tag.toLowerCase().includes(q))
    );
  });

  const official = filtered.filter((e) => e.category === "official");
  const community = filtered.filter((e) => e.category === "community");

  return (
    <>
      {/* Backdrop — fixed to viewport, 100dvh ensures mobile/desktop full coverage */}
      <div className="fixed top-0 left-0 w-screen h-[100dvh] z-[60] bg-black/60 backdrop-blur-sm" onClick={onClose} />

      {/* Modal — fixed to viewport, centered */}
      <div className="fixed top-0 left-0 w-screen h-[100dvh] z-[61] flex items-center justify-center pointer-events-none">
      <div className="relative w-full max-w-4xl max-h-[85vh] bg-background border border-border rounded-2xl shadow-2xl flex flex-col mx-4 pointer-events-auto">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border shrink-0">
          <h2 className="text-lg font-semibold">{t.browseDirectory.title}</h2>
          <button
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-lg text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M4 4l8 8M12 4l-8 8" />
            </svg>
          </button>
        </div>

        {/* Sub-tabs + Search */}
        <div className="px-6 py-3 border-b border-border shrink-0 space-y-3">
          <div className="flex gap-1">
            {(["connectors", "skills"] as const).map((tab) => (
              <button
                key={tab}
                onClick={() => { setActiveTab(tab); setSearch(""); }}
                className={`text-sm px-3 py-1.5 rounded-lg transition-colors ${
                  activeTab === tab ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {tab === "skills" ? t.browseDirectory.tabSkills : t.browseDirectory.tabConnectors}
              </button>
            ))}
          </div>
          <input
            type="text"
            placeholder={activeTab === "skills" ? t.browseDirectory.searchSkills : t.browseDirectory.searchConnectors}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4 space-y-6">
          {activeTab === "skills" ? (
            <>
              {skillsLoading ? (
                <div className="text-sm text-muted-foreground text-center py-10">{t.browseDirectory.loadingSkills}</div>
              ) : (
                <>
                  {/* Create skill button */}
                  <div className="flex justify-end">
                    <button
                      onClick={() => { setSkillForm({ name: "", description: "", whenToUse: "", content: "", category: "custom", requiresConnectors: "" }); setSkillError(""); setShowSkillEditor(true); }}
                      className="text-sm font-medium px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
                    >
                      {t.browseDirectory.createSkill}
                    </button>
                  </div>

                  {(() => {
                    const q = search.toLowerCase();
                    const filteredSkills = skillCatalog.filter((s) =>
                      !q || s.name.toLowerCase().includes(q) || s.description.toLowerCase().includes(q) || s.category.includes(q)
                    );
                    const builtin = filteredSkills.filter((s) => s.source === "builtin");
                    const custom = filteredSkills.filter((s) => s.source === "user");
                    const communitySkills = filteredSkills.filter((s) => s.source === "community");

                    if (filteredSkills.length === 0) {
                      return <div className="text-sm text-muted-foreground text-center py-10">{search.trim() ? t.browseDirectory.noSkillsMatch : t.browseDirectory.noSkills}</div>;
                    }

                    return (
                      <>
                        {builtin.length > 0 && <SkillSection title={t.browseDirectory.sectionBuiltIn} skills={builtin} />}
                        {custom.length > 0 && <SkillSection title={t.browseDirectory.sectionMySkills} skills={custom} />}
                        {communitySkills.length > 0 && <SkillSection title={t.browseDirectory.sectionCommunity} skills={communitySkills} />}
                      </>
                    );
                  })()}

                  {/* Skill editor inline */}
                  {showSkillEditor && (
                    <div className="border border-primary/30 rounded-xl p-5 bg-muted/10 space-y-3">
                      <h3 className="text-sm font-semibold">{t.browseDirectory.createSkill}</h3>
                      <input type="text" value={skillForm.name} onChange={(e) => setSkillForm({ ...skillForm, name: e.target.value })} placeholder={t.browseDirectory.skillNamePlaceholder} maxLength={100} className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      <input type="text" value={skillForm.description} onChange={(e) => setSkillForm({ ...skillForm, description: e.target.value })} placeholder={t.browseDirectory.shortDescriptionPlaceholder} maxLength={250} className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      <input type="text" value={skillForm.whenToUse} onChange={(e) => setSkillForm({ ...skillForm, whenToUse: e.target.value })} placeholder={t.browseDirectory.whenToUsePlaceholder} className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      <div className="flex gap-3">
                        <Select value={skillForm.category} onValueChange={(v: string | null) => setSkillForm({ ...skillForm, category: v ?? "custom" })}>
                          <SelectTrigger className="h-10 bg-muted/50">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectItem value="custom">{t.browseDirectory.catCustom}</SelectItem>
                            <SelectItem value="productivity">{t.browseDirectory.catProductivity}</SelectItem>
                            <SelectItem value="communication">{t.browseDirectory.catCommunication}</SelectItem>
                            <SelectItem value="research">{t.browseDirectory.catResearch}</SelectItem>
                          </SelectContent>
                        </Select>
                        <input type="text" value={skillForm.requiresConnectors} onChange={(e) => setSkillForm({ ...skillForm, requiresConnectors: e.target.value })} placeholder={t.browseDirectory.requiredConnectorsPlaceholder} className="flex-1 text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30" />
                      </div>
                      <textarea value={skillForm.content} onChange={(e) => setSkillForm({ ...skillForm, content: e.target.value })} placeholder={t.browseDirectory.contentPlaceholder} rows={6} maxLength={5000} className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-2 focus:ring-primary/30 resize-y font-mono" />
                      {skillError && <p className="text-xs text-destructive">{skillError}</p>}
                      <div className="flex gap-2 justify-end">
                        <button onClick={() => setShowSkillEditor(false)} className="text-sm px-3 py-1.5 rounded-lg border border-border text-muted-foreground hover:bg-muted transition-colors">{t.browseDirectory.cancel}</button>
                        <button onClick={handleSaveSkill} disabled={savingSkill} className="text-sm px-3 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors">{savingSkill ? t.browseDirectory.saving : t.browseDirectory.create}</button>
                      </div>
                    </div>
                  )}
                </>
              )}
            </>
          ) : (
            <>
              {loading ? (
                <div className="text-sm text-muted-foreground text-center py-10">{t.browseDirectory.loadingDirectory}</div>
              ) : filtered.length === 0 ? (
                <div className="text-sm text-muted-foreground text-center py-10">
                  {search.trim() ? t.browseDirectory.noConnectorsMatch : t.browseDirectory.noConnectors}
                </div>
              ) : (
                <>
                  {official.length > 0 && (
                    <DirectorySection
                      title={t.browseDirectory.sectionOfficial}
                      entries={official}
                      addingId={addingId}
                      onAdd={handleAdd}
                      onAddAnother={handleAddAnother}
                      onConnect={handleConnect}
                    />
                  )}
                  {community.length > 0 && (
                    <DirectorySection
                      title={t.browseDirectory.sectionCommunity}
                      entries={community}
                      addingId={addingId}
                      onAdd={handleAdd}
                      onAddAnother={handleAddAnother}
                      onConnect={handleConnect}
                      footer={
                        <p className="text-[11px] text-muted-foreground/60 mt-3">
                          {t.browseDirectory.browseAllPrefix}{" "}
                          <a
                            href="https://github.com/sidanclaw/sidanclaw-tools"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                          >
                            github.com/sidanclaw/sidanclaw-tools
                          </a>
                        </p>
                      }
                    />
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
      </div>
    </>
  );
}

// ── Directory section (Official / Community) ──────────────────

function DirectorySection({
  title,
  entries,
  addingId,
  onAdd,
  onAddAnother,
  onConnect,
  footer,
}: {
  title: string;
  entries: DirectoryEntry[];
  addingId: string | null;
  onAdd: (entry: DirectoryEntry) => void;
  onAddAnother: (entry: DirectoryEntry) => void;
  onConnect: (entry: DirectoryEntry) => void;
  footer?: React.ReactNode;
}) {
  return (
    <div>
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">
        {title}
      </h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {entries.map((entry) => (
          <DirectoryCard
            key={entry.id}
            entry={entry}
            adding={addingId === entry.id}
            onAdd={() => onAdd(entry)}
            onAddAnother={() => onAddAnother(entry)}
            onConnect={() => onConnect(entry)}
          />
        ))}
      </div>
      {footer}
    </div>
  );
}

// ── Directory card ────────────────────────────────────────────

function DirectoryCard({
  entry,
  adding,
  onAdd,
  onAddAnother,
  onConnect,
}: {
  entry: DirectoryEntry;
  adding: boolean;
  onAdd: () => void;
  onAddAnother: () => void;
  onConnect: () => void;
}) {
  const t = useT();
  function renderAction() {
    // Connected → compact pill (kept narrow so it doesn't crowd the title).
    // The "Add another" affordance for multi-instance connectors lives in a
    // full-width footer below instead (see DirectoryCard).
    if (entry.connected) {
      return (
        <span className="text-[10px] font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full">
          {t.browseDirectory.connectedBadge}
        </span>
      );
    }
    if (entry.added) {
      return (
        <button
          onClick={(e) => { e.stopPropagation(); onConnect(); }}
          disabled={adding}
          className="text-[11px] font-medium bg-primary text-primary-foreground px-2.5 py-1 rounded-lg hover:bg-primary/90 disabled:opacity-50 transition-colors"
        >
          {adding ? "..." : t.browseDirectory.connect}
        </button>
      );
    }
    return (
      <button
        onClick={(e) => { e.stopPropagation(); onAdd(); }}
        disabled={adding}
        className="text-[11px] font-medium border border-border px-2.5 py-1 rounded-lg text-muted-foreground hover:text-foreground hover:border-primary/30 disabled:opacity-50 transition-colors"
      >
        {adding ? "..." : t.browseDirectory.add}
      </button>
    );
  }

  return (
    <div className="flex items-start gap-3 border border-border rounded-xl p-4 hover:bg-muted/20 transition-colors">
      <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0 mt-0.5">
        <DirectoryConnectorIcon entry={entry} />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium truncate">{entry.name}</span>
            </div>
            <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">
              {entry.description}
            </p>
            {entry.author && (
              <p className="text-[10px] text-muted-foreground/60 mt-1">
                {t.browseDirectory.byAuthor}{" "}
                {entry.author_url ? (
                  <a
                    href={entry.author_url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="hover:text-primary transition-colors"
                    onClick={(e) => e.stopPropagation()}
                  >
                    {entry.author}
                  </a>
                ) : entry.author}
              </p>
            )}
          </div>
          <div className="shrink-0">{renderAction()}</div>
        </div>
        {/* "Add another" lives here (full-width footer) rather than next to the
            "Connected" pill, so it never crowds/truncates the card title. */}
        {entry.connected && entry.addable !== false && (
          <button
            onClick={(e) => { e.stopPropagation(); onAddAnother(); }}
            disabled={adding}
            className="mt-2 text-[11px] font-medium text-primary hover:underline disabled:opacity-50 transition-colors"
          >
            {adding ? t.browseDirectory.adding : t.browseDirectory.addAnother}
          </button>
        )}
      </div>
    </div>
  );
}

// ── Skill section ────────────────────────────────────────────

const SKILL_CATEGORY_COLORS: Record<string, string> = {
  productivity: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
  communication: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
  research: "bg-purple-500/10 text-purple-400 border-purple-500/20",
  custom: "bg-orange-500/10 text-orange-400 border-orange-500/20",
};

function SkillSection({ title, skills }: { title: string; skills: SkillCatalogEntry[] }) {
  const t = useT();
  return (
    <div>
      <h3 className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-3">{title}</h3>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {skills.map((skill) => (
          <div key={skill.id} className="flex items-start gap-3 border border-border rounded-xl p-4 hover:bg-muted/20 transition-colors">
            <div className="w-9 h-9 rounded-lg bg-muted flex items-center justify-center shrink-0 mt-0.5">
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" className="text-primary">
                <path d="M10 2l2.09 6.26H18l-4.77 3.48L15.18 18 10 14.27 4.82 18l1.95-6.26L2 8.26h5.91z" />
              </svg>
            </div>
            <div className="flex-1 min-w-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium truncate">{skill.name}</span>
                    {skill.category !== "custom" && (
                      <span className={`text-[9px] font-medium px-1.5 py-0.5 rounded-full border ${SKILL_CATEGORY_COLORS[skill.category] ?? SKILL_CATEGORY_COLORS.custom}`}>
                        {skill.category}
                      </span>
                    )}
                  </div>
                  <p className="text-[11px] text-muted-foreground mt-0.5 line-clamp-2">{skill.description}</p>
                  {skill.requiresConnectors.length > 0 && (
                    <p className="text-[10px] text-muted-foreground/60 mt-1">{t.browseDirectory.requiresPrefix} {skill.requiresConnectors.join(", ")}</p>
                  )}
                </div>
                <span className="shrink-0 text-[10px] font-medium text-primary bg-primary/10 px-2 py-0.5 rounded-full mt-0.5">
                  {t.browseDirectory.availableBadge}
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground/60 mt-3">
        {t.browseDirectory.skillsByDefault}
      </p>
    </div>
  );
}
