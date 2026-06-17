/**
 * gdrive tool grouping (app-web).
 *
 * Ported verbatim from `apps/web/src/components/connectors/gdrive-groups.ts`
 * (app consolidation §9 #5). The `gdrive` connector exposes one OAuth grant
 * across four tool families (Drive / Docs / Sheets / Slides). Flat lists of
 * 17 tools are a wall, so group by name prefix and show one card per service.
 */

export type GdriveGroupId = "drive" | "docs" | "sheets" | "slides" | "other";

export const GDRIVE_GROUPS: Array<{ id: GdriveGroupId; label: string }> = [
  { id: "drive", label: "Drive" },
  { id: "docs", label: "Docs" },
  { id: "sheets", label: "Sheets" },
  { id: "slides", label: "Slides" },
  { id: "other", label: "Other" },
];

export function gdriveToolGroup(toolName: string): GdriveGroupId {
  if (toolName.startsWith("googleDocs")) return "docs";
  if (toolName.startsWith("googleSheets")) return "sheets";
  if (toolName.startsWith("googleSlides")) return "slides";
  if (toolName.startsWith("googleDrive")) return "drive";
  return "other";
}
