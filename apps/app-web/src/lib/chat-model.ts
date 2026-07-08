"use client";

/**
 * Shared doc chat model-tier state: the `standard | pro | max` choice,
 * persisted to one `localStorage` key so every surface (the floating dock,
 * the default-viewer landing) agrees, plus plan-gating so an over-tier
 * choice snaps down to what the workspace's plan allows.
 *
 * The floating chat keeps its own inline copy (historical); this hook is the
 * shared seam for new surfaces. Both read/write the same `MODEL_STORAGE_KEY`,
 * so the choice carries across — and the build flow also passes the picked
 * tier through the chat-seed, so an in-flight turn always uses it regardless
 * of which surface is mounted.
 *
 * [COMP:app-web/chat-model]
 */

import { useEffect, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type ModelTier = "standard" | "pro" | "max";

/** Persisted so the choice sticks across reloads + surfaces. */
const MODEL_STORAGE_KEY = "doc-chat-model";

function readCachedTier(): ModelTier | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.localStorage.getItem(MODEL_STORAGE_KEY);
    return v === "standard" || v === "pro" || v === "max" ? v : null;
  } catch {
    return null;
  }
}

export type ChatModelState = {
  model: ModelTier;
  setModel: (tier: ModelTier) => void;
  /** Workspace plan once resolved (`free` / `pro` / `max` / …), else null. */
  plan: string | null;
};

/**
 * Model-tier state for a chat surface. Initial value is the cached choice if
 * present, else `defaultTier`. Persists on change, resolves the workspace
 * plan, and snaps an over-tier selection down once the plan is known.
 */
export function useChatModelTier(
  workspaceId: string,
  defaultTier: ModelTier,
): ChatModelState {
  const [model, setModel] = useState<ModelTier>(
    () => readCachedTier() ?? defaultTier,
  );
  const [plan, setPlan] = useState<string | null>(null);

  // Persist the choice (shared key across surfaces).
  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(MODEL_STORAGE_KEY, model);
    } catch {
      /* private mode — non-fatal */
    }
  }, [model]);

  // Resolve the workspace plan for tier gating (per-workspace billing).
  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    authFetch(
      `${API_URL}/api/usage?workspace_id=${encodeURIComponent(workspaceId)}`,
    )
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { plan?: string } | null) => {
        if (cancelled || !data?.plan) return;
        setPlan(data.plan);
      })
      .catch(() => {
        /* gating stays permissive; the server clamps the tier anyway */
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Snap an over-tier selection down once the plan resolves.
  useEffect(() => {
    if (plan === "free" && model !== "standard") setModel("standard");
    else if (plan === "pro" && model === "max") setModel("pro");
  }, [plan, model]);

  // Paid workspaces default to Pro (cost-and-pricing → "Default chat is Pro").
  // The legacy default was Standard, so on the first paid plan-load (once per
  // device, guarded by a shared flag alongside MODEL_STORAGE_KEY) raise a
  // still-Standard selection up to Pro. A previously-chosen Pro/Max is a
  // genuine upgrade and left untouched; once migrated a deliberate Standard
  // choice sticks. Free plans are clamped to Standard by the effect above.
  useEffect(() => {
    if (!plan || plan === "free") return;
    if (typeof window === "undefined") return;
    const flagKey = `${MODEL_STORAGE_KEY}-pro-default-migrated`;
    try {
      if (window.localStorage.getItem(flagKey) === "1") return;
      window.localStorage.setItem(flagKey, "1");
    } catch {
      return; // private mode — leave the selection as-is
    }
    setModel((m) => (m === "standard" ? "pro" : m));
  }, [plan]);

  return { model, setModel, plan };
}
