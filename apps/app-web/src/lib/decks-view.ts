/**
 * Path helpers for the deck live-preview route. Mirrors `skills-view.ts`'s
 * `skillRowIdFromPathname`: the floating dock derives "which deck is the
 * user looking at" from the URL and sends it as `viewingDeckId` so the
 * assistant resolves "this deck" / "slide 3" to the open preview.
 */

export function deckIdFromPathname(pathname: string | null): string | null {
  if (!pathname) return null;
  const match = pathname.match(/^\/w\/[^/]+\/decks\/([^/?#]+)/);
  return match ? match[1] : null;
}
