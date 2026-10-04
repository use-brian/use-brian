"use client";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { desktopBridge } from "@/lib/desktop-auth-source";
import { nativeComputer, type DiscoveredTarget, isNativeTarget, nativeTargetKey, supportsNativeVisual } from "@/lib/native-computer";
import { useChatSessionsData } from "@/lib/chat-surface-data";
import { createNativeContextTask, fetchNativeContextTasks } from "@/lib/api/native-computer";
import { invalidateSurfaceCache, useCachedResource } from "@/lib/surface-cache";
import { nativeContextTasksCacheKey } from "@/lib/surface-prefetch";
import { ListSurfaceSkeleton } from "@/components/chrome/surface-skeleton";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

function Picker({ label, value, options, onChange, disabled }: { label: string; value: string; options: { id: string; name: string }[]; onChange: (id: string) => void; disabled?: boolean }) {
  return <div className="space-y-1"><span className="text-sm">{label}</span>
    <Select value={value || null} onValueChange={v => onChange(v ?? "")} disabled={disabled}>
      <SelectTrigger aria-label={label} className="min-h-11 w-full text-base"><SelectValue placeholder={label}>{options.find(o => o.id === value)?.name}</SelectValue></SelectTrigger>
      <SelectContent>{options.map(o => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}</SelectContent>
    </Select></div>;
}
export function NativeComputerPage({ workspaceId }: { workspaceId: string }) {
  const copy = useT();
  const t = copy.nativeComputer;
  const supported = !!desktopBridge()?.computerControl;
  const state = useSyncExternalStore(nativeComputer.subscribe, nativeComputer.snapshot, nativeComputer.serverSnapshot);
  const chat = useChatSessionsData(workspaceId);
  const [assistantId, setAssistant] = useState("");
  const [conversationId, setConversation] = useState("");
  const contextKey = !state.cleanupPending && assistantId && conversationId
    ? nativeContextTasksCacheKey(workspaceId, assistantId, conversationId) : null;
  const tasks = useCachedResource(contextKey, () => fetchNativeContextTasks(workspaceId, assistantId, conversationId));
  const [taskSelection, setTaskSelection] = useState<{ key: string | null; id: string } | null>(null);
  const taskId = taskSelection?.key === contextKey ? taskSelection?.id ?? "" : "";
  const setTask = (id: string) => setTaskSelection(id ? { key: contextKey, id } : null);

  useEffect(() => { setTaskSelection(null); }, [contextKey]);
  const eligibleTasks = contextKey && !tasks.error ? tasks.data ?? [] : [];
  const creation = useRef<{ key: string | null; revision: number }>({ key: contextKey, revision: 0 });
  if (creation.current.key !== contextKey) creation.current = { key: contextKey, revision: creation.current.revision + 1 };
  const promptAbort = useRef<AbortController | null>(null);
  const [creating, setCreating] = useState(false);
  const [createFailed, setCreateFailed] = useState(false);
  useEffect(() => {
    setCreating(false); setCreateFailed(false);
    return () => { creation.current.revision++; promptAbort.current?.abort(); };
  }, [contextKey]);
  async function createTask() {
    if (!contextKey || creating) return;
    const revision = creation.current.revision;
    const current = () => creation.current.key === contextKey && creation.current.revision === revision
      && nativeContextTasksCacheKey(workspaceId, assistantId, conversationId) === contextKey
      && !nativeComputer.snapshot().cleanupPending;
    const abort = new AbortController(); promptAbort.current = abort;
    setCreating(true); setCreateFailed(false);
    try {
      const title = await promptDialog({ title: t.createTask, description: t.createTaskHelp, confirmLabel: t.createTask, signal: abort.signal });
      if (!current() || title === null) return;
      if (!title.trim() || title.trim().length > 512) { setCreateFailed(true); return; }
      const task = await createNativeContextTask(workspaceId, assistantId, conversationId, title.trim());
      if (!current()) return;
      // Re-read through the existing permission-filtered picker. A successful
      // write does not authorize displaying/selecting a now-inaccessible task.
      // Detach any pre-mutation read; refresh alone would join its stale
      // promise. The cache also discards that old response if it arrives late.
      invalidateSurfaceCache(contextKey);
      const rows = await tasks.refresh();
      if (!current()) return;
      if (rows?.some(row => row.id === task.id)) setTaskSelection({ key: contextKey, id: task.id });
      else setCreateFailed(true);
    } catch { if (current()) setCreateFailed(true); }
    finally { if (current()) setCreating(false); }
  }

  const [goal, setGoal] = useState("");
  const [targets, setTargets] = useState<DiscoveredTarget[]>([]);
  const [targetKey, setTarget] = useState("");
  const [allowControl, setControl] = useState(false);
  const [allowCapture, setCapture] = useState(false);
  const [starting, setBusy] = useState(false);
  const busy = starting || !!state.readinessPending || !!state.cleanupPending;
  const [failed, setFailed] = useState(false);
  const phase = state.status?.state ?? "unavailable";
  const target = targets.find(item => nativeTargetKey(item) === targetKey);
  const conversations = (chat.personal ?? []).filter(row => row.assistantId === assistantId);
  const active = phase === "active" || phase === "awaiting_action_approval" || phase === "awaiting_local_consent";
  const canControl = state.status?.capabilities.semanticActions === true;
  const canCapture = supportsNativeVisual(state.status?.capabilities);
  // Cleanup crosses account/workspace boundaries; keep no previous task form behind it.
  useEffect(() => {
    setAssistant(""); setConversation(""); setTask(""); setGoal(""); setTargets([]); setTarget("");
    setControl(false); setCapture(false);
  }, [workspaceId, state.cleanupPending]);
  const setupRevision = nativeComputer.setupRevision;
  useEffect(() => { setControl(false); setCapture(false); }, [assistantId, conversationId, taskId, targetKey, setupRevision, state.verificationConsented]);
  // Main can revoke between polls without changing capabilities or verification.
  // Depend on the phase, not a terminal boolean: terminal-to-terminal transitions
  // reset too, while repeated polls and leaving a terminal phase keep fresh choices.
  useEffect(() => {
    if (["stopped", "paused_for_user", "ended", "unavailable", "permission_required"].includes(phase)) {
      setControl(false); setCapture(false);
    }
  }, [phase]);
  // Forget unsupported preferences, but surface the change rather than silently
  // treating a previously requested control run as an inspector run.
  useEffect(() => {
    if (allowControl && !canControl || allowCapture && (!allowControl || !canCapture)) {
      if (!canControl) setControl(false);
      setCapture(false);
      setFailed(true);
    }
  }, [allowControl, allowCapture, canControl, canCapture]);
  // Discovery is read-only and must never interrupt a live grant/approval.
  useEffect(() => {
    if (!supported || active || busy || state.inspection) return;
    let live = true;
    const refresh = async () => {
      try {
        // Share Stop/workspace/cleanup fencing with all other native requests.
        // A direct bridge call can return old window identities after revocation.
        const result = await nativeComputer.send({ type: "targets" });
        if (live) setTargets(result?.ok ? (result.targets ?? []).filter(isNativeTarget) : []);
      } catch { if (live) setTargets([]); }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 5000);
    return () => { live = false; clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [workspaceId, supported, active, busy, state.inspection]);
  const resumable = phase === "paused_for_user" || phase === "stopped";
  const ready = phase === "ready" || phase === "ended" || resumable;
  const valid = !state.inspection && ready && !!target && !!goal.trim() && chat.assistants.some(a => a.id === assistantId) && conversations.some(c => c.id === conversationId) && eligibleTasks.some(row => row.id === taskId);
  async function openPermissions(permission: "accessibility" | "screen-recording") {
    if (busy || active) return;
    setBusy(true); setFailed(false);
    try { setFailed(!(await nativeComputer.send({ type: "permissions", permission })).ok); }
    finally { setBusy(false); }
  }
  async function acknowledgeVerification() {
    if (busy || active || !nativeComputer.snapshot().verificationAvailable) return;
    setBusy(true); setFailed(false); setControl(false); setCapture(false); setTargets([]); setTarget("");
    try {
      const result = await nativeComputer.send({ type: "acknowledge-verification" });
      setFailed(!result.ok || result.verificationConsented !== true);
    } finally { setBusy(false); }
  }
  async function start() {
    if (!valid || !target || busy) return;
    // Recheck the live store as well: capabilities can change between render
    // and click. Reject the requested run; never coerce it into inspector mode.
    const capabilities = nativeComputer.snapshot().status?.capabilities;
    if (allowControl && capabilities?.semanticActions !== true || allowCapture && (!allowControl || !supportsNativeVisual(capabilities))) {
      setFailed(true);
      return;
    }
    setBusy(true); setFailed(false);
    const result = await nativeComputer.start(resumable ? "resume" : "start", { workspaceId, assistantId, conversationId, taskId, goal: goal.trim(), target, allowControl, allowCapture });
    setFailed(!result.ok); setBusy(false);
  }
  return <section className="h-full overflow-y-auto p-4 md:p-6"><div className="mx-auto max-w-2xl space-y-5">
    <h1 className="text-xl font-semibold">{t.title}</h1><p className="text-sm text-muted-foreground">{t.intro}</p>
    <p className="text-sm text-muted-foreground">{t.supportedScope}</p>
    <p role="status">{state.cleanupPending ? t.cleanupPending : t.states[phase]}</p>
    {!supported || phase === "unavailable" ? <p>{t.unavailable}</p> : null}
    {phase === "permission_required" ? <p>{t.permissionHelp}</p> : null}
    {supported ? <div className="flex flex-wrap gap-2">
      <Button className="min-h-11" variant="outline" disabled={busy || active} onClick={() => void nativeComputer.send({ type: "check-readiness" })}>{t.checkReadiness}</Button>
      <Button className="min-h-11" variant="outline" disabled={busy || active} onClick={() => void openPermissions("accessibility")}>{t.permissions}</Button>
      <Button className="min-h-11" variant="outline" disabled={busy || active} onClick={() => void openPermissions("screen-recording")}>{t.screenRecordingSettings}</Button>
      <Button className="min-h-11" variant="destructive" onClick={async () => { setFailed(!(await nativeComputer.stop()).ok); }}>{t.stop}</Button>
    </div> : null}
    {supported && state.verificationAvailable ? <div className="space-y-2">
      <p className="text-sm text-muted-foreground">{t.verificationHelp}</p>
      <Button className="min-h-11 whitespace-normal" variant="outline" disabled={busy || active || state.verificationConsented === true} onClick={() => void acknowledgeVerification()}>{t.verificationAcknowledge}</Button>
      {state.verificationConsented === true ? <p role="status">{t.verificationConfirmed}</p> : null}
    </div> : null}
    {supported && state.readiness?.helperAdmitted ? <p role="status">{t.readinessPassed}</p> : null}
    {supported && state.readinessFailed ? <p role="alert" className="text-destructive">{t.readinessFailed}</p> : null}
    {!state.cleanupPending && state.inspection && state.status?.identity?.workspaceId === workspaceId ? <section aria-label={t.inspectorTitle} className="space-y-2">
      <h2 className="font-semibold">{t.inspectorTitle}</h2>
      <p className="break-all text-sm">{t.inspectorSnapshot}: {state.inspection.id} · <time dateTime={new Date(state.inspection.capturedAt).toISOString()}>{new Date(state.inspection.capturedAt).toLocaleString()}</time> · {t.inspectorCompleteness[state.inspection.completeness]}</p>
      <p className="text-sm">{t.inspectorStatic}</p>
      <Button className="min-h-11" variant="outline" onClick={() => { setTargets([]); setTarget(""); nativeComputer.clearInspection(); }}>{t.inspectorNew}</Button>
      <div className="overflow-x-auto"><table className="w-full text-left text-sm">
        <thead><tr>{[t.inspectorRole, t.inspectorName, t.inspectorValue, t.inspectorEnabled, t.inspectorSensitive].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead>
        <tbody>{state.inspection.nodes.slice(0, 500).map((node, index) => <tr key={index}>
          <td className="break-all p-2">{node.role}</td><td className="break-all p-2">{node.sensitive ? t.inspectorRedacted : node.name}</td>
          <td className="break-all p-2">{node.sensitive ? t.inspectorRedacted : node.value ?? ""}</td>
          <td className="p-2">{node.enabled ? t.inspectorYes : t.inspectorNo}</td><td className="p-2">{node.sensitive ? t.inspectorYes : t.inspectorNo}</td>
        </tr>)}</tbody>
      </table></div>
    </section> : null}
    {contextKey && tasks.error ? <div role="alert" className="text-sm text-muted-foreground">
      {copy.tasksPage.loadFailed}{" "}<Button variant="outline" className="min-h-11" disabled={tasks.revalidating} onClick={() => void tasks.refresh()}>{copy.tasksPage.retry}</Button>
    </div> : null}
    {failed ? <p role="alert" className="text-destructive">{t.error}</p> : null}
    {(!chat.assistantsLoaded || contextKey && !tasks.data && !tasks.error) ? <ListSurfaceSkeleton /> : null}
    {!state.cleanupPending ? <>
      <p className="text-sm">{t.contextHelp} <Link className="underline" href={`/w/${workspaceId}/tasks`}>{t.tasks}</Link>{" · "}<Link className="underline" href={`/w/${workspaceId}/chat`}>{t.chat}</Link></p>
      <div className="grid gap-4 md:grid-cols-2">
        <Picker label={t.assistant} value={assistantId} disabled={busy || active} options={chat.assistants.map(a => ({ id: a.id, name: a.name }))} onChange={id => { setAssistant(id); setConversation(""); setTask(""); }} />
        <Picker label={t.conversation} value={conversationId} disabled={busy || active} options={conversations.map(c => ({ id: c.id, name: c.title || t.untitled }))} onChange={id => { setConversation(id); setTask(""); }} />
        <Picker label={t.task} value={taskId} disabled={busy || active} options={eligibleTasks.map(row => ({ id: row.id, name: row.title }))} onChange={setTask} />
        {supported ? <Picker label={t.target} value={targetKey} disabled={busy || active} options={targets.map(item => ({ id: nativeTargetKey(item), name: `${item.displayName ? `${item.displayName} · ` : ""}${item.appId} · ${item.windowId}` }))} onChange={setTarget} /> : null}
      </div>
      <div className="space-y-2">
        <Button variant="outline" className="min-h-11" disabled={!contextKey || creating || busy || active} onClick={() => void createTask()}>{t.createTask}</Button>
        <p className="text-sm text-muted-foreground">{t.createTaskHelp}</p>
        {createFailed ? <p role="alert" className="text-destructive">{t.createTaskFailed}</p> : null}
      </div>
      {supported ? <>
      {!targets.length ? <p className="text-sm">{t.noTargets}</p> : null}
      <label className="block space-y-1"><span>{t.goal}</span><textarea className="min-h-28 w-full rounded-md border bg-background p-3 text-base" maxLength={2000} value={goal} disabled={busy || active} onChange={e => setGoal(e.target.value)} /></label>
      <p className="text-sm">{allowControl ? t.observe : t.inspectorHelp}</p>
      <label className="flex min-h-11 items-center gap-3"><Checkbox checked={allowControl} onCheckedChange={value => { setControl(value); if (!value) setCapture(false); }} disabled={busy || active || !canControl} />{t.control}</label>
      <label className="flex min-h-11 items-center gap-3"><Checkbox checked={allowCapture} onCheckedChange={setCapture} disabled={busy || active || !allowControl || !canCapture} />{t.capture}</label>
      <p className="text-sm text-muted-foreground">{t.visualScope}</p>
      <p className="text-sm text-muted-foreground">{t.consent}</p>
      <Button className="min-h-11" disabled={!valid || busy || active} onClick={() => void start()}>{resumable ? t.resume : t.start}</Button>
      </> : null}
    </> : null}
  </div></section>;
}
