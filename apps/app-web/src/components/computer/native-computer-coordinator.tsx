"use client";
import { useEffect, useSyncExternalStore } from "react";
import Link from "next/link";
import { desktopBridge } from "@/lib/desktop-auth-source";
import { nativeComputer } from "@/lib/native-computer";
import { useT } from "@/lib/i18n/client";
import { Button } from "@/components/ui/button";

export function NativeComputerCoordinator({ workspaceId }: { workspaceId: string }) {
  const result = useSyncExternalStore(nativeComputer.subscribe, nativeComputer.snapshot, nativeComputer.serverSnapshot);
  const t = useT().nativeComputer;
  const supported = !!desktopBridge()?.computerControl;
  useEffect(() => {
    if (!supported) return;
    let live = true;
    void nativeComputer.enter(workspaceId).then(() => { if (live) void nativeComputer.check(); });
    const check = () => { void nativeComputer.check(); };
    const timer = setInterval(check, 3000);
    window.addEventListener("focus", check);
    return () => { live = false; clearInterval(timer); window.removeEventListener("focus", check); void nativeComputer.leave(); };
  }, [workspaceId, supported]);
  if (!supported) return null;
  const state = result.status?.state ?? "unavailable";
  return <div className="flex flex-wrap items-center gap-2 border-b px-3 text-sm" aria-live="polite">
    <Link className="inline-flex min-h-11 items-center underline" href={`/w/${workspaceId}/computer/native`}>{t.title}: {result.cleanupPending ? t.cleanupPending : t.states[state]}</Link>
    <Button className="min-h-11" variant="outline" onClick={() => void nativeComputer.stop()}>{t.stop}</Button>
  </div>;
}
