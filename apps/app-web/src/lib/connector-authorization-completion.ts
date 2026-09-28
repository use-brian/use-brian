/**
 * Finish a durable chat connector checkpoint after an OAuth callback has
 * stored credentials. The API re-verifies every authority binding.
 *
 * [COMP:app-web/connector-authorization]
 */
import { INTERNAL_API_URL } from "@/lib/internal-api-url";

export async function completeConnectorAuthorizationAfterOAuth(input: {
  accessToken: string;
  workspaceId: string | undefined;
  continuation: { sessionId: string; approvalId: string } | undefined;
  provider: string;
  connectorInstanceId: string | undefined;
}): Promise<string | null> {
  if (!input.workspaceId || !input.continuation || !input.connectorInstanceId) return null;
  try {
    const response = await fetch(
      `${INTERNAL_API_URL}/api/sessions/${encodeURIComponent(input.continuation.sessionId)}/connector-authorization/${encodeURIComponent(input.continuation.approvalId)}/complete`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${input.accessToken}`,
        },
        body: JSON.stringify({
          provider: input.provider,
          connectorInstanceId: input.connectorInstanceId,
        }),
      },
    );
    if (!response.ok) {
      console.error("[connector-authorization] completion rejected:", response.status, await response.text());
      return null;
    }
  } catch (error) {
    console.error("[connector-authorization] completion unavailable:", error);
    return null;
  }
  return `/w/${encodeURIComponent(input.workspaceId)}/chat?s=${encodeURIComponent(input.continuation.sessionId)}`;
}
