"use client";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { desktopBridge } from "@/lib/desktop-auth-source";
import { nativeComputer, type DesktopComputerControlResult, type DiscoveredTarget, isNativeTarget, nativeTargetIdentity, nativeTargetKey, supportsNativeVisual } from "@/lib/native-computer";
import { blocksComputerProfileCreation, computerProfileErrorCode, type ComputerProfileErrorCode, createComputerProfile, updateComputerProfile, deleteComputerProfile, useComputerProfiles } from "@/lib/api/computer-profiles";
import { ListSurfaceSkeleton } from "@/components/chrome/surface-skeleton";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

/** Verification may open a control ceiling, never an OS permission denial. */
function requestedScope(state: DesktopComputerControlResult) {
  const caps = state.status?.capabilities;
  const phase = state.status?.state ?? "unavailable";
  const permissionBlocked = phase === "permission_required" || caps?.accessibilityPermission === "denied";
  const captureDenied = caps?.capturePermission === "denied";
  const verificationPending = state.verificationAvailable === true && state.verificationConsented !== true;
  const controlSupported = caps?.semanticActions === true;
  const captureSupported = supportsNativeVisual(caps);
  return {
    permissionBlocked, captureDenied, verificationPending, controlSupported, captureSupported,
    canControl: !permissionBlocked && (controlSupported || verificationPending),
    canCapture: !permissionBlocked && !captureDenied && (captureSupported || verificationPending),
    ready: !permissionBlocked && (["ready", "ended", "stopped", "paused_for_user"].includes(phase) || verificationPending),
  };
}
function Picker({ label, value, options, onChange, disabled }: { label: string; value: string; options: { id: string; name: string }[]; onChange: (id: string) => void; disabled?: boolean }) {
  return <div className="space-y-1"><span className="text-sm">{label}</span>
    <Select value={value || null} onValueChange={v => onChange(v ?? "")} disabled={disabled}>
      <SelectTrigger aria-label={label} className="min-h-11 w-full text-base"><SelectValue placeholder={label}>{options.find(o => o.id === value)?.name}</SelectValue></SelectTrigger>
      <SelectContent>{options.map(o => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}</SelectContent>
    </Select></div>;
}
export function NativeComputerPage({ workspaceId }: { workspaceId: string }) {
  return <ProfilePage key={workspaceId} workspaceId={workspaceId} />;
}
function ProfilePage({ workspaceId }: { workspaceId: string }) {
  const copy = useT(); const t = copy.nativeComputer; const p = copy.computerProfiles;
  const supported = !!desktopBridge()?.computerControl;
  const state = useSyncExternalStore(nativeComputer.subscribe, nativeComputer.snapshot, nativeComputer.serverSnapshot);
  const { profiles, error, errorCode, refresh } = useComputerProfiles(workspaceId);
  const [profileId, setProfile] = useState("");
  const profile = profiles?.find(row => row.id === profileId);
  const [mutationError, setMutationError] = useState<ComputerProfileErrorCode | null>(null);
  const [discovered, setDiscovered] = useState(false);
  const discoveryRequest = useRef(0);
  const [targets, setTargets] = useState<DiscoveredTarget[]>([]);
  const [targetKey, setTarget] = useState("");
  const [allowControl, setControl] = useState(false);
  const [allowCapture, setCapture] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const alive = useRef(true); const revision = useRef(0); const operation = useRef(false);
  const abort = useRef<AbortController | null>(null);
  useEffect(() => { alive.current = true; return () => { alive.current = false; ++revision.current; abort.current?.abort(); }; }, []);
  const phase = state.status?.state ?? "unavailable";
  const sessionActive = ["active", "awaiting_action_approval", "awaiting_local_consent"].includes(phase);
  const active = !!state.profileConnected || sessionActive;
  const locked = busy || active || !!state.cleanupPending || !!state.readinessPending;
  // Settings explicitly stop local access in main. An idle profile connection
  // must not trap a user behind a newly denied TCC permission.
  const permissionsLocked = busy || sessionActive || !!state.cleanupPending || !!state.readinessPending;
  const setupLocked = locked || !!state.inspection;
  // These are request preferences, not grants. Packaged verification opens its
  // control ceiling only inside Connect's native dialog, so pre-consent helper
  // capabilities cannot be a prerequisite for expressing the requested scope.
  const { verificationPending, controlSupported, captureSupported, canControl, canCapture, permissionBlocked, captureDenied, ready } = requestedScope(state);
  const inspection = !state.cleanupPending && state.status?.identity?.workspaceId === workspaceId ? state.inspection : undefined;
  const setupRevision = nativeComputer.setupRevision;
  function reset() { ++revision.current; setControl(false); setCapture(false); setTargets([]); setDiscovered(false); setTarget(""); }
  useEffect(() => { reset(); }, [profileId, setupRevision, state.cleanupPending]);
  useEffect(() => { ++revision.current; setControl(false); setCapture(false); }, [targetKey, controlSupported, captureSupported, verificationPending, permissionBlocked, captureDenied, phase]);
  useEffect(() => {
    if (allowControl && !canControl || allowCapture && !canCapture) setFailed(true);
  }, [allowControl, allowCapture, canControl, canCapture]);
  const targetPresent = targets.some(item => nativeTargetKey(item) === targetKey);
  const profilePresent = !!profile;
  useEffect(() => {
    if (!profilePresent || !targetPresent) { ++revision.current; setControl(false); setCapture(false); }
  }, [profilePresent, targetPresent]);
  const discover = useCallback(async () => {
    if (!supported || locked || state.inspection) return;
    const seq = ++discoveryRequest.current; const rev = revision.current;
    const generation = nativeComputer.setupRevision;
    const current = () => alive.current && seq === discoveryRequest.current && rev === revision.current && generation === nativeComputer.setupRevision;
    try {
      const result = await nativeComputer.send({ type: "targets" });
      if (!current()) return;
      const success = result.ok && Array.isArray(result.targets);
      setDiscovered(success);
      setTargets(success ? result.targets!.filter(isNativeTarget) : []);
    } catch {
      if (current()) { setDiscovered(false); setTargets([]); }
    }
  }, [supported, locked, state.inspection]);
  useEffect(() => {
    void discover(); window.addEventListener("focus", discover);
    const timer = setInterval(discover, 5000);
    return () => { ++discoveryRequest.current; clearInterval(timer); window.removeEventListener("focus", discover); };
  }, [discover, profileId, setupRevision, state.cleanupPending]);
  const creationBlocked = blocksComputerProfileCreation(errorCode) || blocksComputerProfileCreation(mutationError);
  async function manage(kind: "create" | "rename" | "delete") {
    if (operation.current || (kind === "create" && creationBlocked) || (kind !== "create" && !profile)) return;
    operation.current = true; setBusy(true); setFailed(false); setMutationError(null);
    const controller = new AbortController(); abort.current = controller;
    try {
      if (kind === "delete") {
        if (!await confirmDialog({ description: p.deleteConfirm, confirmLabel: p.delete, variant: "destructive", signal: controller.signal }) || !alive.current) return;
        await deleteComputerProfile(profile!.id);
        if (alive.current) { setProfile(""); reset(); }
      } else {
        const name = await promptDialog({ title: kind === "create" ? p.create : p.rename, placeholder: p.name, defaultValue: kind === "rename" ? profile!.name : "", signal: controller.signal });
        if (name === null || !alive.current) return;
        if (!name.trim() || name.trim().length > 120) { setFailed(true); return; }
        const saved = kind === "create" ? await createComputerProfile(workspaceId, name.trim()) : await updateComputerProfile(profile!.id, { name: name.trim() });
        if (alive.current) setProfile(saved.id);
      }
      if (alive.current) await refresh();
    } catch (error) { if (alive.current) setMutationError(computerProfileErrorCode(error)); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  }
  async function connect() {
    if (locked || operation.current || state.inspection || !ready || !profile || !targetKey) return;
    const rev = revision.current; const generation = nativeComputer.setupRevision;
    operation.current = true; setBusy(true); setFailed(false); setMutationError(null);
    try {
      // A click never trusts a previously displayed window identity. Strip labels
      // and fence discovery against Stop, context changes, and capability loss.
      const result = await nativeComputer.send({ type: "targets" });
      if (!alive.current || rev !== revision.current || generation !== nativeComputer.setupRevision) return;
      const target = result.ok ? result.targets?.filter(isNativeTarget).find(item => nativeTargetKey(item) === targetKey) : undefined;
      const current = nativeComputer.snapshot();
      const scope = requestedScope(current);
      if (!target || current.cleanupPending || current.inspection || !scope.ready || allowControl && !scope.canControl || allowCapture && (!allowControl || !scope.canCapture)) { setFailed(true); reset(); return; }
      const connected = await nativeComputer.send({ type: "connect-profile", workspaceId, profileId: profile.id, target: nativeTargetIdentity(target), allowControl, allowCapture });
      if (alive.current && generation === nativeComputer.setupRevision) {
        setMutationError(!connected.ok ? connected.profileErrorCode ?? null : null);
        setFailed(!connected.ok && !connected.profileErrorCode); setControl(false); setCapture(false); void refresh();
      }
    } catch { if (alive.current) setFailed(true); }
    finally { operation.current = false; if (alive.current) setBusy(false); }
  }
  async function openPermissions(permission: "accessibility" | "screen-recording") {
    if (permissionsLocked || operation.current) return;
    operation.current = true; setBusy(true); setFailed(false);
    try {
      const result = await nativeComputer.send({ type: "permissions", permission });
      if (alive.current) setFailed(!result.ok);
    } finally { operation.current = false; if (alive.current) setBusy(false); }
  }
  async function disconnect() {
    reset(); setFailed(false);
    const result = await nativeComputer.send({ type: "disconnect-profile" });
    if (alive.current) { setFailed(!result.ok); void refresh(); }
  }
  return <section className="h-full overflow-y-auto p-4 md:p-6"><div className="mx-auto max-w-2xl space-y-5">
    <h1 className="text-xl font-semibold">{p.title}</h1>
    <p className="text-sm text-muted-foreground">{p.privateHelp}</p>
    <p className="text-sm">{p.chatHelp} <Link className="inline-flex min-h-11 items-center underline" href={`/w/${workspaceId}/studio`}>{p.studio}</Link>{" · "}<Link className="inline-flex min-h-11 items-center underline" href={`/w/${workspaceId}/chat`}>{t.chat}</Link></p>
    <Button className="min-h-11" disabled={busy || creationBlocked} onClick={() => void manage("create")}>{p.create}</Button>
    {error || mutationError ? <p role="alert">{p.errors[mutationError ?? errorCode ?? "computer_profiles_unavailable"]} <Button className="min-h-11" variant="outline" onClick={() => { setMutationError(null); void refresh(); }}>{p.retry}</Button></p> : profiles === null ? <ListSurfaceSkeleton /> : !profiles.length ? <p>{p.empty}</p> : null}
    <Picker label={p.select} value={profileId} disabled={setupLocked} options={profiles ?? []} onChange={setProfile} />
    {profile ? <div className="space-y-2 rounded-xl border p-4"><h2 className="font-medium">{profile.name}</h2><p role="status">{profile.connected || state.profileConnected && state.profileId === profile.id ? p.online : p.offline}</p><div className="flex flex-wrap gap-2">
      <Button className="min-h-11" variant="outline" disabled={locked} onClick={() => void manage("rename")}>{p.rename}</Button>
      <Button className="min-h-11" variant="destructive" disabled={locked} onClick={() => void manage("delete")}>{p.delete}</Button>
    </div></div> : null}
    {!supported ? <p>{p.browserHelp}</p> : <>
      <p role="status">{state.cleanupPending ? t.cleanupPending : t.states[phase]}</p>
      {!ready || state.readinessFailed ? <p role="alert">{p.blocked} {permissionBlocked ? t.permissionHelp : null}</p> : null}
      {captureDenied ? <p role="alert" className="text-sm">{p.captureDenied}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button className="min-h-11" variant="outline" disabled={locked} onClick={() => void nativeComputer.send({ type: "check-readiness" })}>{t.checkReadiness}</Button>
        <Button className="min-h-11" variant="outline" disabled={permissionsLocked} onClick={() => void openPermissions("accessibility")}>{t.permissions}</Button>
        <Button className="min-h-11" variant="outline" disabled={permissionsLocked} onClick={() => void openPermissions("screen-recording")}>{t.screenRecordingSettings}</Button>
        <Button className="min-h-11" variant="destructive" onClick={() => void disconnect()}>{p.disconnect}</Button>
      </div>
      {inspection ? <section aria-label={t.inspectorTitle} className="space-y-2">
        <h2 className="font-semibold">{t.inspectorTitle}</h2>
        <p className="break-all text-sm">{t.inspectorSnapshot}: {inspection.id} · <time dateTime={new Date(inspection.capturedAt).toISOString()}>{new Date(inspection.capturedAt).toLocaleString()}</time> · {t.inspectorCompleteness[inspection.completeness]}</p>
        <p className="text-sm">{t.inspectorStatic}</p>
        <Button className="min-h-11" variant="outline" onClick={() => { reset(); nativeComputer.clearInspection(); }}>{t.inspectorNew}</Button>
        <div className="overflow-x-auto"><table className="w-full text-left text-sm">
          <thead><tr>{[t.inspectorRole, t.inspectorName, t.inspectorValue, t.inspectorEnabled, t.inspectorSensitive].map(label => <th key={label} className="p-2">{label}</th>)}</tr></thead>
          <tbody>{inspection.nodes.slice(0, 500).map((node, index) => <tr key={index}>
            <td className="break-all p-2">{node.role}</td><td className="break-all p-2">{node.sensitive ? t.inspectorRedacted : node.name}</td>
            <td className="break-all p-2">{node.sensitive ? t.inspectorRedacted : node.value ?? ""}</td>
            <td className="p-2">{node.enabled ? t.inspectorYes : t.inspectorNo}</td><td className="p-2">{node.sensitive ? t.inspectorYes : t.inspectorNo}</td>
          </tr>)}</tbody>
        </table></div>
      </section> : null}
      <Picker label={t.target} value={targetKey} disabled={setupLocked} options={targets.map(item => ({ id: nativeTargetKey(item), name: `${item.displayName ? `${item.displayName} · ` : ""}${item.appId} · ${item.windowId}` }))} onChange={setTarget} />
      <Button className="min-h-11" variant="outline" disabled={setupLocked} onClick={() => void discover()}>{t.refreshWindows}</Button>
      {!targets.length ? <p className="text-sm">{discovered ? t.noTargets : t.windowsNotChecked}</p> : null}
      <label className="flex min-h-11 items-center gap-3"><Checkbox checked={allowControl} onCheckedChange={value => { setControl(value); if (!value) setCapture(false); }} disabled={setupLocked || !canControl} />{t.control}</label>
      <label className="flex min-h-11 items-center gap-3"><Checkbox checked={allowCapture} onCheckedChange={setCapture} disabled={setupLocked || !allowControl || !canCapture} />{t.capture}</label>
      {!allowControl ? <p className="text-sm text-muted-foreground">{p.inspectHelp}</p> : null}
      <p className="text-sm text-muted-foreground">{t.visualScope}</p>
      {verificationPending ? <p className="text-sm text-muted-foreground">{p.pendingVerification}</p> : null}
      <p className="text-sm text-muted-foreground">{p.consent}</p>
      <Button className="min-h-11" disabled={locked || !!state.inspection || !ready || !profile || !targetPresent} onClick={() => void connect()}>{allowControl ? p.connect : p.inspect}</Button>
    </>}
    {failed ? <p role="alert" className="text-destructive">{supported ? p.connectionError : p.error}</p> : null}
  </div></section>;
}
