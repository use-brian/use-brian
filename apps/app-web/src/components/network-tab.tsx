"use client";

/**
 * Network tab (app-web) — mode-based access management.
 *
 * Ported from `apps/web/src/components/network-tab.tsx`
 * (app consolidation §9 #5). The assistant owner curates named modes that
 * bundle (exposed_tools, freshness, policy). Connections bind to a mode at
 * follow-acceptance time. No mode = free (full access).
 *
 * app-web delta: the three native `<select>` pickers from apps/web (the
 * follower mode picker, the accept-request mode picker, and the ModeEditor
 * freshness picker) are re-expressed with the themed `Select` primitive per
 * the project rule against native `<select>`/`window.*` dialogs.
 *
 * See docs/architecture/integrations/a2a.md.
 * [COMP:app-web/network-tab]
 */

import { useEffect, useState, useCallback, useRef } from "react";
import { authFetch } from "@/lib/auth-fetch";
import { AssistantAvatar } from "@/components/assistant-avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// base-ui Select treats `null` as "no value"; we use a sentinel string for
// the "Free (no restrictions)" option so the control round-trips an explicit
// choice and we map it back to `null` at the call site.
const NO_MODE = "__none__";

// ── Types ──────────────────────────────────────────────────────

type Mode = {
  id: string;
  assistantId: string;
  name: string;
  description: string | null;
  exposedTools: string[];
  freshness: "live" | "snapshot";
  requireApproval: boolean;
  allowOnwardConsults: boolean;
  knowledgeMaxSensitivity: string | null;
  memoryCategories: string[] | null;
  createdAt: string;
  updatedAt: string;
};

type Connection = {
  id: string;
  followerAssistantId: string;
  followingAssistantId: string;
  status: "pending" | "accepted" | "blocked";
  callerNote: string | null;
  modeId: string | null;
  followerAssistantName?: string;
  followerOwnerHandle?: string;
  followingAssistantName?: string;
  followingOwnerHandle?: string;
  followingBio?: string | null;
};

type PendingApproval = {
  id: string;
  category: string | null;
  payload: { question?: string; callerAssistantName?: string; modeId?: string };
  createdAt: string;
};

type Counts = { followers: number; following: number };

type ActivitySession = {
  sessionId: string;
  callerName: string;
  callerHandle: string | null;
  callerIconSeed?: number;
  callerAssistantId?: string;
  messages: Array<{ role: string; text: string; createdAt: string }>;
};

type AssistantInfo = {
  id: string;
  name: string;
  iconSeed?: number;
  bio: string | null;
  workspaceId: string | null;
};

type Props = {
  assistantId: string;
  workspaceId: string | null;
};

// ── Component ──────────────────────────────────────────────────

