"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, useParams } from "next/navigation";
import { authFetch } from "@/lib/auth-fetch";
import { ScrollableNav } from "@/components/scrollable-nav";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { useWorkspaces } from "@/contexts/workspace-context";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { getCachedAssistants, setCachedAssistants } from "@/lib/sidebar-cache";
import { KnowledgeTab } from "@/components/knowledge-tab";
import { NetworkTab } from "@/components/network-tab";
import { ApiKeysTab } from "@/components/api-keys-tab";
import { SensitivityBadge, type Sensitivity } from "@/components/sensitivity-badge";
import { ConnectorIcon } from "@/components/connectors/connector-icon";
import { type ToolPolicy } from "@/components/connectors/connector-tool-list";
import { ConnectorToolGovernance } from "@/components/connectors/connector-tool-governance";
import { RecordingUploadButton } from "@/components/recordings/recording-upload-button";
import { useT } from "@/lib/i18n/client";
import type { Dictionary } from "@/lib/i18n";
import { format } from "@/lib/i18n";

/**
 * Assistant detail (app-web) — the tabbed editor for one assistant.
 *
 * Ported from `apps/web/src/components/studio/assistant-detail.tsx`
 * (app consolidation §9 #5). Rendered inline by the Studio -> Assistants
 * master-detail page
 * (apps/app-web/src/app/w/[workspaceId]/studio/assistants/page.tsx).
 * Takes the assistant `id` as a prop; the parent owns selection + the rail.
 *
 * Tab consolidation:
 *   Brain     = memory + knowledge
 *   Tools     = connectors (MCP tool catalog) + skills
 *   Network   = connections, data sharing config, modes
 *   Api       = programmatic API keys
 *   Settings  = name, prompt, team, cost, delete
 *
 * Channels are workspace-owned and live entirely on Studio -> Channels;
 * there is no per-assistant channels surface here.
 *
 * app-web deltas vs apps/web:
 *   - Routes are workspace-scoped: in-app links to Studio sub-sections and
 *     Brain go through `/w/[workspaceId]/...`, derived from `useParams`.
 *   - All else (data fetches, tab structure, optimistic cache writes) is a
 *     faithful copy.
 *
 * [COMP:app-web/assistant-detail] — see docs/architecture/features/assistant-detail-page.md
 */

type Tab = "brain" | "tools" | "network" | "api" | "settings";

function buildTabs(t: Dictionary): { id: Tab; label: string }[] {
  return [
    { id: "brain", label: t.manage.tabs.brain },
    { id: "tools", label: t.manage.tabs.tools },
    { id: "network", label: t.manage.tabs.network },
    { id: "api", label: t.manage.tabs.api },
    { id: "settings", label: t.manage.tabs.settings },
  ];
}

