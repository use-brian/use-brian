"use client";

/** Selected-app launcher and personal, browser-local menu order/rail pins.
 * Spec: docs/architecture/features/workspace-navigation.md.
 * [COMP:app-web/workspace-apps] */
import { useEffect, useState } from "react";
import type { CustomHomeApp } from "@/lib/api/home-apps";
import { OPERATOR_APP_KEYS, type HomeAppEntry } from "@/lib/operator-apps";
import { DEFAULT_HOME_APPS } from "@use-brian/shared/home-apps";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import { getUserInfo, subscribeUserInfo } from "@/lib/user";

export type WorkspaceAppId = HomeAppEntry;
export type WorkspaceApp = { id: WorkspaceAppId; custom?: CustomHomeApp };
const PREFERENCES_CHANGED = "doc:mini-app-preferences-changed";
type PreferenceChanged = { key: string; ids: string[] };

/** Config selects menu entries; it is not an authority grant or route gate. */
export function workspaceAppCatalogue(
  homeApps: readonly HomeAppEntry[],
  customApps: readonly CustomHomeApp[],
): WorkspaceApp[] {
  const available = new Map<string, WorkspaceApp>();
  for (const id of OPERATOR_APP_KEYS) {
    if (id !== "chat") available.set(id, { id });
  }
  for (const custom of customApps) {
    if (custom.status === "active" && custom.renderable) {
      const id = `custom:${custom.id}` as const;
      available.set(id, { id, custom });
    }
  }
  const ordered = new Set<string>(homeApps.length ? homeApps : DEFAULT_HOME_APPS);
  return [...ordered].flatMap((id) => {
    const app = available.get(id);
    return app ? [app] : [];
  });
}

export function miniAppPinsKey(apiOrigin: string, viewerId: string, workspaceId: string): string {
  return `doc:mini-app-pins:${[apiOrigin, viewerId, workspaceId].map(encodeURIComponent).join(":")}`;
}

export function miniAppMenuOrderKey(apiOrigin: string, viewerId: string, workspaceId: string): string {
  return `doc:mini-app-menu-order:${[apiOrigin, viewerId, workspaceId].map(encodeURIComponent).join(":")}`;
}

function decodeIds(raw: string | null, limit?: number): string[] {
  try {
    const value: unknown = JSON.parse(raw ?? "[]");
    return Array.isArray(value)
      ? [...new Set(value.filter((id): id is string => typeof id === "string"))].slice(0, limit)
      : [];
  } catch {
    return [];
  }
}

/** One identity and synchronization contract for both personal preferences. */
function useAppPreference(workspaceId: string, kind: "pins" | "order") {
  const [viewerId, setViewerId] = useState<string | null>(null);
  const [stored, setStored] = useState<PreferenceChanged | null>(null);
  const apiOrigin = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";
  const key = viewerId ? (kind === "pins" ? miniAppPinsKey : miniAppMenuOrderKey)(apiOrigin, viewerId, workspaceId) : null;
  const limit = kind === "order" ? 64 : undefined;

  useEffect(() => {
    setViewerId(getUserInfo()?.id ?? null);
    return subscribeUserInfo((user) => setViewerId(user?.id ?? null));
  }, []);

  useEffect(() => {
    if (!key) return;
    const read = () => {
      try { setStored({ key, ids: decodeIds(window.localStorage.getItem(key), limit) }); }
      catch { setStored({ key, ids: [] }); }
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === key || event.key === null) read();
    };
    const onChange = (event: Event) => {
      const detail = (event as CustomEvent<PreferenceChanged>).detail;
      if (detail?.key === key) setStored({ key, ids: decodeIds(JSON.stringify(detail.ids), limit) });
    };
    read();
    window.addEventListener("storage", onStorage);
    window.addEventListener(PREFERENCES_CHANGED, onChange);
    return () => {
      window.removeEventListener("storage", onStorage);
      window.removeEventListener(PREFERENCES_CHANGED, onChange);
    };
  }, [key, limit]);

  const ready = key !== null && stored?.key === key;
  const ids = ready ? stored.ids : [];
  function save(next: readonly string[], reset = false) {
    if (!key || !ready) return;
    const clean = decodeIds(JSON.stringify(next), limit);
    setStored({ key, ids: clean });
    try {
      if (reset) window.localStorage.removeItem(key);
      else window.localStorage.setItem(key, JSON.stringify(clean));
    } catch { /* Session view remains usable. */ }
    window.dispatchEvent(new CustomEvent<PreferenceChanged>(PREFERENCES_CHANGED, { detail: { key, ids: clean } }));
  }
  return { ids, save, ready };
}

export function useMiniAppPins(workspaceId: string, catalogue: readonly WorkspaceApp[]) {
  const { ids, save, ready } = useAppPreference(workspaceId, "pins");

  const available = new Set(catalogue.filter(app => app.id !== "chat").map((app) => app.id));
  const pins = ids.filter((id): id is WorkspaceAppId => available.has(id as WorkspaceAppId));

  function togglePin(id: WorkspaceAppId) {
    if (!ready || !available.has(id)) return;
    const next = pins.includes(id) ? pins.filter((pin) => pin !== id) : [...pins, id];
    save(next);
  }

  return { pins, togglePin, canPin: ready };
}

export function useMiniAppMenuOrder(workspaceId: string, catalogue: readonly WorkspaceApp[]) {
  const { ids, save, ready } = useAppPreference(workspaceId, "order");
  const available = new Map(catalogue.map(app => [app.id as string, app]));
  const order = [...new Set([...ids, ...catalogue.map(app => app.id)])]
    .flatMap(id => available.has(id) ? [available.get(id)!] : []);
  function move(id: WorkspaceAppId, direction: -1 | 1) {
    const index = order.findIndex(app => app.id === id), target = index + direction;
    if (!ready || index < 0 || target < 0 || target >= order.length) return;
    const next = order.map(app => app.id);
    [next[index], next[target]] = [next[target], next[index]];
    save(next);
  }
  return { order, move, reset: () => save([], true), canReorder: ready, customized: ids.length > 0 };
}
