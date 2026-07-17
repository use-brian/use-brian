/**
 * Deck API client — read + export surface for the live preview page.
 * Writes happen through chat (the deck tools), never from the UI.
 * Spec: docs/architecture/features/deck-generation.md.
 */
import type { DeckSpec, DeckStyle } from "@use-brian/shared/decks";
import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type DeckDetail = {
  id: string;
  workspaceId: string;
  title: string;
  spec: DeckSpec;
  style: DeckStyle | null;
  styleSource: string | null;
  filePath: string;
  version: number;
  updatedAt: string;
};

export async function getDeck(deckId: string): Promise<DeckDetail | null> {
  const res = await authFetch(`${API_URL}/api/decks/${encodeURIComponent(deckId)}`);
  if (!res.ok) return null;
  const body = (await res.json()) as { deck?: DeckDetail };
  return body.deck ?? null;
}

/** Browser download of the built .pptx (the views-export blob idiom). */
export async function downloadDeckExport(deckId: string, title: string): Promise<boolean> {
  const res = await authFetch(`${API_URL}/api/decks/${encodeURIComponent(deckId)}/export`);
  if (!res.ok) return false;
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${title.replace(/[^a-zA-Z0-9._ -]+/g, "-").slice(0, 80) || "deck"}.pptx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
  return true;
}