export function AssistantDetail({
  id,
  onWorkspaceChanged,
}: {
  id: string;
  // Fired when the assistant's workspace association changes (adopt /
  // remove from workspace via the Settings tab). The studio rail is
  // workspace-scoped, so it uses this to drop the row when the assistant
  // leaves the active workspace.
  onWorkspaceChanged?: (assistantId: string, workspaceId: string | null) => void;
}) {
  const t = useT();
  const TABS = buildTabs(t);
  const searchParams = useSearchParams();

  const VALID_TABS = ["brain", "tools", "network", "api", "settings"];
  const TAB_CACHE_KEY = `assistant-tab-${id}`;

  const [tab, setTabRaw] = useState<Tab>(() => {
    // Priority: URL param > localStorage > default
    const t = searchParams.get("tab");
    if (t && VALID_TABS.includes(t)) return t as Tab;
    if (typeof window !== "undefined") {
      const cached = localStorage.getItem(TAB_CACHE_KEY);
      if (cached && VALID_TABS.includes(cached)) return cached as Tab;
    }
    return "brain";
  });

  function setTab(t: Tab) {
    setTabRaw(t);
    try { localStorage.setItem(TAB_CACHE_KEY, t); } catch {}
  }
  const [assistant, setAssistant] = useState<{
    id: string;
    name: string;
    role: string;
    iconSeed?: number;
    workspaceId?: string | null;
    clearance?: Sensitivity;
    kind?: "standard" | "app" | "primary";
  } | null>(null);
  const [workspaceName, setTeamName] = useState<string | null>(null);
  // Caller's role on the assistant's workspace. Mirrors the API auth
  // model: a workspace admin/owner may edit clearance even when they
  // don't own the assistant. See packages/api/src/routes/assistants.ts
  // PATCH handler and docs/architecture/platform/sensitivity.md.
  const [workspaceRole, setWorkspaceRole] = useState<string | null>(null);
  const [clearanceFeedback, setClearanceFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [savingClearance, setSavingClearance] = useState(false);

  // Fetch assistant data. The assistant list rail is owned by the
  // Studio page — this component only needs the current assistant.
  useEffect(() => {
    // Resolve immediately from sidebar cache to avoid loading flash
    const cached = getCachedAssistants();
    if (cached.length > 0) {
      const match = cached.find((a) => a.id === id);
      if (match) setAssistant(match);
    }

    authFetch(`${API_URL}/api/assistants`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { assistants?: { id: string; name: string; role: string; iconSeed?: number; description?: string | null; memoryCount?: number; workspaceId?: string | null; clearance?: Sensitivity; kind?: "standard" | "app" | "primary" }[] } | null) => {
        if (!data?.assistants?.length) return;
        setCachedAssistants(data.assistants as import("@/lib/sidebar-cache").Assistant[]);
        const match = data.assistants.find((a) => a.id === id);
        if (match) {
          setAssistant(match);
          // Fetch workspace name + caller's workspace role on the same
          // round-trip; role is what gates the header clearance editor for
          // non-owners.
          if (match.workspaceId) {
            authFetch(`${API_URL}/api/workspaces/${match.workspaceId}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((wsp: { name?: string; role?: string } | null) => {
                if (wsp?.name) setTeamName(wsp.name);
                if (wsp?.role) setWorkspaceRole(wsp.role);
              })
              .catch(() => {});
          }
        }
      })
      .catch(() => {});
  }, [id]);

  async function handleSetClearance(next: Sensitivity) {
    if (!assistant) return;
    const prev = assistant.clearance;
    if (prev === next) return;
    setSavingClearance(true);
    setAssistant({ ...assistant, clearance: next });
    // Optimistically update the sidebar cache so the Studio rail badge
    // flips immediately. Mirrors the icon-regenerate handler above.
    const cached = getCachedAssistants();
    setCachedAssistants(cached.map((a) => (a.id === id ? { ...a, clearance: next } : a)));
    try {
      const res = await authFetch(`${API_URL}/api/assistants/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clearance: next }),
      });
      if (!res.ok) {
        setAssistant((a) => (a ? { ...a, clearance: prev } : a));
        const rolledBack = getCachedAssistants();
        setCachedAssistants(rolledBack.map((a) => (a.id === id ? { ...a, clearance: prev } : a)));
        const err = await res.json().catch(() => ({ error: "" }));
        setClearanceFeedback({
          type: "error",
          message: (err as { error?: string }).error || t.assistant.clearanceSelector.failed,
        });
      } else {
        setClearanceFeedback({
          type: "success",
          message: format(t.assistant.clearanceSelector.saved, { tier: t.manage.sensitivity[next] }),
        });
      }
    } catch {
      setAssistant((a) => (a ? { ...a, clearance: prev } : a));
      const rolledBack = getCachedAssistants();
      setCachedAssistants(rolledBack.map((a) => (a.id === id ? { ...a, clearance: prev } : a)));
      setClearanceFeedback({ type: "error", message: t.assistant.clearanceSelector.networkError });
    } finally {
      setSavingClearance(false);
      setTimeout(() => setClearanceFeedback(null), 2500);
    }
  }

  if (!assistant) {
    return (
      <div className="text-[13px] text-muted-foreground py-10 text-center">
        {t.assistant.detailWrapper.loading}
      </div>
    );
  }

  return (
    <div className="space-y-6 md:space-y-8 w-full">
        {/* Header */}
        <div className="flex items-start gap-4">
          <button
            type="button"
            title={t.assistant.detailWrapper.randomizeIconTitle}
            className="relative group cursor-pointer"
            onClick={async () => {
              try {
                const res = await authFetch(`${API_URL}/api/assistants/${id}/regenerate-icon`, { method: "POST" });
                if (res.ok) {
                  const data = await res.json();
                  setAssistant((a) => a ? { ...a, iconSeed: data.iconSeed } : a);
                  // Update sidebar cache — triggers subscribers in layout + AppSidebar
                  const cached = getCachedAssistants();
                  setCachedAssistants(cached.map((a) => a.id === id ? { ...a, iconSeed: data.iconSeed } : a));
                }
              } catch {}
            }}
          >
            <AssistantAvatar id={assistant.id} name={assistant.name} iconSeed={assistant.iconSeed} size="lg" />
            <div className="absolute inset-0 bg-black/40 rounded-[10px] opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
              </svg>
            </div>
          </button>
          <div className="min-w-0 flex-1">
            <h1 className="text-2xl font-semibold tracking-tight">{assistant.name}</h1>
            <div className="text-[13px] text-muted-foreground mt-1 flex items-center gap-2 flex-wrap">
              {workspaceName && assistant.workspaceId && (
                <span className="inline-flex items-center gap-1 text-[11px] bg-primary/10 text-primary px-2 py-0.5 rounded-full">
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="6" cy="6" r="3" />
                    <circle cx="12" cy="8" r="2.5" />
                    <path d="M1 14c0-2.5 2-4 5-4s5 1.5 5 4" />
                  </svg>
                  {workspaceName}
                </span>
              )}
              {/* Sensitivity is a cross-assistant isolation tool — only meaningful
                  for team-scoped assistants, so we group it with the team badge.
                  Editable inline for assistant owners + workspace admins/owners;
                  everyone else sees the read-only badge. Mirrors the API auth
                  model in packages/api/src/routes/assistants.ts. */}
              {assistant.clearance && assistant.workspaceId && (
                assistant.role === "owner" || workspaceRole === "owner" || workspaceRole === "admin" ? (
                  <Select
                    value={assistant.clearance}
                    onValueChange={(v) => handleSetClearance(v as Sensitivity)}
                    disabled={savingClearance}
                  >
                    <SelectTrigger
                      size="sm"
                      aria-label={t.assistant.clearanceSelector.ariaLabel}
                      className="h-6 w-auto gap-1 border-transparent bg-transparent px-1 py-0 text-[11px] hover:bg-muted/50"
                    >
                      <SelectValue>
                        <SensitivityBadge tier={assistant.clearance} size="xs" />
                      </SelectValue>
                    </SelectTrigger>
                    <SelectContent align="start">
                      <SelectItem value="public"><SensitivityBadge tier="public" size="xs" /></SelectItem>
                      <SelectItem value="internal"><SensitivityBadge tier="internal" size="xs" /></SelectItem>
                      <SelectItem value="confidential"><SensitivityBadge tier="confidential" size="xs" /></SelectItem>
                    </SelectContent>
                  </Select>
                ) : (
                  <SensitivityBadge tier={assistant.clearance} size="xs" />
                )
              )}
              {clearanceFeedback && (
                <span
                  className={`text-[11px] ${
                    clearanceFeedback.type === "success" ? "text-emerald-600 dark:text-emerald-400" : "text-destructive"
                  }`}
                >
                  {clearanceFeedback.message}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Tab nav — scrollable on mobile with arrow indicators */}
        <div className="border-b border-border">
          <ScrollableNav>
            <div className="flex gap-1">
              {TABS.map((t) => (
                <button
                  key={t.id}
                onClick={() => setTab(t.id)}
                className={`px-4 py-2.5 text-[13px] font-medium border-b-2 -mb-px transition-colors duration-150 whitespace-nowrap ${
                  tab === t.id
                    ? "border-primary text-primary"
                    : "border-transparent text-muted-foreground hover:text-foreground"
                }`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </ScrollableNav>
      </div>

      {/* Tab content */}
      <div>
        {tab === "brain" && (
          <BrainTab assistantId={id} workspaceId={assistant.workspaceId ?? null} />
        )}
        {tab === "tools" && <ConnectorsTab assistantId={id} workspaceId={assistant.workspaceId ?? null} />}
        {tab === "network" && <NetworkTab assistantId={id} workspaceId={assistant.workspaceId ?? null} />}
        {tab === "api" && <ApiKeysTab assistantId={id} />}
        {tab === "settings" && (
          <SettingsTab
            assistantId={id}
            role={assistant.role}
            kind={assistant.kind}
            assistantName={assistant.name}
            workspaceId={assistant.workspaceId ?? null}
            onRenamed={(name) => setAssistant((a) => a ? { ...a, name } : a)}
            onTeamChanged={(newTeamId, newTeamName) => {
              setAssistant((a) => a ? { ...a, workspaceId: newTeamId } : a);
              setTeamName(newTeamName);
              onWorkspaceChanged?.(id, newTeamId);
            }}
          />
        )}
      </div>
    </div>
  );
}

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// ─── Channels tab — removed ────────────────────────────────────
//
// Channels are workspace-owned and managed entirely on Studio →
// Channels (apps/web/src/app/(app)/studio/channels/page.tsx).
// Previously this file rendered a per-assistant channels surface
// (connect / disconnect / model alias / setup wizards); that
// duplicated the workspace surface and is gone. Deep links into the
// old `?tab=channels` URL fall through to the new default ("brain").


// ─── Memory tab ─────────────────────────────────────────────────

type MemoryType = "identity" | "preference" | "context" | "connection";
type MemoryItem = {
  id: string;
  type: MemoryType;
  scope: string;
  summary: string;
  detail: string | null;
  tags: string[];
  confidence: number;
  recallCount: number;
  usefulRecallCount: number;
  lastRecalledAt: string | null;
  createdAt: string;
  updatedAt: string;
};
type MemoryStats = {
  total: number;
  totalRecalls: number;
};

const TYPE_COLORS: Record<MemoryType, string> = {
  identity: "bg-blue-500/15 text-blue-600 dark:text-blue-400",
  preference: "bg-purple-500/15 text-purple-400",
  context: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  connection: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
};

// ─── Brain tab (Memory + Knowledge sub-tabs) ─────────────────────

function BrainTab({ assistantId, workspaceId }: { assistantId: string; workspaceId: string | null }) {
  const t = useT();
  const [subTab, setSubTab] = useState<"memory" | "knowledge">("memory");

  return (
    <div className="space-y-6">
      <div className="flex gap-1 border-b border-border pb-2">
        {(["memory", "knowledge"] as const).map((sub) => (
          <button
            key={sub}
            onClick={() => setSubTab(sub)}
            className={`text-sm px-3 py-1.5 rounded-lg transition-colors ${
              subTab === sub ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {sub === "memory" ? t.assistant.brainTab.subTabMemory : t.assistant.brainTab.subTabKnowledge}
          </button>
        ))}
      </div>

      {workspaceId ? (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-muted/30 p-3">
          <div className="min-w-0">
            <p className="text-sm text-muted-foreground">{t.recordings.uploadHint}</p>
            {/* The board's entry point. Upload is the only place a user thinks
                about recordings, so "where did mine go?" is answered here
                rather than from a nav row the panel deliberately has no slot
                for. Panels open under the doc shell (`/p?panel=…`), so the tab
                strip and chat dock persist around it. */}
            <Link
              href={`/w/${workspaceId}/p?panel=recordings`}
              className="mt-1 inline-block text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              {t.recordings.viewAllLink}
            </Link>
          </div>
          <RecordingUploadButton workspaceId={workspaceId} assistantId={assistantId} />
        </div>
      ) : null}

      {subTab === "memory" ? (
        <MemoryTab assistantId={assistantId} workspaceId={workspaceId} />
      ) : (
        <KnowledgeTab assistantId={assistantId} workspaceId={workspaceId} />
      )}
    </div>
  );
}

// ─── Memory tab ───────────────────────────────────────────────────

function MemoryTab({ assistantId, workspaceId }: { assistantId: string; workspaceId: string | null }) {
  const t = useT();
  const typeLabel = (type: MemoryType): string => {
    switch (type) {
      case "identity": return t.assistant.brainTab.typeIdentity;
      case "preference": return t.assistant.brainTab.typePreference;
      case "context": return t.assistant.brainTab.typeContext;
      case "connection": return t.assistant.brainTab.typeConnection;
      default: return type;
    }
  };
  const [memories, setMemories] = useState<MemoryItem[]>([]);
  const [stats, setStats] = useState<MemoryStats | null>(null);
  const [soul, setSoul] = useState<string | null>(null);
  const [total, setTotal] = useState(0);
  // Team memories
  const [teamMemories, setTeamMemories] = useState<MemoryItem[]>([]);
  const [teamTotal, setTeamTotal] = useState(0);
  const [teamOffset, setTeamOffset] = useState(0);
  const [teamLoading, setTeamLoading] = useState(false);
  const [showTeam, setShowTeam] = useState(true);
  const [offset, setOffset] = useState(0);
  const [typeFilter, setTypeFilter] = useState<string>("");
  const [searchQuery, setSearchQuery] = useState("");
  const [isSearching, setIsSearching] = useState(false);
  const [selected, setSelected] = useState<MemoryItem | null>(null);
  const [editing, setEditing] = useState(false);
  const [editSummary, setEditSummary] = useState("");
  const [editDetail, setEditDetail] = useState("");
  const [editTags, setEditTags] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useRef<HTMLDivElement>(null);
  const LIMIT = 20;

  // Close dropdown on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (filterRef.current && !filterRef.current.contains(e.target as Node)) {
        setFilterOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  // Fetch memories list
  const fetchMemories = async (newOffset = 0, type = typeFilter) => {
    setLoading(true);
    const params = new URLSearchParams({
      limit: String(LIMIT),
      offset: String(newOffset),
    });
    if (type) params.set("type", type);

    try {
      const res = await authFetch(
        `${API_URL}/api/assistants/${assistantId}/memories?${params}`
      );
      if (res.ok) {
        const data = await res.json();
        setMemories(data.memories);
        setTotal(data.total);
        setOffset(newOffset);
      }
    } catch {
      // silently fail
    } finally {
      setLoading(false);
    }
  };

  // Debounced search on typing
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const debouncedSearch = useCallback(
    (q: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(async () => {
        if (!q.trim()) {
          setIsSearching(false);
          fetchMemories(0);
          return;
        }
        setLoading(true);
        setIsSearching(true);
        try {
          const res = await authFetch(
            `${API_URL}/api/assistants/${assistantId}/memories/search?q=${encodeURIComponent(q.trim())}`
          );
          if (res.ok) {
            const data = await res.json();
            setMemories(data.memories);
            setTotal(data.memories.length);
            setOffset(0);
          }
        } catch {
          // silently fail
        } finally {
          setLoading(false);
        }
      }, 300);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [assistantId],
  );

  // Fetch stats + soul + initial list
  useEffect(() => {
    fetchMemories(0);
    authFetch(`${API_URL}/api/assistants/${assistantId}/memories/stats`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setStats(data); })
      .catch(() => {});
    authFetch(`${API_URL}/api/assistants/${assistantId}/memories/soul`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (data) setSoul(data.soul); })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [assistantId]);

  // Fetch team memories
  const fetchTeamMemories = useCallback((newOffset = 0) => {
    if (!workspaceId) return;
    setTeamLoading(true);
    authFetch(
      `${API_URL}/api/assistants/${assistantId}/memories/team?limit=20&offset=${newOffset}`
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { memories?: MemoryItem[]; total?: number } | null) => {
        if (data?.memories) setTeamMemories(data.memories);
        if (data?.total !== undefined) setTeamTotal(data.total);
        setTeamOffset(newOffset);
      })
      .catch(() => {})
      .finally(() => setTeamLoading(false));
  }, [assistantId, workspaceId]);

  useEffect(() => {
    if (workspaceId) fetchTeamMemories(0);
  }, [workspaceId, fetchTeamMemories]);

  // Save edits
  const handleSave = async () => {
    if (!selected) return;
    setSaving(true);
    try {
      const res = await authFetch(
        `${API_URL}/api/assistants/${assistantId}/memories/${selected.id}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: editSummary,
            detail: editDetail || null,
            tags: editTags
              .split(",")
              .map((t) => t.trim())
              .filter(Boolean),
          }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        setSelected(data.memory);
        setEditing(false);
        fetchMemories(offset);
      }
    } catch {
      // silently fail
    } finally {
      setSaving(false);
    }
  };

  // Promote personal memory to team / demote team memory back to personal.
  // Assumes the caller already checked the right button is shown; the API
  // enforces the real rules (writer-only, team-member, team assistant).
  const [scopeChanging, setScopeChanging] = useState(false);
  const handleScopeChange = async (target: "team" | "user") => {
    if (!selected) return;
    setScopeChanging(true);
    try {
      const res = await authFetch(
        `${API_URL}/api/assistants/${assistantId}/memories/${selected.id}/scope`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ scope: target }),
        }
      );
      if (res.ok) {
        const data = await res.json();
        setSelected(data.memory);
        fetchMemories(offset);
        if (workspaceId) fetchTeamMemories(teamOffset);
      }
    } catch {
      // silently fail
    } finally {
      setScopeChanging(false);
    }
  };

  // Delete
  const handleDelete = async (memoryId: string) => {
    try {
      const res = await authFetch(
        `${API_URL}/api/assistants/${assistantId}/memories/${memoryId}`,
        { method: "DELETE" }
      );
      if (res.ok || res.status === 204) {
        setSelected(null);
        fetchMemories(offset);
        // Refresh stats
        authFetch(`${API_URL}/api/assistants/${assistantId}/memories/stats`)
          .then((r) => (r.ok ? r.json() : null))
          .then((data) => { if (data) setStats(data); })
          .catch(() => {});
      }
    } catch {
      // silently fail
    }
  };

  const openDetail = (m: MemoryItem) => {
    if (selected?.id === m.id) {
      setSelected(null);
      setEditing(false);
      return;
    }
    setSelected(m);
    setEditing(false);
    setEditSummary(m.summary);
    setEditDetail(m.detail ?? "");
    setEditTags(m.tags.join(", "));
  };

  const startEdit = () => {
    if (!selected) return;
    setEditSummary(selected.summary);
    setEditDetail(selected.detail ?? "");
    setEditTags(selected.tags.join(", "));
    setEditing(true);
  };

  const totalPages = Math.ceil(total / LIMIT);
  const currentPage = Math.floor(offset / LIMIT) + 1;

  return (
    <div className="space-y-6">
      {/* Stats bar */}
      {stats && stats.total > 0 && (
        <div className="flex items-center gap-6 text-[13px]">
          <div className="text-muted-foreground">
            <span className="text-foreground font-semibold">{stats.total}</span> {t.assistant.brainTab.statsMemories}
          </div>
          <div className="text-muted-foreground">
            <span className="text-foreground font-semibold">{stats.totalRecalls}</span> {t.assistant.brainTab.statsTotalRecalls}
          </div>
        </div>
      )}

      {/* SOUL display */}
      {soul && (
        <Section
          title={t.assistant.brainTab.soulTitle}
          description={t.assistant.brainTab.soulDesc}
        >
          <div className="px-5 py-4 text-[13px] text-foreground/80 whitespace-pre-wrap leading-relaxed">
            {soul}
          </div>
        </Section>
      )}

      {/* Search + filters */}
      <div className="flex items-center gap-3">
        <div className="flex-1 relative">
          <input
            type="text"
            placeholder={t.assistant.brainTab.searchPlaceholder}
            value={searchQuery}
            onChange={(e) => {
              setSearchQuery(e.target.value);
              debouncedSearch(e.target.value);
            }}
            className="w-full h-9 px-3 text-[13px] bg-secondary/50 border border-border rounded-lg text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          {isSearching && (
            <button
              onClick={() => {
                if (debounceRef.current) clearTimeout(debounceRef.current);
                setSearchQuery("");
                setIsSearching(false);
                fetchMemories(0);
              }}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-[11px] text-muted-foreground hover:text-foreground"
            >
              {t.assistant.brainTab.clear}
            </button>
          )}
        </div>
        <div className="relative" ref={filterRef}>
          <button
            type="button"
            onClick={() => setFilterOpen(!filterOpen)}
            className="h-9 px-3 text-[13px] bg-secondary/50 border border-border rounded-lg text-foreground hover:bg-muted/40 transition-colors flex items-center gap-2"
          >
            {typeFilter ? typeLabel(typeFilter as MemoryType) : t.assistant.brainTab.allTypes}
            <svg
              width="12"
              height="12"
              viewBox="0 0 14 14"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`transition-transform duration-150 ${filterOpen ? "rotate-180" : ""}`}
            >
              <path d="M3.5 5.5L7 9l3.5-3.5" />
            </svg>
          </button>
          <div
            className={`absolute right-0 top-full mt-1 z-10 min-w-[140px] rounded-lg border border-border bg-background shadow-lg transition-[opacity,transform] duration-150 origin-top ${
              filterOpen
                ? "opacity-100 scale-100"
                : "opacity-0 scale-95 pointer-events-none"
            }`}
          >
            {[
              { value: "", label: t.assistant.brainTab.allTypes },
              { value: "identity", label: t.assistant.brainTab.typeIdentity },
              { value: "preference", label: t.assistant.brainTab.typePreference },
              { value: "context", label: t.assistant.brainTab.typeContext },
              { value: "connection", label: t.assistant.brainTab.typeConnection },
            ].map((opt) => (
              <button
                key={opt.value}
                type="button"
                onClick={() => {
                  setTypeFilter(opt.value);
                  setFilterOpen(false);
                  setIsSearching(false);
                  setSearchQuery("");
                  if (debounceRef.current) clearTimeout(debounceRef.current);
                  fetchMemories(0, opt.value);
                }}
                className={`w-full text-left px-3 py-2 text-[13px] transition-colors first:rounded-t-lg last:rounded-b-lg ${
                  typeFilter === opt.value
                    ? "text-primary bg-primary/10"
                    : "text-foreground hover:bg-muted/40"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Memory list */}
      {loading && memories.length === 0 ? (
        <div className="text-[13px] text-muted-foreground py-10 text-center">
          {t.assistant.brainTab.loadingMemories}
        </div>
      ) : memories.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border p-10 text-center">
          <div className="text-sm text-foreground font-medium">
            {isSearching ? t.assistant.brainTab.noResults : t.assistant.brainTab.noMemoriesYet}
          </div>
          <div className="text-[13px] text-muted-foreground mt-1.5 max-w-md mx-auto">
            {isSearching
              ? t.assistant.brainTab.noResultsDesc
              : t.assistant.brainTab.noMemoriesDesc}
          </div>
        </div>
      ) : (
        <>
          <div className="rounded-xl border border-border overflow-hidden">
            {memories.map((m, i) => {
              const isSelected = selected?.id === m.id;
              return (
                <div key={m.id} className="min-w-0">
                  <button
                    type="button"
                    onClick={() => openDetail(m)}
                    className={`w-full text-left flex items-start gap-3 px-5 py-3.5 transition-colors hover:bg-muted/40 ${
                      i < memories.length - 1 && !isSelected ? "border-b border-border" : ""
                    } ${isSelected ? "bg-muted/30" : ""}`}
                  >
                    <span
                      className={`mt-0.5 px-1.5 py-0.5 rounded text-[11px] font-medium shrink-0 ${
                        TYPE_COLORS[m.type as MemoryType] ?? "bg-muted text-muted-foreground"
                      }`}
                    >
                      {typeLabel(m.type as MemoryType)}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] text-foreground truncate">
                        {m.summary}
                      </div>
                      {m.tags.length > 0 && (
                        <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                          {m.tags.join(", ")}
                        </div>
                      )}
                    </div>
                    <div className="text-[11px] text-muted-foreground shrink-0 mt-0.5 flex items-center gap-2">
                      {m.recallCount > 0 && (() => {
                        const rate = (m.usefulRecallCount ?? 0) / m.recallCount;
                        const color = rate >= 0.5 ? "bg-emerald-500" : rate > 0 ? "bg-amber-500" : "bg-muted-foreground/30";
                        return (
                          <span
                            title={format(t.assistant.brainTab.recallTooltip, { count: m.recallCount, rate: Math.round(rate * 100) })}
                            className={`inline-block w-2 h-2 rounded-full shrink-0 ${color}`}
                          />
                        );
                      })()}
                      <span>{new Date(m.updatedAt).toLocaleDateString()}</span>
                    </div>
                  </button>
                  {/* Inline detail expand */}
                  <div
                    className={`grid transition-[grid-template-rows,opacity] duration-200 ease-in-out ${
                      isSelected
                        ? "grid-rows-[1fr] opacity-100"
                        : "grid-rows-[0fr] opacity-0"
                    }`}
                  >
                    <div className="overflow-hidden">
                      {isSelected && selected && (
                        <div className={`bg-muted/20 ${i < memories.length - 1 ? "border-b border-border" : ""}`}>
                          <div className="flex items-center justify-between px-5 py-2.5">
                            <span className="text-[11px] text-muted-foreground">
                              {format(t.assistant.brainTab.scopeAndConfidence, { scope: selected.scope, percent: Math.round(selected.confidence * 100) })}
                            </span>
                            <div className="flex items-center gap-2">
                              {!editing && (
                                <>
                                  <button
                                    onClick={(e) => { e.stopPropagation(); startEdit(); }}
                                    className="text-[12px] font-medium px-3 py-1 rounded-lg border border-border text-foreground hover:bg-muted/40 transition-colors"
                                  >
                                    {t.assistant.brainTab.edit}
                                  </button>
                                  {workspaceId && selected.scope !== "team" && (
                                    <button
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        if (await confirmDialog({
                                          title: t.assistant.brainTab.promoteTitle,
                                          description: t.assistant.brainTab.promoteDesc,
                                          confirmLabel: t.assistant.brainTab.promoteConfirm,
                                        })) {
                                          handleScopeChange("team");
                                        }
                                      }}
                                      disabled={scopeChanging}
                                      className="text-[12px] font-medium px-3 py-1 rounded-lg border border-emerald-500/30 text-emerald-600 dark:text-emerald-400 hover:bg-emerald-500/10 transition-colors disabled:opacity-50"
                                    >
                                      {scopeChanging ? t.assistant.brainTab.promoting : t.assistant.brainTab.promoteToTeam}
                                    </button>
                                  )}
                                  {workspaceId && selected.scope === "team" && (
                                    <button
                                      onClick={async (e) => {
                                        e.stopPropagation();
                                        if (await confirmDialog({
                                          title: t.assistant.brainTab.makePersonalTitle,
                                          description: t.assistant.brainTab.makePersonalDesc,
                                          confirmLabel: t.assistant.brainTab.makePersonalConfirm,
                                        })) {
                                          handleScopeChange("user");
                                        }
                                      }}
                                      disabled={scopeChanging}
                                      className="text-[12px] font-medium px-3 py-1 rounded-lg border border-border text-foreground hover:bg-muted/40 transition-colors disabled:opacity-50"
                                    >
                                      {scopeChanging ? t.assistant.brainTab.updating : t.assistant.brainTab.makePersonal}
                                    </button>
                                  )}
                                  <button
                                    onClick={async (e) => {
                                      e.stopPropagation();
                                      if (await confirmDialog({
                                        title: t.assistant.brainTab.deleteTitle,
                                        description: t.assistant.brainTab.deleteDesc,
                                        confirmLabel: t.assistant.brainTab.deleteConfirm,
                                        variant: "destructive",
                                      })) {
                                        handleDelete(selected.id);
                                      }
                                    }}
                                    className="text-[12px] font-medium px-3 py-1 rounded-lg border border-destructive/30 text-destructive hover:bg-destructive/10 transition-colors"
                                  >
                                    {t.assistant.brainTab.delete}
                                  </button>
                                </>
                              )}
                              <button
                                onClick={(e) => { e.stopPropagation(); setSelected(null); }}
                                className="text-[12px] text-muted-foreground hover:text-foreground ml-1"
                              >
                                {t.assistant.brainTab.close}
                              </button>
                            </div>
                          </div>

                          {/* View mode */}
                          {!editing && (
                            <div className="px-5 pb-4 space-y-3">
                              <div>
                                <div className="text-[11px] text-muted-foreground uppercase tracking-wider font-medium mb-1">
                                  {t.assistant.brainTab.summary}
                                </div>
                                <div className="text-[13px] text-foreground">
                                  {selected.summary}
                                </div>
                              </div>
                              {selected.detail && (
                                <div>
                                  <div className="text-[11px] text-muted-foreground uppercase tracking-wider font-medium mb-1">
                                    {t.assistant.brainTab.detail}
                                  </div>
                                  <div className="text-[13px] text-foreground/80 whitespace-pre-wrap leading-relaxed">
                                    {selected.detail}
                                  </div>
                                </div>
                              )}
                              {selected.tags.length > 0 && (
                                <div>
                                  <div className="text-[11px] text-muted-foreground uppercase tracking-wider font-medium mb-1">
                                    {t.assistant.brainTab.tags}
                                  </div>
                                  <div className="flex flex-wrap gap-1.5">
                                    {selected.tags.map((tag) => (
                                      <span
                                        key={tag}
                                        className="px-2 py-0.5 rounded-md bg-muted text-[11px] text-muted-foreground"
                                      >
                                        {tag}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              )}
                              <div className="flex items-center gap-4 text-[11px] text-muted-foreground pt-1">
                                <span>{format(t.assistant.brainTab.created, { date: new Date(selected.createdAt).toLocaleDateString() })}</span>
                                <span>{format(t.assistant.brainTab.updated, { date: new Date(selected.updatedAt).toLocaleDateString() })}</span>
                                {selected.recallCount > 0 && (
                                  <>
                                    <span>{format(t.assistant.brainTab.recalledTimes, { count: selected.recallCount })}</span>
                                    <span>{format(t.assistant.brainTab.usefulPercent, { percent: Math.round(((selected.usefulRecallCount ?? 0) / selected.recallCount) * 100) })}</span>
                                  </>
                                )}
                              </div>
                            </div>
                          )}

                          {/* Edit mode */}
                          {editing && (
                            <div className="px-5 pb-4 space-y-4">
                              <div>
                                <label className="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">
                                  {t.assistant.brainTab.summary}
                                </label>
                                <input
                                  type="text"
                                  value={editSummary}
                                  onChange={(e) => setEditSummary(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  className="mt-1 w-full h-9 px-3 text-[13px] bg-secondary/50 border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </div>
                              <div>
                                <label className="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">
                                  {t.assistant.brainTab.detail}
                                </label>
                                <textarea
                                  value={editDetail}
                                  onChange={(e) => setEditDetail(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  rows={4}
                                  className="mt-1 w-full px-3 py-2 text-[13px] bg-secondary/50 border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-primary resize-none"
                                />
                              </div>
                              <div>
                                <label className="text-[11px] text-muted-foreground uppercase tracking-wider font-medium">
                                  {t.assistant.brainTab.tagsCommaSeparated}
                                </label>
                                <input
                                  type="text"
                                  value={editTags}
                                  onChange={(e) => setEditTags(e.target.value)}
                                  onClick={(e) => e.stopPropagation()}
                                  className="mt-1 w-full h-9 px-3 text-[13px] bg-secondary/50 border border-border rounded-lg text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                                />
                              </div>
                              <div className="flex items-center gap-2 pt-1">
                                <button
                                  onClick={(e) => { e.stopPropagation(); handleSave(); }}
                                  disabled={saving}
                                  className="text-[12px] font-medium px-4 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 transition-colors disabled:opacity-50"
                                >
                                  {saving ? t.assistant.brainTab.saving : t.assistant.brainTab.save}
                                </button>
                                <button
                                  onClick={(e) => { e.stopPropagation(); setEditing(false); }}
                                  className="text-[12px] font-medium px-3 py-1.5 rounded-lg border border-border text-foreground hover:bg-muted/40 transition-colors"
                                >
                                  {t.assistant.brainTab.cancel}
                                </button>
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Pagination */}
          {!isSearching && totalPages > 1 && (
            <div className="flex items-center justify-between text-[13px]">
              <button
                onClick={() => fetchMemories(offset - LIMIT)}
                disabled={offset === 0}
                className="px-3 py-1.5 rounded-lg border border-border text-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/40 transition-colors"
              >
                {t.assistant.brainTab.previous}
              </button>
              <span className="text-muted-foreground">
                {format(t.assistant.brainTab.pageOf, { current: currentPage, total: totalPages })}
              </span>
              <button
                onClick={() => fetchMemories(offset + LIMIT)}
                disabled={offset + LIMIT >= total}
                className="px-3 py-1.5 rounded-lg border border-border text-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/40 transition-colors"
              >
                {t.assistant.brainTab.next}
              </button>
            </div>
          )}
        </>
      )}

      {/* Team memories section */}
      {workspaceId && (
        <div className="mt-8 border-t border-border pt-6">
          <button
            onClick={() => setShowTeam(!showTeam)}
            className="flex items-center gap-2 text-sm font-medium mb-4"
          >
            <svg
              className={`w-4 h-4 text-muted-foreground transition-transform ${showTeam ? "rotate-180" : ""}`}
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
            >
              <path d="M4 6l4 4 4-4" />
            </svg>
            {t.assistant.brainTab.teamMemoriesTitle}
            <span className="text-[11px] text-muted-foreground font-normal">
              ({teamTotal})
            </span>
          </button>

          {showTeam && (
            <>
              {teamLoading && teamMemories.length === 0 ? (
                <div className="text-[13px] text-muted-foreground py-6 text-center">
                  {t.assistant.brainTab.loadingTeamMemories}
                </div>
              ) : teamMemories.length === 0 ? (
                <div className="rounded-xl border border-dashed border-border p-6 text-center">
                  <div className="text-sm text-foreground font-medium">{t.assistant.brainTab.noTeamMemoriesTitle}</div>
                  <div className="text-[13px] text-muted-foreground mt-1">
                    {t.assistant.brainTab.noTeamMemoriesDesc}
                  </div>
                </div>
              ) : (
                <div className="rounded-xl border border-border overflow-hidden">
                  {teamMemories.map((m, i) => (
                    <div
                      key={m.id}
                      className={`flex items-start gap-3 px-5 py-3.5 ${
                        i < teamMemories.length - 1 ? "border-b border-border" : ""
                      }`}
                    >
                      <span
                        className={`mt-0.5 px-1.5 py-0.5 rounded text-[11px] font-medium shrink-0 ${
                          TYPE_COLORS[m.type as MemoryType] ?? "bg-muted text-muted-foreground"
                        }`}
                      >
                        {typeLabel(m.type as MemoryType)}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[13px] text-foreground truncate">
                          {m.summary}
                        </div>
                        {m.tags.length > 0 && (
                          <div className="text-[11px] text-muted-foreground mt-0.5 truncate">
                            {m.tags.join(", ")}
                          </div>
                        )}
                      </div>
                      <span className="text-[11px] text-muted-foreground shrink-0 mt-0.5">
                        {new Date(m.updatedAt).toLocaleDateString()}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              {/* Team pagination */}
              {teamTotal > 20 && (
                <div className="flex items-center justify-center gap-3 mt-4 text-[13px]">
                  <button
                    onClick={() => fetchTeamMemories(Math.max(0, teamOffset - 20))}
                    disabled={teamOffset === 0}
                    className="px-3 py-1.5 rounded-lg border border-border text-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/40 transition-colors"
                  >
                    {t.assistant.brainTab.previous}
                  </button>
                  <span className="text-muted-foreground">
                    {format(t.assistant.brainTab.pageOf, { current: Math.floor(teamOffset / 20) + 1, total: Math.ceil(teamTotal / 20) })}
                  </span>
                  <button
                    onClick={() => fetchTeamMemories(teamOffset + 20)}
                    disabled={teamOffset + 20 >= teamTotal}
                    className="px-3 py-1.5 rounded-lg border border-border text-foreground disabled:opacity-40 disabled:cursor-not-allowed hover:bg-muted/40 transition-colors"
                  >
                    {t.assistant.brainTab.next}
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

    </div>
  );
}

// ─── Shared layout components ───────────────────────────────────

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-3">
        <h2 className="text-[13px] font-semibold text-foreground tracking-tight uppercase">
          {title}
        </h2>
        <p className="text-[12px] text-muted-foreground mt-0.5">{description}</p>
      </div>
      <div className="rounded-xl border border-border overflow-hidden">
        {children}
      </div>
    </section>
  );
}

// Per-platform model picker row used in SettingsTab → Channel Models.
// Pro is disabled on the free plan; Max is disabled on free + pro. The
// backend re-validates the plan on PATCH, so this is purely a UX guard.
//
// `plan` is the *workspace* plan (billing is per-workspace, migration 143);
// the parent reads it from the workspace context. The legacy `users.plan`
// cookie field is stale post-migration and would lock out members of a
// paid workspace whose own user row is still 'free'.
function ChannelModelRow({
  label,
  value,
  onChange,
  disabled,
  saving,
  plan,
}: {
  label: string;
  value: ModelAlias;
  onChange: (v: ModelAlias) => void;
  disabled: boolean;
  saving: boolean;
  plan: string;
}) {
  const t = useT();
  const proDisabled = plan === "free";
  const maxDisabled = plan === "free" || plan === "pro";
  return (
    <div className="px-5 py-3 flex items-center justify-between gap-3">
      <span className="text-[14px] font-medium text-foreground">{label}</span>
      <div className="flex items-center gap-2">
        {saving && (
          <span className="text-[11px] text-muted-foreground animate-pulse">
            {t.assistant.modelSelector.saving}
          </span>
        )}
        <Select
          value={value}
          onValueChange={(v) => {
            if (isModelAlias(v) && v !== value) onChange(v);
          }}
          disabled={disabled}
        >
          <SelectTrigger
            size="sm"
            className="text-xs gap-1.5 bg-muted/50 hover:bg-muted border-transparent h-7 w-auto min-w-24"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent side="bottom" align="end" alignItemWithTrigger={false} className="w-auto min-w-52">
            <SelectItem value="standard">
              <div className="flex flex-col gap-0.5 py-0.5">
                <span className="text-sm font-medium">{t.assistant.modelSelector.standard}</span>
                <span className="text-[11px] text-muted-foreground">{t.assistant.modelSelector.standardDesc}</span>
              </div>
            </SelectItem>
            <SelectItem value="pro" disabled={proDisabled}>
              <div className="flex flex-col gap-0.5 py-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium">{t.assistant.modelSelector.pro}</span>
                  {proDisabled && (
                    <span className="rounded-sm bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t.assistant.modelSelector.proPlanBadge}
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-muted-foreground">{t.assistant.modelSelector.proDesc}</span>
              </div>
            </SelectItem>
            <SelectItem value="max" disabled={maxDisabled}>
              <div className="flex flex-col gap-0.5 py-0.5">
                <div className="flex items-center gap-1.5">
                  <span className="text-sm font-medium">{t.assistant.modelSelector.max}</span>
                  {maxDisabled && (
                    <span className="rounded-sm bg-muted px-1 py-px text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                      {t.assistant.modelSelector.maxPlanBadge}
                    </span>
                  )}
                </div>
                <span className="text-[11px] text-muted-foreground">{t.assistant.modelSelector.maxDesc}</span>
              </div>
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

// ─── Cost tab ───────────────────────────────────────────────────

type CostResponse = {
  plan: string;
  share: {
    percent: number;        // share of the monthly credit allowance
    rawPercent: number;
    costUsd: number;
    creditsUsed: number;
    creditCap: number;
    userSharePercent: number;
  };
  modelMix: Array<{ model: string; percent: number }>;
  dailyTrend: Array<{ date: string; relative: number }>;
};

const MODEL_COLORS: Record<string, string> = {
  Flash: "bg-blue-400",
  Pro: "bg-purple-400",
  "Flash 2.5": "bg-cyan-400",
  Opus: "bg-amber-400",
  Sonnet: "bg-rose-400",
  Haiku: "bg-emerald-400",
};

// ─── Connectors tab ────────────────────────────────────────────

type UserConnector = {
  id: string;
  name: string;
  connected: boolean;  // Layer 1: user has authenticated/connected
  enabled: boolean;    // Layer 2: enabled for this assistant
  custom?: boolean;
  url?: string;
  icon_url?: string;
  category?: "official" | "community";
  // Source of the connector: a personal one the team-owner has connected,
  // a team-native one (the team owns the credential), a grant from a
  // team member who exposed their personal connector to the team, or a
  // built-in workspace primitive (Workspace Files) — always-on, no
  // credential, synthesized by the route so its per-assistant tool
  // policy is governable here.
  scope?: "personal" | "team-native" | "team-grant" | "builtin";
  // Backing connector_instance id — team-native rows only. Keys the
  // clearance-gated workspace tool-policy routes the governance table's
  // Allow/Ask/Block edits for team-owned connectors.
  instanceId?: string;
};

type ToolPerm = {
  name: string;
  description: string;
  classification: "read" | "write" | "destructive" | "unknown";
  appPolicy: "allow" | "ask" | "block";
  assistantPolicy: "allow" | "ask" | "block";
  effectivePolicy: "allow" | "ask" | "block";
};

type SkillItem = {
  id: string;
  name: string;
  description: string;
  whenToUse?: string;
  category: string;
  requiresConnectors: string[];
  source: string;
  enabled: boolean;
  starred?: boolean;
};

const SOURCE_ORDER: Record<string, number> = { builtin: 0, community: 1, user: 2 };

function sortSkillsForDisplay(items: SkillItem[]): SkillItem[] {
  return [...items].sort((a, b) => {
    const aStar = a.starred ? 0 : 1;
    const bStar = b.starred ? 0 : 1;
    if (aStar !== bStar) return aStar - bStar;
    const aSrc = SOURCE_ORDER[a.source] ?? 99;
    const bSrc = SOURCE_ORDER[b.source] ?? 99;
    if (aSrc !== bSrc) return aSrc - bSrc;
    return a.name.localeCompare(b.name);
  });
}

function ConnectorsTab({ assistantId, workspaceId }: { assistantId: string; workspaceId: string | null }) {
  const t = useT();
  const params = useParams<{ workspaceId: string }>();
  const routeWs = params?.workspaceId ?? "";
  const studioHref = (segment: string) => `/w/${routeWs}/studio/${segment}`;
  const [subTab, setSubTab] = useState<"connectors" | "skills">("connectors");
  const [userConnectors, setUserConnectors] = useState<UserConnector[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState<string | null>(null);
  const [expandedTools, setExpandedTools] = useState<string | null>(null);
  const [toolsMap, setToolsMap] = useState<Record<string, { tools: ToolPerm[]; serverName: string; loading: boolean }>>({});

  // Skills state
  const [skills, setSkills] = useState<SkillItem[]>([]);
  const [skillsLoading, setSkillsLoading] = useState(true);

  const fetchSkills = useCallback(() => {
    authFetch(`${API_URL}/api/assistants/${assistantId}/skills`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { skills?: SkillItem[] } | null) => {
        if (data?.skills) setSkills(data.skills);
      })
      .catch(() => {})
      .finally(() => setSkillsLoading(false));
  }, [assistantId]);

  async function toggleSkill(skillId: string, enabled: boolean) {
    setSkills((prev) => prev.map((s) => (s.id === skillId ? { ...s, enabled } : s)));
    const action = enabled ? "enable" : "disable";
    const res = await authFetch(`${API_URL}/api/assistants/${assistantId}/skills/${skillId}/${action}`, { method: "POST" });
    if (!res.ok) {
      setSkills((prev) => prev.map((s) => (s.id === skillId ? { ...s, enabled: !enabled } : s)));
    }
  }

  async function toggleStar(skillId: string, starred: boolean) {
    setSkills((prev) => prev.map((s) => (s.id === skillId ? { ...s, starred } : s)));
    const action = starred ? "star" : "unstar";
    const res = await authFetch(`${API_URL}/api/skills/${encodeURIComponent(skillId)}/${action}`, { method: "POST" });
    if (!res.ok) {
      setSkills((prev) => prev.map((s) => (s.id === skillId ? { ...s, starred: !starred } : s)));
    }
  }

  const fetchConnectors = useCallback(() => {
    authFetch(`${API_URL}/api/assistants/${assistantId}/connectors`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { connectors?: UserConnector[] } | null) => {
        if (data?.connectors) {
          setUserConnectors(data.connectors);
        }
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [assistantId]);

  useEffect(() => {
    fetchConnectors();
    fetchSkills();
    const onFocus = () => { if (document.visibilityState === "visible") { fetchConnectors(); fetchSkills(); } };
    document.addEventListener("visibilitychange", onFocus);
    return () => document.removeEventListener("visibilitychange", onFocus);
  }, [fetchConnectors, fetchSkills]);

  const allConnectors = userConnectors;

  async function toggleAssistantEnabled(id: string, enable: boolean) {
    setToggling(id);
    // Optimistic update
    setUserConnectors((prev) =>
      prev.map((c) => (c.id === id ? { ...c, enabled: enable } : c))
    );
    try {
      await authFetch(
        `${API_URL}/api/assistants/${assistantId}/connectors/${id}/${enable ? "enable" : "disable"}`,
        { method: "POST" }
      );
    } catch {
      // Revert on failure
      setUserConnectors((prev) =>
        prev.map((c) => (c.id === id ? { ...c, enabled: !enable } : c))
      );
    } finally {
      setToggling(null);
    }
  }

  async function loadTools(connectorId: string) {
    setToolsMap((prev) => ({ ...prev, [connectorId]: { tools: [], serverName: "", loading: true } }));
    try {
      // Use assistant-scoped endpoint — returns L1 + L2 + effective policy
      const res = await authFetch(`${API_URL}/api/assistants/${assistantId}/connectors/${connectorId}/tools`);
      if (res.ok) {
        const data = await res.json();
        setToolsMap((prev) => ({ ...prev, [connectorId]: { tools: data.tools ?? [], serverName: data.serverName ?? "", loading: false } }));
      } else {
        setToolsMap((prev) => ({ ...prev, [connectorId]: { ...prev[connectorId], loading: false } }));
      }
    } catch {
      setToolsMap((prev) => ({ ...prev, [connectorId]: { ...prev[connectorId], loading: false } }));
    }
  }

  const STRICTNESS: Record<string, number> = { allow: 0, ask: 1, block: 2 };
  function strictest(a: string, b: string): "allow" | "ask" | "block" {
    return (STRICTNESS[a] ?? 0) >= (STRICTNESS[b] ?? 0) ? a as "allow" | "ask" | "block" : b as "allow" | "ask" | "block";
  }

  async function handlePolicyChange(connectorId: string, serverName: string, toolName: string, policy: "allow" | "ask" | "block") {
    // Optimistic update — recompute effective policy
    setToolsMap((prev) => {
      const entry = prev[connectorId];
      if (!entry) return prev;
      return {
        ...prev,
        [connectorId]: {
          ...entry,
          tools: entry.tools.map((t) =>
            t.name === toolName
              ? { ...t, assistantPolicy: policy, effectivePolicy: strictest(t.appPolicy, policy) }
              : t
          ),
        },
      };
    });
    try {
      // Save to assistant-scoped endpoint (L2)
      await authFetch(`${API_URL}/api/assistants/${assistantId}/connectors/${connectorId}/tools/policy`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ serverName, toolName, policy }),
      });
    } catch {
      loadTools(connectorId);
    }
  }

  if (loading) {
    return (
      <div className="text-[13px] text-muted-foreground py-10 text-center">
        {t.assistant.toolsTab.loadingConnectors}
      </div>
    );
  }

  function toggleExpand(c: UserConnector) {
    if (expandedTools === c.id) {
      setExpandedTools(null);
    } else {
      setExpandedTools(c.id);
      if (c.connected && c.enabled && !toolsMap[c.id]) loadTools(c.id);
    }
  }

  const SKILL_CATEGORY_COLORS: Record<string, string> = {
    productivity: "bg-blue-500/10 text-blue-600 dark:text-blue-400 border-blue-500/20",
    communication: "bg-green-500/10 text-green-600 dark:text-green-400 border-green-500/20",
    research: "bg-purple-500/10 text-purple-400 border-purple-500/20",
    custom: "bg-orange-500/10 text-orange-400 border-orange-500/20",
  };

  return (
    <div className="space-y-6">
      {/* Sub-tab toggle — Connectors / Skills */}
      <div className="flex gap-1 border-b border-border pb-2">
        {(["connectors", "skills"] as const).map((sub) => (
          <button
            key={sub}
            onClick={() => setSubTab(sub)}
            className={`text-sm px-3 py-1.5 rounded-lg transition-colors ${
              subTab === sub ? "bg-muted text-foreground font-medium" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {sub === "skills" ? t.assistant.toolsTab.subTabSkills : t.assistant.toolsTab.subTabConnectors}
          </button>
        ))}
      </div>

      {subTab === "skills" ? (
        <div className="space-y-3">
          <div className="flex items-start justify-between gap-4">
            <p className="text-xs text-muted-foreground">
              {t.assistant.toolsTab.skillsDescPrefix}{" "}
              <Link href={studioHref("skills")} className="text-primary hover:underline font-medium">{t.assistant.toolsTab.skillsSettingsLink}</Link>.
            </p>
          </div>
          {skillsLoading ? (
            <div className="space-y-3">
              {[1, 2, 3].map((i) => <div key={i} className="h-20 rounded-xl bg-muted/30 animate-pulse" />)}
            </div>
          ) : skills.length === 0 ? (
            <div className="py-10 text-center space-y-2">
              <p className="text-sm text-muted-foreground">{t.assistant.toolsTab.noSkillsYet}</p>
              <Link
                href={studioHref("skills")}
                className="text-xs font-medium text-primary hover:underline"
              >
                {t.assistant.toolsTab.createCustomSkill}
              </Link>
            </div>
          ) : (
            sortSkillsForDisplay(skills).map((skill) => (
              <div key={skill.id} className="flex items-start gap-3 rounded-xl border border-border bg-card p-4 transition-colors">
                <button
                  type="button"
                  onClick={() => toggleStar(skill.id, !skill.starred)}
                  aria-pressed={!!skill.starred}
                  title={skill.starred ? "Unstar" : "Star"}
                  className={`shrink-0 mt-0.5 p-1 rounded transition-colors ${
                    skill.starred
                      ? "text-amber-600 hover:text-amber-500 dark:text-amber-400 dark:hover:text-amber-300"
                      : "text-muted-foreground/60 hover:text-amber-600 dark:hover:text-amber-400"
                  }`}
                >
                  <svg
                    width="16" height="16" viewBox="0 0 20 20"
                    fill={skill.starred ? "currentColor" : "none"}
                    stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"
                  >
                    <path d="M10 2l2.09 6.26H18l-4.77 3.48L15.18 18 10 14.27 4.82 18l1.95-6.26L2 8.26h5.91z" />
                  </svg>
                </button>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap mb-1">
                    <span className="text-sm font-medium text-foreground">{skill.name}</span>
                    <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded-full border ${SKILL_CATEGORY_COLORS[skill.category] ?? SKILL_CATEGORY_COLORS.custom}`}>
                      {skill.category}
                    </span>
                    {skill.source !== "builtin" && (
                      <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full border border-border text-muted-foreground">
                        {skill.source === "community" ? t.assistant.toolsTab.skillCommunity : t.assistant.toolsTab.skillCustom}
                      </span>
                    )}
                  </div>
                  <p className="text-xs text-muted-foreground leading-relaxed">{skill.description}</p>
                  {skill.requiresConnectors.length > 0 && (
                    <p className="text-[11px] text-muted-foreground/70 mt-1">{format(t.assistant.toolsTab.skillRequires, { connectors: skill.requiresConnectors.join(", ") })}</p>
                  )}
                </div>
                <button
                  type="button" role="switch" aria-checked={skill.enabled}
                  onClick={() => toggleSkill(skill.id, !skill.enabled)}
                  className={`shrink-0 relative inline-flex h-5 w-9 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ${skill.enabled ? "bg-primary" : "bg-muted"}`}
                >
                  <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform duration-200 ${skill.enabled ? "translate-x-4" : "translate-x-0"}`} />
                </button>
              </div>
            ))
          )}
        </div>
      ) : (
      <div className="space-y-4">
      <p className="text-xs text-muted-foreground">
        {t.assistant.toolsTab.connectorsDesc}
      </p>

      <div className="space-y-2">
        {allConnectors.map((c) => {
          const isExpanded = expandedTools === c.id;

          return (
            <div key={c.id} className={`border rounded-xl overflow-hidden transition-colors duration-150 ${isExpanded ? "border-primary/30 bg-muted/20" : "border-border"}`}>
              {/* Row */}
              <div className="flex items-center justify-between gap-4 px-5 py-3">
                <button onClick={() => c.connected ? toggleExpand(c) : undefined} className="flex items-center gap-3 min-w-0 flex-1 text-left">
                  <div className="w-8 h-8 rounded-lg bg-muted flex items-center justify-center shrink-0">
                    <ConnectorIcon connectorId={c.id} iconUrl={c.icon_url} />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="text-[13px] font-medium truncate">{c.name}</span>
                      {c.custom && (
                        <span className="text-[10px] uppercase tracking-wider font-medium bg-muted text-muted-foreground px-1.5 py-0.5 rounded">Custom</span>
                      )}
                      {c.scope === "team-native" && (
                        <span className="text-[10px] uppercase tracking-wider font-medium bg-primary/15 text-primary px-1.5 py-0.5 rounded">{t.assistant.toolsTab.scopeTeamNative}</span>
                      )}
                      {c.scope === "team-grant" && (
                        <span className="text-[10px] uppercase tracking-wider font-medium bg-amber-500/15 text-amber-600 dark:text-amber-400 px-1.5 py-0.5 rounded">{t.assistant.toolsTab.scopeTeamGrant}</span>
                      )}
                      {c.scope === "builtin" && (
                        <span className="text-[10px] uppercase tracking-wider font-medium bg-muted text-muted-foreground px-1.5 py-0.5 rounded">{t.assistant.toolsTab.scopeBuiltin}</span>
                      )}
                    </div>
                    {c.custom && c.url && (
                      <div className="text-[11px] text-muted-foreground truncate">{c.url}</div>
                    )}
                  </div>
                </button>

                <div className="flex items-center gap-3 shrink-0">
                  {!c.connected ? (
                    c.scope === "team-native" && workspaceId ? (
                      <Link href={studioHref("connectors")} className="text-[11px] text-primary hover:underline font-medium">
                        {t.assistant.toolsTab.setUpInWorkspace}
                      </Link>
                    ) : c.scope === "team-grant" ? (
                      <span className="text-[11px] text-muted-foreground">
                        {t.assistant.toolsTab.disconnectedByMember}
                      </span>
                    ) : (
                      <Link href={studioHref("connectors")} className="text-[11px] text-primary hover:underline font-medium">
                        {t.assistant.toolsTab.setUpInSettings}
                      </Link>
                    )
                  ) : (
                    <>
                      {c.connected && isExpanded && (
                        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="text-muted-foreground transition-transform duration-200 rotate-180">
                          <path d="M3 5l4 4 4-4" />
                        </svg>
                      )}
                      {c.scope === "builtin" ? (
                        // Built-in primitives are always available — there is no
                        // per-assistant off switch to honor, so a toggle here
                        // would be cosmetic. Per-tool policy below is the control.
                        <span className="text-[11px] font-medium text-muted-foreground bg-muted px-2 py-0.5 rounded-full">
                          {t.assistant.toolsTab.alwaysOn}
                        </span>
                      ) : (
                      <button
                        type="button" role="switch" aria-checked={c.enabled}
                        disabled={toggling === c.id}
                        onClick={(e) => { e.stopPropagation(); toggleAssistantEnabled(c.id, !c.enabled); }}
                        className={`relative inline-flex h-5 w-9 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 ${c.enabled ? "bg-primary" : "bg-muted"}`}
                      >
                        <span className={`pointer-events-none inline-block h-4 w-4 rounded-full bg-background shadow-sm transition-transform duration-200 ${c.enabled ? "translate-x-4" : "translate-x-0"}`} />
                      </button>
                      )}
                    </>
                  )}
                </div>
              </div>

              {/* Expanded: tool permissions */}
              <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${isExpanded && c.connected && c.enabled ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                <div className="overflow-hidden">
                  <div className="px-5 pb-4 pt-1">
                    {/* Merged governance table (#4 in connector-actions.md):
                        capability grants (per-assistant, every caller) ahead of
                        confirmation policy (per-user). Built-in primitives and
                        custom MCPs render policy-only inside the component. */}
                    <ConnectorToolGovernance
                      assistantId={assistantId}
                      connectorId={c.id}
                      scope={c.scope}
                      loading={toolsMap[c.id]?.loading}
                      tools={(toolsMap[c.id]?.tools ?? []).map((tool) => ({
                        name: tool.name,
                        description: tool.description,
                        classification: tool.classification,
                        currentPolicy: tool.effectivePolicy as ToolPolicy,
                        minStrictness: tool.appPolicy as ToolPolicy,
                      }))}
                      onPolicyChange={(toolName, policy) =>
                        handlePolicyChange(c.id, toolsMap[c.id]?.serverName ?? c.id, toolName, policy)
                      }
                      workspaceId={workspaceId}
                      instanceId={c.instanceId}
                    />
                  </div>
                </div>
              </div>
            </div>
          );
        })}
      </div>

      <div className="text-[13px] text-muted-foreground">
        {t.assistant.toolsTab.connectMorePrefix}{" "}
        <Link href={studioHref("connectors")} className="text-primary hover:underline font-medium">{t.assistant.toolsTab.settingsLink}</Link>.
      </div>
      </div>
      )}
    </div>
  );
}

// ─── Cost tab ──────────────────────────────────────────────────

function CostTab({ assistantId }: { assistantId: string }) {
  const t = useT();
  const [data, setData] = useState<CostResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    authFetch(`${API_URL}/api/assistants/${assistantId}/usage`)
      .then((r) => (r.ok ? r.json() : null))
      .then((d: CostResponse | null) => {
        if (d) setData(d);
        setLoading(false);
      })
      .catch(() => setLoading(false));
  }, [assistantId]);

  if (loading) {
    return (
      <div className="text-[13px] text-muted-foreground py-10 text-center">
        {t.assistant.settingsTab.costLoading}
      </div>
    );
  }

  if (!data || (data.share.percent === 0 && data.dailyTrend.length === 0)) {
    return (
      <div className="rounded-xl border border-dashed border-border p-10 text-center">
        <div className="text-sm text-foreground font-medium">{t.assistant.settingsTab.noUsageTitle}</div>
        <div className="text-[13px] text-muted-foreground mt-1.5 max-w-md mx-auto">
          {t.assistant.settingsTab.noUsageDesc}
        </div>
      </div>
    );
  }

  const plan = data.plan.charAt(0).toUpperCase() + data.plan.slice(1);

  return (
    <div className="space-y-8">
      {/* Monthly credit share */}
      <Section
        title={t.assistant.settingsTab.creditShareTitle}
        description={t.assistant.settingsTab.creditShareDesc}
      >
        <div className="px-5 py-4">
          <div className="flex items-center gap-6">
            <div className="w-44 shrink-0">
              <div className="text-sm font-semibold">{format(t.assistant.settingsTab.planLabel, { plan })}</div>
              <div className="text-xs text-muted-foreground mt-0.5">
                {data.share.userSharePercent > 0
                  ? format(t.assistant.settingsTab.percentOfTotal, { percent: data.share.userSharePercent })
                  : t.assistant.settingsTab.noUsageInWindow}
              </div>
            </div>
            <div className="flex-1 min-w-0">
              <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full bg-primary rounded-full transition-all"
                  style={{ width: `${Math.min(data.share.percent, 100)}%` }}
                />
              </div>
            </div>
            <div className="w-16 shrink-0 text-right">
              <span className="text-sm text-muted-foreground tabular-nums">
                {format(t.assistant.settingsTab.percentUsed, { percent: data.share.percent })}
              </span>
            </div>
          </div>
        </div>
      </Section>

      {/* Model mix */}
      {data.modelMix.length > 0 && (
        <Section
          title={t.assistant.settingsTab.modelMixTitle}
          description={t.assistant.settingsTab.modelMixDesc}
        >
          <div className="px-5 py-4 space-y-3">
            {/* Stacked bar */}
            <div className="h-1.5 bg-muted rounded-full overflow-hidden flex">
              {data.modelMix.map((m) => (
                <div
                  key={m.model}
                  className={`h-full ${MODEL_COLORS[m.model] ?? "bg-muted-foreground"} first:rounded-l-full last:rounded-r-full`}
                  style={{ width: `${m.percent}%` }}
                />
              ))}
            </div>
            {/* Legend */}
            <div className="flex items-center gap-4">
              {data.modelMix.map((m) => (
                <div key={m.model} className="flex items-center gap-1.5 text-[13px]">
                  <span
                    className={`w-2 h-2 rounded-full ${MODEL_COLORS[m.model] ?? "bg-muted-foreground"}`}
                  />
                  <span className="text-muted-foreground">
                    {m.model} <span className="text-foreground font-medium">{m.percent}%</span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        </Section>
      )}

      {/* Activity trend */}
      {data.dailyTrend.length > 0 && (
        <Section
          title={t.assistant.settingsTab.activityTitle}
          description={t.assistant.settingsTab.activityDesc}
        >
          <div className="px-5 py-4">
            <div className="flex items-end gap-[3px] h-16">
              {data.dailyTrend.map((d) => (
                <div
                  key={d.date}
                  className="flex-1 bg-primary/80 rounded-t min-h-[1px]"
                  style={{ height: `${Math.max(d.relative * 100, 1.5)}%` }}
                />
              ))}
            </div>
            <div className="flex justify-between mt-2 text-[11px] text-muted-foreground">
              <span>{t.assistant.settingsTab.fourWeeksAgo}</span>
              <span>{t.assistant.settingsTab.today}</span>
            </div>
          </div>
        </Section>
      )}

      {/* Low-usage footnote */}
      {data.share.rawPercent > 0 && data.share.rawPercent < 1 && (
        <p className="text-xs text-muted-foreground leading-relaxed">
          {format(t.assistant.settingsTab.lowUsageFootnote, {
            creditsUsed: data.share.creditsUsed.toLocaleString(),
            creditCap: data.share.creditCap.toLocaleString(),
          })}
        </p>
      )}
    </div>
  );
}

// ─── Settings tab ────────────────────────────────────────────────

type ModelAlias = "standard" | "pro" | "max";
type ChannelModelKey = "slack" | "telegram";

function isModelAlias(v: unknown): v is ModelAlias {
  return v === "standard" || v === "pro" || v === "max";
}

function SettingsTab({
  assistantId,
  role,
  kind,
  assistantName,
  workspaceId,
  onRenamed,
  onTeamChanged,
}: {
  assistantId: string;
  role: string;
  kind?: "standard" | "app" | "primary";
  assistantName: string;
  workspaceId: string | null;
  onRenamed: (name: string) => void;
  onTeamChanged: (workspaceId: string | null, workspaceName: string | null) => void;
}) {
  const t = useT();
  const router = useRouter();
  const params = useParams<{ workspaceId: string }>();
  const routeWs = params?.workspaceId ?? "";
  const [name, setName] = useState(assistantName);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [saving, setSaving] = useState<"name" | "prompt" | null>(null);
  const [feedback, setFeedback] = useState<{ type: "success" | "error"; message: string } | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [deleting, setDeleting] = useState(false);

  // Channel-model aliases — backend stores per assistant in
  // assistants.{slack,telegram}_model_alias. Read by the platform
  // webhook routes (slack.ts / telegram*.ts) when picking the
  // model for that channel's reply.
  const [slackModel, setSlackModel] = useState<ModelAlias>("pro");
  const [telegramModel, setTelegramModel] = useState<ModelAlias>("pro");
  const [savingModel, setSavingModel] = useState<ChannelModelKey | null>(null);

  // Team state
  const [currentTeamId, setCurrentTeamId] = useState<string | null>(workspaceId);
  const [currentTeamName, setCurrentTeamName] = useState<string | null>(null);
  const [teams, setTeams] = useState<{ id: string; name: string }[]>([]);
  const [showTeamPicker, setShowTeamPicker] = useState(false);
  const [teamLoading, setTeamLoading] = useState(false);

  // Channel-model gating reads the *workspace* plan (billing is per-workspace,
  // migration 143). `currentTeamId` is the live id (updates if the assistant
  // is moved to a different workspace mid-session). Orphan assistants with
  // no workspace fall back to 'free' — the backend re-validates the plan
  // on PATCH, so this is purely a UX guard.
  const { workspaces } = useWorkspaces();
  const workspacePlan =
    workspaces.find((w) => w.id === currentTeamId)?.plan ?? "free";

  // Fetch current settings + team name
  useEffect(() => {
    authFetch(`${API_URL}/api/assistants/${assistantId}`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: {
        name?: string;
        systemPrompt?: string | null;
        workspaceId?: string | null;
        slackModelAlias?: string;
        telegramModelAlias?: string;
      } | null) => {
        if (data) {
          setName(data.name ?? assistantName);
          setSystemPrompt(data.systemPrompt ?? "");
          if (isModelAlias(data.slackModelAlias)) setSlackModel(data.slackModelAlias);
          if (isModelAlias(data.telegramModelAlias)) setTelegramModel(data.telegramModelAlias);
          setLoaded(true);
          if (data.workspaceId) {
            setCurrentTeamId(data.workspaceId);
            authFetch(`${API_URL}/api/workspaces/${data.workspaceId}`)
              .then((r) => (r.ok ? r.json() : null))
              .then((t) => { if (t?.name) setCurrentTeamName(t.name); })
              .catch(() => {});
          }
        }
      })
      .catch(() => {});
  }, [assistantId, assistantName]);

  function showFeedback(type: "success" | "error", message: string) {
    setFeedback({ type, message });
    setTimeout(() => setFeedback(null), 3000);
  }

  async function saveName() {
    if (!name.trim() || name.trim() === assistantName) return;
    setSaving("name");
    try {
      const res = await authFetch(`${API_URL}/api/assistants/${assistantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim() }),
      });
      if (res.ok) {
        const data = await res.json();
        onRenamed(data.name);
        // Broadcast to the sidebar cache so the studio rail + AppSidebar
        // pick up the new name without waiting for a refetch.
        const cached = getCachedAssistants();
        setCachedAssistants(cached.map((a) => a.id === assistantId ? { ...a, name: data.name } : a));
        showFeedback("success", t.assistant.settingsTab.feedbackNameUpdated);
      } else {
        const err = await res.json().catch(() => ({ error: t.assistant.settingsTab.feedbackFailedToUpdate }));
        showFeedback("error", err.error ?? t.assistant.settingsTab.feedbackFailedToUpdateName);
      }
    } catch {
      showFeedback("error", t.assistant.settingsTab.feedbackNetworkError);
    } finally {
      setSaving(null);
    }
  }

  async function savePrompt() {
    setSaving("prompt");
    try {
      const res = await authFetch(`${API_URL}/api/assistants/${assistantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ systemPrompt: systemPrompt || null }),
      });
      if (res.ok) {
        showFeedback("success", t.assistant.settingsTab.feedbackPromptUpdated);
      } else {
        const err = await res.json().catch(() => ({ error: t.assistant.settingsTab.feedbackFailedToUpdate }));
        showFeedback("error", err.error ?? t.assistant.settingsTab.feedbackFailedToUpdatePrompt);
      }
    } catch {
      showFeedback("error", t.assistant.settingsTab.feedbackNetworkError);
    } finally {
      setSaving(null);
    }
  }

  async function saveModelAlias(channel: ChannelModelKey, value: ModelAlias) {
    const prev = channel === "slack" ? slackModel : telegramModel;
    const setter = channel === "slack" ? setSlackModel : setTelegramModel;
    const field = channel === "slack" ? "slackModelAlias" : "telegramModelAlias";
    setter(value);
    setSavingModel(channel);
    try {
      const res = await authFetch(`${API_URL}/api/assistants/${assistantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ [field]: value }),
      });
      if (res.ok) {
        showFeedback("success", t.assistant.settings.channelModelsSaved);
      } else {
        setter(prev);
        showFeedback("error", t.assistant.settings.channelModelsFailed);
      }
    } catch {
      setter(prev);
      showFeedback("error", t.assistant.settingsTab.feedbackNetworkError);
    } finally {
      setSavingModel(null);
    }
  }

  async function handleDelete() {
    if (deleteConfirm !== assistantName) return;
    setDeleting(true);
    try {
      const res = await authFetch(`${API_URL}/api/assistants/${assistantId}`, {
        method: "DELETE",
      });
      if (res.ok || res.status === 204) {
        // Evict the deleted assistant from the module cache before navigating
        // away. The persistent FloatingChat assistant picker (chrome)
        // subscribes via onAssistantsChanged, so without this the deleted
        // assistant lingers in the picker until a hard reload.
        const cached = getCachedAssistants();
        setCachedAssistants(cached.filter((a) => a.id !== assistantId));
        router.replace(`/w/${routeWs}/brain`);
      } else {
        const err = await res.json().catch(() => ({ error: t.assistant.settingsTab.feedbackFailedToDelete }));
        showFeedback("error", err.message ?? err.error ?? t.assistant.settingsTab.feedbackFailedToDelete);
        setDeleting(false);
      }
    } catch {
      showFeedback("error", t.assistant.settingsTab.feedbackNetworkError);
      setDeleting(false);
    }
  }

  async function handleShowTeamPicker() {
    setShowTeamPicker(true);
    setTeamLoading(true);
    try {
      const res = await authFetch(`${API_URL}/api/workspaces`);
      if (res.ok) {
        const data = await res.json();
        setTeams(data.teams ?? []);
      }
    } catch {
      // ignore
    } finally {
      setTeamLoading(false);
    }
  }

  async function handleAddToTeam(selectedTeamId: string) {
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${selectedTeamId}/assistants/${assistantId}/adopt`,
        { method: "POST" }
      );
      if (res.ok) {
        const team = teams.find((tm) => tm.id === selectedTeamId);
        setCurrentTeamId(selectedTeamId);
        setCurrentTeamName(team?.name ?? null);
        setShowTeamPicker(false);
        onTeamChanged(selectedTeamId, team?.name ?? null);
        showFeedback("success", t.assistant.settingsTab.feedbackAddedToWorkspace);
      } else {
        const err = await res.json().catch(() => ({}));
        showFeedback("error", (err as { error?: string }).error ?? t.assistant.settingsTab.feedbackFailedToAddToWorkspace);
      }
    } catch {
      showFeedback("error", t.assistant.settingsTab.feedbackNetworkError);
    }
  }

  async function handleRemoveFromTeam() {
    if (!currentTeamId) return;
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${currentTeamId}/assistants/${assistantId}/remove`,
        { method: "POST" }
      );
      if (res.ok) {
        setCurrentTeamId(null);
        setCurrentTeamName(null);
        onTeamChanged(null, null);
        showFeedback("success", t.assistant.settingsTab.feedbackRemovedFromWorkspace);
      } else {
        const err = await res.json().catch(() => ({}));
        showFeedback("error", (err as { error?: string }).error ?? t.assistant.settingsTab.feedbackFailedToRemoveFromWorkspace);
      }
    } catch {
      showFeedback("error", t.assistant.settingsTab.feedbackNetworkError);
    }
  }

  const isOwner = role === "owner";
  // Rename is a team-admin right: the owner OR a workspace admin may rename the
  // assistant (a workspace admin manages the shared assistant roster). Mirrors
  // the PATCH gate in packages/api/src/routes/assistants.ts. The rest of this
  // tab (Channel Models, Team, Danger Zone) stays owner-only.
  const canRename = role === "owner" || role === "admin";
  // Primary assistants anchor their workspace and cannot be deleted
  // (server enforces via 409 primary_not_deletable in
  // packages/api/src/routes/assistants.ts). Surface that up front
  // rather than letting the user type-to-confirm into a rejected call.
  const isPrimary = kind === "primary";

  return (
    <div className="space-y-8">
      {/* Feedback toast */}
      {feedback && (
        <div
          className={`text-[13px] px-4 py-2.5 rounded-lg border ${
            feedback.type === "success"
              ? "border-primary/30 bg-primary/10 text-primary"
              : "border-destructive/30 bg-destructive/10 text-destructive"
          }`}
        >
          {feedback.message}
        </div>
      )}

      {/* General */}
      <Section title={t.assistant.settings.generalTitle} description={t.assistant.settings.generalDesc}>
        <div className="px-5 py-4 space-y-3">
          <div>
            <label className="text-[12px] font-medium text-muted-foreground block mb-1.5">
              {t.assistant.settings.name}
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                disabled={!canRename}
                maxLength={100}
                className="flex-1 bg-muted/50 border border-border rounded-lg px-3 py-2 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50"
              />
              {canRename && (
                <button
                  onClick={saveName}
                  disabled={saving === "name" || !name.trim() || name.trim() === assistantName}
                  className="px-3 py-2 text-[13px] font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/80 disabled:opacity-50 disabled:pointer-events-none transition-colors"
                >
                  {saving === "name" ? t.assistant.settings.saving : t.assistant.settings.save}
                </button>
              )}
            </div>
          </div>
        </div>
      </Section>

      {/* Custom Instructions — the system prompt is a shared, collaboratively
          editable persona, so it is open to any member who can access this
          assistant (not owner-gated like the rest of this tab). Mirrors the
          API rule in packages/api/src/routes/assistants.ts PATCH handler. */}
      <Section title={t.assistant.settings.customInstructionsTitle} description={t.assistant.settings.customInstructionsDesc}>
        <div className="px-5 py-4 space-y-3">
          {!loaded ? (
            <div className="text-[13px] text-muted-foreground">{t.settings.common.loading}</div>
          ) : (
            <>
              <textarea
                value={systemPrompt}
                onChange={(e) => setSystemPrompt(e.target.value)}
                maxLength={10000}
                rows={6}
                placeholder={t.assistant.settings.customInstructionsPlaceholder}
                className="w-full bg-muted/50 border border-border rounded-lg px-3 py-2.5 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 resize-y min-h-[120px]"
              />
              <div className="flex items-center justify-between">
                <span className="text-[11px] text-muted-foreground">
                  {systemPrompt.length.toLocaleString()} / 10,000
                </span>
                <button
                  onClick={savePrompt}
                  disabled={saving === "prompt"}
                  className="px-3 py-2 text-[13px] font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/80 disabled:opacity-50 disabled:pointer-events-none transition-colors"
                >
                  {saving === "prompt" ? t.assistant.settings.saving : t.assistant.settings.save}
                </button>
              </div>
            </>
          )}
        </div>
      </Section>

      {/* Channel Models — per-platform model alias used when this assistant
          replies via Slack / Telegram. The chat composer's
          per-message override still wins on the web channel. */}
      <Section
        title={t.assistant.settings.channelModelsTitle}
        description={t.assistant.settings.channelModelsDesc}
      >
        <div className="divide-y divide-border">
          <ChannelModelRow
            label={t.assistant.settings.channelModelsSlack}
            value={slackModel}
            onChange={(v) => saveModelAlias("slack", v)}
            disabled={!isOwner}
            saving={savingModel === "slack"}
            plan={workspacePlan}
          />
          <ChannelModelRow
            label={t.assistant.settings.channelModelsTelegram}
            value={telegramModel}
            onChange={(v) => saveModelAlias("telegram", v)}
            disabled={!isOwner}
            saving={savingModel === "telegram"}
            plan={workspacePlan}
          />
        </div>
      </Section>

      {/* Team */}
      {isOwner && (
        <Section title={t.assistant.settings.teamTitle} description={t.assistant.settings.teamDesc}>
          <div className="px-5 py-4 space-y-3">
            {currentTeamId ? (
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-7 h-7 rounded-lg bg-primary/10 flex items-center justify-center text-[11px] font-bold text-primary">
                    {(currentTeamName ?? "T").charAt(0).toUpperCase()}
                  </div>
                  <span className="text-[14px] font-medium">{currentTeamName ?? t.assistant.settingsTab.teamFallback}</span>
                </div>
                <button
                  onClick={handleRemoveFromTeam}
                  className="text-[13px] text-muted-foreground hover:text-destructive transition-colors"
                >
                  {t.assistant.settings.removeFromWorkspace}
                </button>
              </div>
            ) : (
              <>
                {!showTeamPicker ? (
                  <button
                    onClick={handleShowTeamPicker}
                    className="text-[13px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {t.assistant.settings.addToTeam}
                  </button>
                ) : (
                  <div className="space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-[12px] font-medium text-muted-foreground">{t.assistant.settingsTab.selectTeam}</span>
                      <button
                        onClick={() => setShowTeamPicker(false)}
                        className="text-[12px] text-muted-foreground hover:text-foreground"
                      >
                        {t.assistant.settingsTab.cancel}
                      </button>
                    </div>
                    {teamLoading ? (
                      <div className="text-[13px] text-muted-foreground">{t.settings.common.loading}</div>
                    ) : teams.length === 0 ? (
                      <div className="text-[13px] text-muted-foreground">
                        {t.assistant.settingsTab.noWorkspacesYet}{" "}
                        <a href="/teams" className="text-primary hover:underline">
                          {t.assistant.settingsTab.createOne}
                        </a>
                      </div>
                    ) : (
                      <div className="space-y-1">
                        {teams.map((team) => (
                          <button
                            key={team.id}
                            onClick={() => handleAddToTeam(team.id)}
                            className="w-full flex items-center gap-2.5 py-2 px-3 rounded-lg hover:bg-muted/50 transition-colors text-left"
                          >
                            <div className="w-6 h-6 rounded-lg bg-primary/10 flex items-center justify-center text-[10px] font-bold text-primary shrink-0">
                              {team.name.charAt(0).toUpperCase()}
                            </div>
                            <span className="text-[13px]">{team.name}</span>
                            <span className="text-[11px] text-primary ml-auto">{t.assistant.settingsTab.addToTeamButton}</span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>
        </Section>
      )}

      {/* §17 — Tasks/CRM primitive grants. See docs/plans/company-brain.md §17. */}
      <PrimitiveGrantsPanel assistantId={assistantId} />

      {/* Cost section — embedded from former CostTab */}
      <CostTab assistantId={assistantId} />

      {/* Danger Zone — owner only */}
      {isOwner && (
        <section>
          <div className="mb-3">
            <h2 className="text-[13px] font-semibold text-destructive tracking-tight uppercase">
              {t.assistant.settingsTab.dangerZone}
            </h2>
            <p className="text-[12px] text-muted-foreground mt-0.5">
              {t.assistant.settingsTab.dangerZoneDesc}
            </p>
          </div>
          <div className="rounded-xl border border-destructive/30 overflow-hidden">
            <div className="px-5 py-4 space-y-3">
              <div className="text-[14px] font-medium text-foreground">
                {t.assistant.settingsTab.deleteTitle}
              </div>
              {isPrimary ? (
                <p className="text-[12px] text-muted-foreground">
                  {t.assistant.settingsTab.primaryNotDeletable}
                </p>
              ) : (
                <>
                  <p className="text-[12px] text-muted-foreground">
                    {t.assistant.settingsTab.deleteDesc}
                  </p>
                  <div>
                    <label className="text-[12px] text-muted-foreground block mb-1.5">
                      {t.assistant.settingsTab.deleteConfirmLabelPrefix}{" "}
                      <span className="font-medium text-foreground">{assistantName}</span>{" "}
                      {t.assistant.settingsTab.deleteConfirmLabelSuffix}
                    </label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={deleteConfirm}
                        onChange={(e) => setDeleteConfirm(e.target.value)}
                        placeholder={assistantName}
                        className="flex-1 bg-muted/50 border border-border rounded-lg px-3 py-2 text-[14px] text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-destructive/50"
                      />
                      <button
                        onClick={handleDelete}
                        disabled={deleteConfirm !== assistantName || deleting}
                        className="px-3 py-2 text-[13px] font-medium rounded-lg bg-destructive/10 text-destructive hover:bg-destructive/20 disabled:opacity-50 disabled:pointer-events-none transition-colors"
                      >
                        {deleting ? t.assistant.settingsTab.deleting : t.assistant.settingsTab.deleteButton}
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>
          </div>
        </section>
      )}
    </div>
  );
}

// ─── Primitive grants panel (§17 — Tasks/CRM/Configure toggles) ──
//
// Per-assistant on/off toggles for the Tasks (Q1) and CRM (Q2) primitive
// groups, plus the `configure` control-plane capability. Backed by
// `assistant_capabilities` ('tasks' / 'crm' / 'configure'). When off,
// the matching tools (saveTask, saveContact, …) are hidden from the model
// at every execution path (chat, channels, scheduling, workflow, public
// API). `configure` arms agent-driven control-plane writes (workflows,
// schedules, ingest rules, skills, connectors) for programmatic agents
// acting as this assistant; its PATCH is OWNER/ADMIN-gated server-side
// (403 for plain members). See docs/plans/company-brain.md §17.

type PrimitiveGrantCapability = "tasks" | "crm" | "configure";
type PrimitiveGrantState = { capability: PrimitiveGrantCapability; enabled: boolean };

function PrimitiveGrantsPanel({ assistantId }: { assistantId: string }) {
  const t = useT();
  const [grants, setGrants] = useState<PrimitiveGrantState[] | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const [rowError, setRowError] = useState<{ capability: PrimitiveGrantCapability; message: string } | null>(null);

  useEffect(() => {
    authFetch(`${API_URL}/api/assistants/${assistantId}/primitive-grants`)
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { grants?: PrimitiveGrantState[] } | null) => {
        if (data?.grants) setGrants(data.grants);
      })
      .catch(() => {});
  }, [assistantId]);

  async function toggle(capability: PrimitiveGrantCapability, enabled: boolean) {
    setPending(capability);
    setRowError(null);
    try {
      const res = await authFetch(
        `${API_URL}/api/assistants/${assistantId}/primitive-grants/${capability}`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ enabled }),
        },
      );
      if (res.ok) {
        const data = (await res.json()) as PrimitiveGrantState;
        setGrants((prev) =>
          prev ? prev.map((g) => (g.capability === data.capability ? data : g)) : prev,
        );
      } else if (res.status === 403) {
        setRowError({
          capability,
          message: t.assistant.settingsTab.capabilities.configureAdminOnly,
        });
      }
    } finally {
      setPending(null);
    }
  }

  if (!grants) return null;

  const labelFor = (cap: PrimitiveGrantCapability) =>
    cap === "tasks"
      ? t.assistant.settingsTab.capabilities.tasksLabel
      : cap === "crm"
        ? t.assistant.settingsTab.capabilities.crmLabel
        : t.assistant.settingsTab.capabilities.configureLabel;
  const descFor = (cap: PrimitiveGrantCapability) =>
    cap === "tasks"
      ? t.assistant.settingsTab.capabilities.tasksDesc
      : cap === "crm"
        ? t.assistant.settingsTab.capabilities.crmDesc
        : t.assistant.settingsTab.capabilities.configureDesc;

  return (
    <section>
      <div className="mb-3">
        <h2 className="text-[13px] font-semibold text-foreground tracking-tight uppercase">
          {t.assistant.settingsTab.capabilities.title}
        </h2>
        <p className="text-[12px] text-muted-foreground mt-0.5">
          {t.assistant.settingsTab.capabilities.desc}
        </p>
      </div>
      <div className="rounded-xl border border-border overflow-hidden divide-y divide-border">
        {grants.map((g) => {
          // The `configure` row is an agent/control-plane capability, not a
          // data primitive — give it a distinct tinted treatment.
          const isControlPlane = g.capability === "configure";
          return (
            <div
              key={g.capability}
              className={`px-5 py-4 flex items-start justify-between gap-4 ${
                isControlPlane ? "bg-primary/[0.04] border-l-2 border-l-primary/60" : ""
              }`}
            >
              <div className="min-w-0">
                <div className="text-[14px] font-medium text-foreground">{labelFor(g.capability)}</div>
                <p className="text-[12px] text-muted-foreground mt-0.5">{descFor(g.capability)}</p>
                {rowError?.capability === g.capability && (
                  <p className="text-[12px] text-destructive mt-1">{rowError.message}</p>
                )}
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={g.enabled}
                disabled={pending === g.capability}
                onClick={() => toggle(g.capability, !g.enabled)}
                className={`shrink-0 relative inline-flex h-6 w-11 items-center rounded-full transition-colors disabled:opacity-50 ${
                  g.enabled ? "bg-primary" : "bg-muted"
                }`}
              >
                <span
                  className={`inline-block h-4 w-4 transform rounded-full bg-background transition-transform ${
                    g.enabled ? "translate-x-6" : "translate-x-1"
                  }`}
                />
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

