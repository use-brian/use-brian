/**
 * Version model for the post editor (feed-revamp.md §8a, D17).
 *
 * The assistant proposes alternatives through `proposeDrafts`; the operator
 * edits one of them. Those are two different kinds of thing and the old
 * stacked cardboard conflated them, so an edit silently overwrote what the
 * model wrote and a re-proposal silently overwrote the edit.
 *
 * Here they stay separate: a proposal is immutable, and the first keystroke on
 * one FORKS it into the operator's own version. The chip strip shows both, the
 * fork wins for `Use this version`, and the model's original is always still
 * there to go back to.
 *
 * Pure and unit-tested; `post-editor.tsx` holds only rendering.
 *
 * [COMP:app-web/feed-post-versions]
 */

/** Per-platform copy limits, for the editor's character counter. */
const PLATFORM_LIMITS: Record<string, number> = {
  twitter: 280,
  threads: 500,
  instagram: 2_200,
  xhs: 1_000,
};

export function platformLimit(platform: string): number | null {
  return PLATFORM_LIMITS[platform] ?? null;
}

export type PostVersion = {
  /** `p<index>` for a proposal, `mine` for the operator's fork. */
  id: string;
  /** Where it came from. A proposal is immutable; `mine` is editable. */
  origin: "assistant" | "operator";
  /** Short tone/angle label from the model, when it supplied one. */
  label?: string;
  text: string;
  imageBrief?: string;
};

export type ProposedDraft = {
  index: number;
  text: string;
  label?: string;
  imageBrief?: string;
};

/**
 * Build the chip strip: the assistant's proposals in index order, plus the
 * operator's fork when one exists. The fork is LAST so the strip reads
 * chronologically - what was suggested, then what you made of it.
 */
export function buildVersions(input: {
  proposals: readonly ProposedDraft[];
  /** The operator's edited text, when they have diverged. */
  ownText: string | null;
  /** A committed/saved draft, which seeds the fork on first load. */
  savedText: string | null;
}): PostVersion[] {
  const versions: PostVersion[] = input.proposals
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((p) => ({
      id: `p${p.index}`,
      origin: "assistant" as const,
      text: p.text,
      ...(p.label ? { label: p.label } : {}),
      ...(p.imageBrief ? { imageBrief: p.imageBrief } : {}),
    }));

  const own = input.ownText ?? input.savedText;
  // Suppress a fork that is byte-identical to a proposal: showing "yours"
  // beside an untouched copy of v1 is noise, not a choice.
  if (own !== null && own.trim().length > 0) {
    const duplicate = versions.some((v) => v.text.trim() === own.trim());
    if (!duplicate) {
      versions.push({ id: "mine", origin: "operator", text: own });
    }
  }
  return versions;
}

/**
 * Which version to show. Prefer an explicit selection that still exists, then
 * the operator's fork (their work outranks a suggestion), then the last
 * proposal, then nothing.
 */
export function resolveSelectedVersion(
  versions: readonly PostVersion[],
  selectedId: string | null,
): PostVersion | null {
  if (versions.length === 0) return null;
  if (selectedId) {
    const found = versions.find((v) => v.id === selectedId);
    if (found) return found;
  }
  return (
    versions.find((v) => v.origin === "operator")
    ?? versions[versions.length - 1]
    ?? null
  );
}

export type CounterState = {
  count: number;
  limit: number | null;
  /** At or past the platform's limit - the post cannot go out as written. */
  over: boolean;
  /** Within 10% of the limit; warn before the operator hits the wall. */
  near: boolean;
};

export function counterState(text: string, platform: string): CounterState {
  const count = [...text].length; // code points, so emoji count as one
  const limit = platformLimit(platform);
  if (limit === null) return { count, limit: null, over: false, near: false };
  return {
    count,
    limit,
    over: count > limit,
    near: count > limit * 0.9 && count <= limit,
  };
}
