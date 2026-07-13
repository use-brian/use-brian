import { format } from "@/lib/i18n/format";
import type { ExplainOrigin } from "@/lib/api/brain-inbox";

/**
 * The `memoriesReview` copy slice the origin clue consumes. Structural
 * (rather than the full dictionary type) so tests can pass a fixture and
 * the function stays decoupled from the dictionary shape.
 */
export type SourceOriginCopy = {
  originChat: string;
  originWorkflow: string;
  originScheduled: string;
  originManual: string;
  originManualBy: string;
  originConsolidation: string;
  originExtraction: string;
  originAuthorFallback: string;
  originChannelLabels: Record<string, string>;
  originEpisodeKinds: Record<string, string>;
};

/**
 * One plain-language "where did this come from?" line derived from the
 * explain endpoint's `origin` descriptor ([COMP:app-web/brain-source-origin],
 * spec: docs/architecture/brain/corrections.md → "Source descriptor").
 * Returns null when the descriptor is absent (old API) or `unknown` with
 * no author to name — the caller falls back to the `whyNoMessages` line.
 */
export function originClue(
  origin: ExplainOrigin | undefined,
  copy: SourceOriginCopy,
  savedAt: string,
  savedByAssistantName: string | null,
): string | null {
  if (!origin) return null;
  const date = new Date(savedAt).toLocaleDateString();
  switch (origin.kind) {
    case "manual":
      return origin.createdByUserName
        ? format(copy.originManualBy, { user: origin.createdByUserName })
        : copy.originManual;
    case "consolidation":
      return format(copy.originConsolidation, { date });
    case "workflow":
      return copy.originWorkflow;
    case "scheduled":
      return copy.originScheduled;
    case "chat": {
      const channel =
        copy.originChannelLabels[origin.channelType ?? ""] ??
        copy.originChannelLabels.other;
      return format(copy.originChat, { channel });
    }
    case "extraction": {
      const source =
        copy.originEpisodeKinds[origin.episode?.sourceKind ?? ""] ??
        copy.originEpisodeKinds.other;
      const occurred = origin.episode
        ? new Date(origin.episode.occurredAt).toLocaleDateString()
        : date;
      return format(copy.originExtraction, { source, date: occurred });
    }
    default: {
      const author = savedByAssistantName ?? origin.createdByUserName;
      return author
        ? format(copy.originAuthorFallback, { author, date })
        : null;
    }
  }
}
