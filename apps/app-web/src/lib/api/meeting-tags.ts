/** Meeting-tag wire contract. [COMP:app-web/meeting-tags] */
import { authFetch } from "@/lib/auth-fetch";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
type MeetingTagRule = { id: string; tag: string; phrases: string[] };
export type MeetingTagState = {
  folderId: string; isFolder: boolean;
  tags: { name: string; source: "manual" | "rule" }[];
  rules: MeetingTagRule[];
  suggestions: (MeetingTagRule & { pageIds: string[] })[];
};
export type MeetingTagCommand =
  | { kind: "set-tags"; tags: string[] }
  | { kind: "create-rule"; tag: string; phrases: string[] }
  | { kind: "accept-rule" | "dismiss-rule" | "delete-rule"; id: string };
export async function meetingTags(workspaceId: string, pageId: string, command?: MeetingTagCommand): Promise<MeetingTagState | null> {
  const url = `${publicRuntimeConfig().apiUrl ?? "http://localhost:4000"}/api/recordings/meeting-tags/${encodeURIComponent(pageId)}`;
  const response = await authFetch(command ? url : `${url}?workspaceId=${encodeURIComponent(workspaceId)}`, command ? {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ workspaceId, command }),
  } : undefined);
  if (!response.ok) throw new Error("meeting_tags_failed");
  return (await response.json()).state;
}
