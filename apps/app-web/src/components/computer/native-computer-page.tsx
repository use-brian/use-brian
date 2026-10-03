"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { desktopBridge } from "@/lib/desktop-auth-source";
import { nativeComputer, type DiscoveredTarget, isNativeTarget, nativeTargetKey } from "@/lib/native-computer";
import { useChatSessionsData } from "@/lib/chat-surface-data";
import { fetchWorkspaceTasks } from "@/lib/api/tasks";
import { useCachedResource } from "@/lib/surface-cache";
import { surfaceDataKey } from "@/lib/surface-prefetch";
import { ListSurfaceSkeleton } from "@/components/chrome/surface-skeleton";
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
  const t = useT().nativeComputer;
  const supported = !!desktopBridge()?.computerControl;
  const state = useSyncExternalStore(nativeComputer.subscribe, nativeComputer.snapshot, nativeComputer.serverSnapshot);
  const chat = useChatSessionsData(supported ? workspaceId : null);
  const tasks = useCachedResource(supported ? surfaceDataKey("tasks", workspaceId) : null, () => fetchWorkspaceTasks(workspaceId));
  const [assistantId, setAssistant] = useState("");
  const [conversationId, setConversation] = useState("");
  const [taskId, setTask] = useState("");
  const [goal, setGoal] = useState("");
  const [targets, setTargets] = useState<DiscoveredTarget[]>([]);
  const [targetKey, setTarget] = useState("");
  const [allowControl, setControl] = useState(false);
  const [allowCapture, setCapture] = useState(false);
  const [starting, setBusy] = useState(false);
  const busy = starting || !!state.readinessPending;
  const [failed, setFailed] = useState(false);
  const phase = state.status?.state ?? "unavailable";
  const target = targets.find(item => nativeTargetKey(item) === targetKey);
  const conversations = (chat.personal ?? []).filter(row => row.assistantId === assistantId);
  const active = phase === "active" || phase === "awaiting_action_approval" || phase === "awaiting_local_consent";
  const canControl = state.status?.capabilities.semanticActions === true;
  const canCapture = canControl && state.status?.capabilities.windowCapture === true;
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
    if (active || busy || state.inspection) return;
    let live = true;
    const refresh = async () => {
      try {
        const result = await desktopBridge()?.computerControl?.({ type: "targets" });
        if (live) setTargets(result?.ok ? (result.targets ?? []).filter(isNativeTarget) : []);
      } catch { if (live) setTargets([]); }
    };
    void refresh();
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 5000);
    return () => { live = false; clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [workspaceId, active, busy, state.inspection]);
  const resumable = phase === "paused_for_user" || phase === "stopped";
  const ready = phase === "ready" || phase === "ended" || resumable;
  const valid = !state.inspection && ready && !!target && !!goal.trim() && chat.assistants.some(a => a.id === assistantId) && conversations.some(c => c.id === conversationId) && !!tasks.data?.some(row => row.id === taskId);
  async function start() {
    if (!valid || !target || busy) return;
    // Recheck the live store as well: capabilities can change between render
    // and click. Reject the requested run; never coerce it into inspector mode.
    const capabilities = nativeComputer.snapshot().status?.capabilities;
    if (allowControl && capabilities?.semanticActions !== true || allowCapture && (!allowControl || capabilities?.windowCapture !== true)) {
      setFailed(true);
      return;
    }
    setBusy(true); setFailed(false);
    const result = await nativeComputer.start(resumable ? "resume" : "start", { workspaceId, assistantId, conversationId, taskId, goal: goal.trim(), target, allowControl, allowCapture });
    setFailed(!result.ok); setBusy(false);
  }
  return <section className="h-full overflow-y-auto p-4 md:p-6"><div className="mx-auto max-w-2xl space-y-5">
    <h1 className="text-xl font-semibold">{t.title}</h1><p className="text-sm text-muted-foreground">{t.intro}</p>
    <p role="status">{t.states[phase]}</p>
    {!supported || phase === "unavailable" ? <p>{t.unavailable}</p> : null}
    {phase === "permission_required" ? <p>{t.permissionHelp}</p> : null}
    {supported ? <div className="flex flex-wrap gap-2">
      <Button className="min-h-11" variant="outline" disabled={busy || active} onClick={() => void nativeComputer.send({ type: "check-readiness" })}>{t.checkReadiness}</Button>
      <Button className="min-h-11" variant="outline" disabled={busy || active} onClick={async () => { setFailed(!(await nativeComputer.send({ type: "permissions" })).ok); }}>{t.permissions}</Button>
      <Button className="min-h-11" variant="destructive" onClick={async () => { setFailed(!(await nativeComputer.stop()).ok); }}>{t.stop}</Button>
    </div> : null}
    {supported && state.readiness?.helperAdmitted ? <p role="status">{t.readinessPassed}</p> : null}
    {supported && state.readinessFailed ? <p role="alert" className="text-destructive">{t.readinessFailed}</p> : null}
    {state.inspection && state.status?.identity?.workspaceId === workspaceId ? <section aria-label={t.inspectorTitle} className="space-y-2">
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
    {failed ? <p role="alert" className="text-destructive">{t.error}</p> : null}
    {supported && (!chat.assistantsLoaded || !tasks.data && !tasks.error) ? <ListSurfaceSkeleton /> : null}
    {supported ? <>
      <p className="text-sm">{t.contextHelp} <Link className="underline" href={`/w/${workspaceId}/tasks`}>{t.tasks}</Link>{" · "}<Link className="underline" href={`/w/${workspaceId}/chat`}>{t.chat}</Link></p>
      <div className="grid gap-4 md:grid-cols-2">
        <Picker label={t.assistant} value={assistantId} disabled={busy || active} options={chat.assistants.map(a => ({ id: a.id, name: a.name }))} onChange={id => { setAssistant(id); setConversation(""); }} />
        <Picker label={t.conversation} value={conversationId} disabled={busy || active} options={conversations.map(c => ({ id: c.id, name: c.title || t.untitled }))} onChange={setConversation} />
        <Picker label={t.task} value={taskId} disabled={busy || active} options={(tasks.data ?? []).map(row => ({ id: row.id, name: row.title }))} onChange={setTask} />
        <Picker label={t.target} value={targetKey} disabled={busy || active} options={targets.map(item => ({ id: nativeTargetKey(item), name: `${item.displayName ? `${item.displayName} · ` : ""}${item.appId} · ${item.windowId}` }))} onChange={setTarget} />
      </div>
      {!targets.length ? <p className="text-sm">{t.noTargets}</p> : null}
      <label className="block space-y-1"><span>{t.goal}</span><textarea className="min-h-28 w-full rounded-md border bg-background p-3 text-base" maxLength={2000} value={goal} disabled={busy || active} onChange={e => setGoal(e.target.value)} /></label>
      <p className="text-sm">{allowControl ? t.observe : t.inspectorHelp}</p>
      <label className="flex min-h-11 items-center gap-3"><Checkbox checked={allowControl} onCheckedChange={value => { setControl(value); if (!value) setCapture(false); }} disabled={busy || active || !canControl} />{t.control}</label>
      <label className="flex min-h-11 items-center gap-3"><Checkbox checked={allowCapture} onCheckedChange={setCapture} disabled={busy || active || !allowControl || !canCapture} />{t.capture}</label>
      <p className="text-sm text-muted-foreground">{t.consent}</p>
      <Button className="min-h-11" disabled={!valid || busy || active} onClick={() => void start()}>{resumable ? t.resume : t.start}</Button>
    </> : null}
  </div></section>;
}