export function NetworkTab({ assistantId, workspaceId: _workspaceId }: Props) {
  const t = useT();
  type SubTab = "following" | "followers" | "requests" | "activity";

  const [assistant, setAssistant] = useState<AssistantInfo | null>(null);
  const [following, setFollowing] = useState<Connection[]>([]);
  const [followers, setFollowers] = useState<Connection[]>([]);
  const [pending, setPending] = useState<Connection[]>([]);
  const [counts, setCounts] = useState<Counts>({ followers: 0, following: 0 });
  const [modes, setModes] = useState<Mode[]>([]);
  const [pendingApprovals, setPendingApprovals] = useState<PendingApproval[]>([]);
  const [activity, setActivity] = useState<ActivitySession[]>([]);
  const [activitySearch, setActivitySearch] = useState("");
  const [activityPage, setActivityPage] = useState(0);
  const [expandedSession, setExpandedSession] = useState<string | null>(null);
  const ACTIVITY_PAGE_SIZE = 5;
  const [subTab, setSubTab] = useState<SubTab>("following");
  const [loading, setLoading] = useState(true);
  const [feedback, setFeedback] = useState<{ kind: "success" | "error"; message: string } | null>(null);

  // Bio editor state
  const [editingBio, setEditingBio] = useState(false);
  const [bioInput, setBioInput] = useState("");
  const [savingBio, setSavingBio] = useState(false);

  // Mode editor state
  const [editingMode, setEditingMode] = useState<Mode | "new" | null>(null);

  // Per-pending-request mode picker state
  const [acceptModePick, setAcceptModePick] = useState<Record<string, string>>({});

  const hasFetched = useRef(false);

  const showFeedback = useCallback((kind: "success" | "error", message: string) => {
    setFeedback({ kind, message });
    setTimeout(() => setFeedback(null), 3000);
  }, []);

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [assistantR, followingR, followersR, pendingR, countsR, modesR, pendingMsgR, activityR] = await Promise.all([
        authFetch(`${API_URL}/api/assistants/${assistantId}`).then((r) => (r.ok ? r.json() : null)),
        authFetch(`${API_URL}/api/connections/following?assistantId=${assistantId}`).then((r) => (r.ok ? r.json() : null)),
        authFetch(`${API_URL}/api/connections/followers?assistantId=${assistantId}`).then((r) => (r.ok ? r.json() : null)),
        authFetch(`${API_URL}/api/connections/pending?assistantId=${assistantId}`).then((r) => (r.ok ? r.json() : null)),
        authFetch(`${API_URL}/api/connections/counts?assistantId=${assistantId}`).then((r) => (r.ok ? r.json() : null)),
        authFetch(`${API_URL}/api/assistants/${assistantId}/modes`).then((r) => (r.ok ? r.json() : null)),
        authFetch(`${API_URL}/api/pending-messages`).then((r) => (r.ok ? r.json() : null)),
        authFetch(`${API_URL}/api/connections/activity?assistantId=${assistantId}`).then((r) => (r.ok ? r.json() : null)),
      ]);

      if (assistantR) {
        setAssistant({
          id: assistantR.id,
          name: assistantR.name,
          iconSeed: assistantR.iconSeed,
          bio: assistantR.bio ?? null,
          workspaceId: assistantR.workspaceId ?? null,
        });
        setBioInput(assistantR.bio ?? "");
      }
      setFollowing(Array.isArray(followingR?.connections) ? followingR.connections : (followingR ?? []));
      setFollowers(Array.isArray(followersR?.connections) ? followersR.connections : (followersR ?? []));
      setPending(Array.isArray(pendingR?.connections) ? pendingR.connections : (pendingR ?? []));
      setCounts(countsR ?? { followers: 0, following: 0 });
      setModes(Array.isArray(modesR?.modes) ? modesR.modes : []);
      const allPending = Array.isArray(pendingMsgR?.pending) ? pendingMsgR.pending : [];
      setPendingApprovals(allPending);
      setActivity(Array.isArray(activityR?.activity) ? activityR.activity : []);
    } catch (err) {
      console.error("[NetworkTab] fetchAll failed:", err);
      showFeedback("error", t.sharingTab.failedLoad);
    } finally {
      setLoading(false);
    }
  }, [assistantId, showFeedback, t]);

  useEffect(() => {
    if (!hasFetched.current) {
      hasFetched.current = true;
      void fetchAll();
    }
  }, [fetchAll]);

  // Fast lookup: modeId -> Mode
  const modesById = new Map(modes.map((m) => [m.id, m]));

  // ── Bio ───────────────────────────────────────────────────────

  async function saveBio() {
    setSavingBio(true);
    try {
      const res = await authFetch(`${API_URL}/api/assistants/${assistantId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ bio: bioInput.trim() || null }),
      });
      if (res.ok) {
        const data = await res.json();
        setAssistant((a) => (a ? { ...a, bio: data.bio ?? null } : a));
        setEditingBio(false);
      } else {
        showFeedback("error", t.sharingTab.genericFailed);
      }
    } catch {
      showFeedback("error", t.sharingTab.networkError);
    } finally {
      setSavingBio(false);
    }
  }

  // ── Modes ────────────────────────────────────────────────────

  async function saveMode(input: Partial<Mode> & { name: string }) {
    try {
      const isEdit = editingMode && editingMode !== "new";
      const url = isEdit
        ? `${API_URL}/api/assistants/${assistantId}/modes/${(editingMode as Mode).id}`
        : `${API_URL}/api/assistants/${assistantId}/modes`;
      const res = await authFetch(url, {
        method: isEdit ? "PATCH" : "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (res.ok) {
        await fetchAll();
        setEditingMode(null);
      } else {
        const err = await res.json().catch(() => ({ error: t.sharingTab.genericFailed }));
        showFeedback("error", err.error ?? t.sharingTab.genericFailed);
      }
    } catch {
      showFeedback("error", t.sharingTab.networkError);
    }
  }

  async function deleteMode(modeId: string) {
    try {
      const res = await authFetch(`${API_URL}/api/assistants/${assistantId}/modes/${modeId}`, {
        method: "DELETE",
      });
      if (res.ok) {
        await fetchAll();
      } else {
        showFeedback("error", t.sharingTab.genericFailed);
      }
    } catch {
      showFeedback("error", t.sharingTab.networkError);
    }
  }

  // ── Connections ──────────────────────────────────────────────

  async function unfollowAssistant(targetId: string) {
    try {
      await authFetch(`${API_URL}/api/connections/unfollow`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ followerAssistantId: assistantId, followingAssistantId: targetId }),
      });
      await fetchAll();
    } catch {
      showFeedback("error", t.sharingTab.failedUnfollow);
    }
  }

  async function acceptRequest(connectionId: string) {
    try {
      const pick = acceptModePick[connectionId];
      const modeId = pick && pick !== NO_MODE ? pick : null;
      const res = await authFetch(`${API_URL}/api/connections/${connectionId}/accept`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modeId }),
      });
      if (res.ok) {
        await fetchAll();
      } else {
        showFeedback("error", t.sharingTab.genericFailed);
      }
    } catch {
      showFeedback("error", t.sharingTab.networkError);
    }
  }

  async function rejectRequest(connectionId: string) {
    try {
      await authFetch(`${API_URL}/api/connections/${connectionId}/reject`, { method: "POST" });
      await fetchAll();
    } catch {
      showFeedback("error", t.sharingTab.genericFailed);
    }
  }

  async function setConnectionMode(connectionId: string, modeId: string | null) {
    try {
      // No /set-mode route today — atomic cutover defers this to a follow-up.
      // For now, owner-initiated changes use unfollow + reaccept. This UI
      // surfaces the bound mode; changing it is a follow-up.
      void connectionId;
      void modeId;
      showFeedback("error", t.sharingTab.modeChangeComingSoon);
    } catch {
      showFeedback("error", t.sharingTab.networkError);
    }
  }

  async function approveDataRequest(messageId: string) {
    try {
      await authFetch(`${API_URL}/api/pending-messages/${messageId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      });
      await fetchAll();
    } catch {
      showFeedback("error", t.sharingTab.genericFailed);
    }
  }

  async function rejectDataRequest(messageId: string) {
    try {
      await authFetch(`${API_URL}/api/pending-messages/${messageId}/resolve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ decision: "rejected" }),
      });
      await fetchAll();
    } catch {
      showFeedback("error", t.sharingTab.genericFailed);
    }
  }

  // ── Render ───────────────────────────────────────────────────

  if (loading) {
    return <div className="p-4 text-muted-foreground text-sm">{t.sharingTab.loading}</div>;
  }

  return (
    <div className="space-y-6 p-4 max-w-4xl">
      {feedback && (
        <div
          className={`rounded-md border px-3 py-2 text-sm ${
            feedback.kind === "success" ? "border-green-600 text-green-600" : "border-red-600 text-red-600"
          }`}
        >
          {feedback.message}
        </div>
      )}

      {/* Profile card */}
      <section className="rounded-lg border p-4">
        <div className="flex items-start justify-between">
          <div className="flex-1">
            {editingBio ? (
              <div className="space-y-2">
                <textarea
                  value={bioInput}
                  onChange={(e) => setBioInput(e.target.value)}
                  placeholder={t.sharingTab.bioPlaceholder}
                  className="w-full text-sm rounded border bg-background px-2 py-1"
                  rows={2}
                />
                <div className="flex gap-2">
                  <button
                    onClick={saveBio}
                    disabled={savingBio}
                    className="text-xs text-primary font-medium"
                  >
                    {savingBio ? "..." : t.sharingTab.save}
                  </button>
                  <button
                    onClick={() => {
                      setBioInput(assistant?.bio ?? "");
                      setEditingBio(false);
                    }}
                    className="text-xs text-muted-foreground"
                  >
                    {t.sharingTab.cancel}
                  </button>
                </div>
                <p className="text-[11px] text-muted-foreground">{t.sharingTab.bioHint}</p>
              </div>
            ) : (
              <button
                onClick={() => setEditingBio(true)}
                className="text-left text-sm text-muted-foreground hover:text-foreground"
              >
                {assistant?.bio || t.sharingTab.addBio}
              </button>
            )}
          </div>
          <div className="text-xs text-muted-foreground space-x-3 ml-4">
            <span>
              {counts.followers === 1
                ? `1 ${t.sharingTab.follower}`
                : `${counts.followers} ${t.sharingTab.followers}`}
            </span>
            <span>{counts.following} {t.sharingTab.following}</span>
          </div>
        </div>
      </section>

      {/* Pending data approvals */}
      {pendingApprovals.length > 0 && (
        <section className="rounded-lg border p-4">
          <h3 className="text-sm font-medium mb-3">
            {format(t.sharingTab.pendingApprovals, { count: String(pendingApprovals.length) })}
          </h3>
          <div className="space-y-2">
            {pendingApprovals.map((p) => (
              <div key={p.id} className="rounded border p-3 text-sm">
                <p className="text-muted-foreground mb-2">
                  {format(t.sharingTab.askedQuestion, { question: p.payload.question ?? "" })}
                </p>
                <div className="flex gap-2">
                  <button
                    onClick={() => approveDataRequest(p.id)}
                    className="text-xs text-green-600 font-medium"
                  >
                    {t.sharingTab.approve}
                  </button>
                  <button
                    onClick={() => rejectDataRequest(p.id)}
                    className="text-xs text-red-600 font-medium"
                  >
                    {t.sharingTab.reject}
                  </button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Modes editor */}
      <section className="rounded-lg border p-4">
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-sm font-medium">
            {format(t.sharingTab.modesHeader, { count: String(modes.length) })}
          </h3>
          <button
            onClick={() => setEditingMode("new")}
            className="text-xs text-primary font-medium"
          >
            + {t.sharingTab.addMode}
          </button>
        </div>

        {modes.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t.sharingTab.modesEmpty}</p>
        ) : (
          <ul className="space-y-2">
            {modes.map((m) => (
              <li key={m.id} className="rounded border p-3 flex items-start justify-between">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium">{m.name}</p>
                  {m.description && (
                    <p className="text-xs text-muted-foreground mt-0.5">{m.description}</p>
                  )}
                  <p className="text-[11px] text-muted-foreground mt-1">
                    {format(t.sharingTab.modeSummary, {
                      count: String(m.exposedTools.length),
                      freshness:
                        m.freshness === "live"
                          ? t.sharingTab.freshnessLive
                          : t.sharingTab.freshnessSnapshot,
                    })}
                    {m.requireApproval && ` · ${t.sharingTab.approvalRequiredTag}`}
                  </p>
                </div>
                <div className="flex gap-2 ml-3">
                  <button onClick={() => setEditingMode(m)} className="text-xs text-primary">
                    {t.sharingTab.editMode}
                  </button>
                  <button
                    onClick={() => deleteMode(m.id)}
                    className="text-xs text-red-600"
                  >
                    {t.sharingTab.deleteBtn}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}

        {editingMode && (
          <ModeEditor
            mode={editingMode === "new" ? null : editingMode}
            onSave={saveMode}
            onCancel={() => setEditingMode(null)}
          />
        )}
      </section>

      {/* Connections sub-tabs */}
      <section className="rounded-lg border p-4">
        <div className="flex gap-2 mb-3 border-b">
          {(["following", "followers", "requests", "activity"] as SubTab[]).map((sub) => (
            <button
              key={sub}
              onClick={() => setSubTab(sub)}
              className={`text-xs px-3 py-2 ${
                subTab === sub
                  ? "border-b-2 border-primary text-foreground"
                  : "text-muted-foreground"
              }`}
            >
              {sub === "following"
                ? t.sharingTab.subTabFollowing
                : sub === "followers"
                ? t.sharingTab.subTabFollowers
                : sub === "requests"
                ? `${t.sharingTab.subTabRequests} (${pending.length})`
                : `${t.sharingTab.subTabActivity} (${activity.length})`}
            </button>
          ))}
        </div>

        {subTab === "following" && (
          <div className="space-y-2">
            {following.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t.sharingTab.searchToFollow}</p>
            ) : (
              following.map((c) => {
                const mode = c.modeId ? modesById.get(c.modeId) : null;
                return (
                  <div key={c.id} className="flex items-center justify-between text-sm border-b py-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{c.followingAssistantName ?? t.sharingTab.fallbackAssistant}</p>
                      <p className="text-[11px] text-muted-foreground">
                        @{c.followingOwnerHandle ?? "?"} ·{" "}
                        {mode ? format(t.sharingTab.modeBound, { name: mode.name }) : t.sharingTab.modeFree}
                      </p>
                    </div>
                    <button
                      onClick={() => unfollowAssistant(c.followingAssistantId)}
                      className="text-xs text-red-600 ml-2"
                    >
                      {t.sharingTab.btnUnfollow}
                    </button>
                  </div>
                );
              })
            )}
          </div>
        )}

        {subTab === "followers" && (
          <div className="space-y-2">
            {followers.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t.sharingTab.noFollowers}</p>
            ) : (
              followers.map((c) => {
                const mode = c.modeId ? modesById.get(c.modeId) : null;
                return (
                  <div key={c.id} className="flex items-center justify-between text-sm border-b py-2">
                    <div className="flex-1 min-w-0">
                      <p className="font-medium truncate">{c.followerAssistantName ?? t.sharingTab.fallbackAssistant}</p>
                      <p className="text-[11px] text-muted-foreground">
                        @{c.followerOwnerHandle ?? "?"} ·{" "}
                        {mode ? format(t.sharingTab.modeBound, { name: mode.name }) : t.sharingTab.modeFree}
                      </p>
                    </div>
                    <div className="flex gap-2 ml-2">
                      <Select
                        value={c.modeId ?? NO_MODE}
                        onValueChange={(v) =>
                          setConnectionMode(c.id, v === NO_MODE ? null : v)
                        }
                      >
                        <SelectTrigger size="sm" className="text-xs" aria-label={t.sharingTab.modePicker}>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent align="end">
                          <SelectItem value={NO_MODE}>{t.sharingTab.modePickerNone}</SelectItem>
                          {modes.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        )}

        {subTab === "requests" && (
          <div className="space-y-2">
            {pending.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t.sharingTab.noPendingRequests}</p>
            ) : (
              pending.map((c) => (
                <div key={c.id} className="border-b py-2 text-sm">
                  <p className="font-medium">{c.followerAssistantName ?? t.sharingTab.fallbackAssistant}</p>
                  <p className="text-[11px] text-muted-foreground mb-2">@{c.followerOwnerHandle ?? "?"}</p>
                  <p className="text-[11px] text-muted-foreground mb-1">{t.sharingTab.pickModeAtAccept}</p>
                  <Select
                    value={acceptModePick[c.id] ?? NO_MODE}
                    onValueChange={(v) =>
                      setAcceptModePick((prev) => ({ ...prev, [c.id]: v ?? NO_MODE }))
                    }
                  >
                    <SelectTrigger size="sm" className="text-xs mb-2 w-full" aria-label={t.sharingTab.modePicker}>
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NO_MODE}>{t.sharingTab.modePickerNone}</SelectItem>
                      {modes.map((m) => (
                        <SelectItem key={m.id} value={m.id}>
                          {m.requireApproval
                            ? format(t.sharingTab.modeOptionApproval, { name: m.name })
                            : m.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <div className="flex gap-2">
                    <button
                      onClick={() => acceptRequest(c.id)}
                      className="text-xs text-green-600 font-medium"
                    >
                      {t.sharingTab.accept}
                    </button>
                    <button
                      onClick={() => rejectRequest(c.id)}
                      className="text-xs text-red-600 font-medium"
                    >
                      {t.sharingTab.rejectFollower}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>
        )}

        {subTab === "activity" && (() => {
          const filtered = activitySearch.trim()
            ? activity.filter((s) =>
                s.callerName.toLowerCase().includes(activitySearch.toLowerCase()) ||
                (s.callerHandle ?? "").toLowerCase().includes(activitySearch.toLowerCase()) ||
                s.messages.some((m) => m.text.toLowerCase().includes(activitySearch.toLowerCase()))
              )
            : activity;
          const totalPages = Math.max(1, Math.ceil(filtered.length / ACTIVITY_PAGE_SIZE));
          const paged = filtered.slice(activityPage * ACTIVITY_PAGE_SIZE, (activityPage + 1) * ACTIVITY_PAGE_SIZE);
          return (
            <div className="space-y-3">
              <input
                type="text"
                placeholder={t.sharingTab.searchActivity}
                value={activitySearch}
                onChange={(e) => { setActivitySearch(e.target.value); setActivityPage(0); setExpandedSession(null); }}
                className="w-full h-9 px-3 text-[13px] bg-muted/30 border border-border rounded-lg focus:outline-none focus:border-primary/50 transition-colors"
              />

              <div className="space-y-2">
                {paged.map((session) => {
                  const isExpanded = expandedSession === session.sessionId;
                  const lastMsg = session.messages[session.messages.length - 1];
                  const preview = session.messages.find((m) => m.role === "user")?.text ?? "";
                  return (
                    <div key={session.sessionId} className={`rounded-xl border overflow-hidden transition-colors duration-150 ${isExpanded ? "border-primary/30" : "border-border"}`}>
                      <button
                        onClick={() => setExpandedSession(isExpanded ? null : session.sessionId)}
                        className="w-full flex items-center gap-3 px-4 py-3 text-left hover:bg-muted/20 transition-colors"
                      >
                        <AssistantAvatar id={session.callerAssistantId ?? session.sessionId} name={session.callerName} iconSeed={session.callerIconSeed} size="sm" />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-[13px] font-medium">{session.callerName}</span>
                            {session.callerHandle && <span className="text-[11px] text-muted-foreground font-mono">@{session.callerHandle}</span>}
                          </div>
                          <p className="text-[11px] text-muted-foreground truncate">{preview.slice(0, 80)}</p>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-[10px] text-muted-foreground">
                            {lastMsg && new Date(lastMsg.createdAt).toLocaleDateString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                          </span>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"
                            className={`text-muted-foreground transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}>
                            <path d="M3 4.5l3 3 3-3" />
                          </svg>
                        </div>
                      </button>

                      <div className={`grid transition-[grid-template-rows] duration-200 ease-out ${isExpanded ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}>
                        <div className="overflow-hidden">
                          <div className="px-4 py-3 space-y-3 border-t border-border">
                            {session.messages.map((m, mi) => (
                              m.role === "user" ? (
                                <div key={mi} className="flex items-end gap-2 justify-start">
                                  {mi === 0 || session.messages[mi - 1]?.role !== "user" ? (
                                    <AssistantAvatar id={session.callerAssistantId ?? session.sessionId} name={session.callerName} iconSeed={session.callerIconSeed} size="sm" />
                                  ) : (
                                    <div className="w-7 shrink-0" />
                                  )}
                                  <div className="max-w-[80%] rounded-2xl rounded-bl-sm bg-muted/40 px-3.5 py-2">
                                    <p className="text-[13px] leading-relaxed">{m.text || t.sharingTab.noTextFallback}</p>
                                    <span className="text-[10px] text-muted-foreground mt-1 block">
                                      {new Date(m.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                                    </span>
                                  </div>
                                </div>
                              ) : (
                                <div key={mi} className="flex items-end gap-2 justify-end">
                                  <div className="max-w-[80%] rounded-2xl rounded-br-sm bg-primary/10 px-3.5 py-2">
                                    <p className="text-[13px] leading-relaxed">{m.text || t.sharingTab.noTextFallback}</p>
                                    <span className="text-[10px] text-muted-foreground mt-1 block text-right">
                                      {new Date(m.createdAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                                    </span>
                                  </div>
                                  {mi === session.messages.length - 1 || session.messages[mi + 1]?.role !== "assistant" ? (
                                    <AssistantAvatar id={assistantId} name={assistant?.name ?? "?"} iconSeed={assistant?.iconSeed} size="sm" />
                                  ) : (
                                    <div className="w-7 shrink-0" />
                                  )}
                                </div>
                              )
                            ))}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
                {paged.length === 0 && (
                  <p className="text-[13px] text-muted-foreground text-center py-4">
                    {activitySearch ? t.sharingTab.noActivityMatch : t.sharingTab.noActivity}
                  </p>
                )}
              </div>

              {totalPages > 1 && (
                <div className="flex items-center justify-center gap-3 text-[12px]">
                  <button onClick={() => setActivityPage((p) => Math.max(0, p - 1))} disabled={activityPage === 0} className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">{t.sharingTab.previous}</button>
                  <span className="text-muted-foreground">{activityPage + 1} / {totalPages}</span>
                  <button onClick={() => setActivityPage((p) => Math.min(totalPages - 1, p + 1))} disabled={activityPage >= totalPages - 1} className="text-muted-foreground hover:text-foreground disabled:opacity-30 transition-colors">{t.sharingTab.next}</button>
                </div>
              )}
            </div>
          );
        })()}
      </section>
    </div>
  );
}

// ── Mode editor sub-component ──────────────────────────────────

function ModeEditor({
  mode,
  onSave,
  onCancel,
}: {
  mode: Mode | null;
  onSave: (input: Partial<Mode> & { name: string }) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [name, setName] = useState(mode?.name ?? "");
  const [description, setDescription] = useState(mode?.description ?? "");
  const [exposedTools, setExposedTools] = useState((mode?.exposedTools ?? []).join("\n"));
  const [freshness, setFreshness] = useState<"live" | "snapshot">(mode?.freshness ?? "live");
  const [requireApproval, setRequireApproval] = useState(mode?.requireApproval ?? false);
  const [allowOnward, setAllowOnward] = useState(mode?.allowOnwardConsults ?? false);

  return (
    <div className="mt-4 rounded border p-3 space-y-3 bg-muted/30">
      <div>
        <label className="block text-xs font-medium mb-1">{t.sharingTab.modeName}</label>
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={t.sharingTab.modeNamePlaceholder}
          className="w-full text-sm rounded border bg-background px-2 py-1"
        />
      </div>
      <div>
        <label className="block text-xs font-medium mb-1">{t.sharingTab.modeDescription}</label>
        <input
          value={description ?? ""}
          onChange={(e) => setDescription(e.target.value)}
          placeholder={t.sharingTab.modeDescriptionPlaceholder}
          className="w-full text-sm rounded border bg-background px-2 py-1"
        />
      </div>
      <div>
        <label className="block text-xs font-medium mb-1">{t.sharingTab.modeExposedTools}</label>
        <textarea
          value={exposedTools}
          onChange={(e) => setExposedTools(e.target.value)}
          rows={4}
          className="w-full text-xs font-mono rounded border bg-background px-2 py-1"
        />
        <p className="text-[10px] text-muted-foreground mt-1">{t.sharingTab.modeExposedToolsHelp}</p>
      </div>
      <div>
        <label className="block text-xs font-medium mb-1">{t.sharingTab.modeFreshness}</label>
        <Select
          value={freshness}
          onValueChange={(v) => setFreshness(v as "live" | "snapshot")}
        >
          <SelectTrigger size="sm" className="text-sm" aria-label={t.sharingTab.modeFreshness}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value="live">{t.sharingTab.freshnessLive}</SelectItem>
            <SelectItem value="snapshot">{t.sharingTab.freshnessSnapshot}</SelectItem>
          </SelectContent>
        </Select>
      </div>
      <div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={requireApproval}
            onChange={(e) => setRequireApproval(e.target.checked)}
          />
          {t.sharingTab.modeRequireApproval}
        </label>
        <p className="text-[10px] text-muted-foreground ml-5">{t.sharingTab.modeRequireApprovalHelp}</p>
      </div>
      <div>
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={allowOnward}
            onChange={(e) => setAllowOnward(e.target.checked)}
          />
          {t.sharingTab.modeAllowOnward}
        </label>
        <p className="text-[10px] text-muted-foreground ml-5">{t.sharingTab.modeAllowOnwardHelp}</p>
      </div>
      <div className="flex gap-2">
        <button
          onClick={() =>
            onSave({
              name: name.trim(),
              description: description.trim() || null,
              exposedTools: exposedTools
                .split("\n")
                .map((s) => s.trim())
                .filter(Boolean),
              freshness,
              requireApproval,
              allowOnwardConsults: allowOnward,
            })
          }
          disabled={!name.trim()}
          className="text-xs text-primary font-medium disabled:opacity-50"
        >
          {t.sharingTab.saveMode}
        </button>
        <button onClick={onCancel} className="text-xs text-muted-foreground">
          {t.sharingTab.cancel}
        </button>
      </div>
    </div>
  );
}
