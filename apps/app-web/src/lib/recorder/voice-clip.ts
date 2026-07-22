/**
 * Voice-clip hand-off — the SHORT lane of the live-capture fork
 * (docs/architecture/media/live-capture.md → "The short lane").
 *
 * A stopped capture under the fork threshold becomes an inline voice
 * prompt: the clip goes to the transient `file_cache` via the same
 * `POST /api/files/upload` the paperclip uses, and the caller auto-sends a
 * turn carrying the returned `fileId` (empty text is valid — `chat.ts`
 * accepts a files-only message and transcribes the audio inline as
 * `[voice] <transcript>` for that one turn; see
 * docs/architecture/media/recordings.md → "Chat entry").
 *
 * Headless on purpose: no attachment chip is staged — the walkie-talkie
 * expectation is release = sent, so the clip rides straight into the send
 * without composer state.
 *
 * [COMP:app-web/recorder-engine]
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Upload the clip to the chat file cache. Returns the `fileId` to ride the
 * turn body, or `null` on failure (the caller surfaces the send error;
 * nothing was sent).
 */
export async function uploadVoiceClip(file: File, sessionId?: string): Promise<string | null> {
  const formData = new FormData();
  formData.append("files", file);
  if (sessionId) formData.append("sessionId", sessionId);
  try {
    const res = await authFetch(`${API_URL}/api/files/upload`, { method: "POST", body: formData });
    if (!res.ok) return null;
    const data = (await res.json()) as { files?: Array<{ id?: string; error?: string }> };
    const first = data.files?.[0];
    return first && !first.error && first.id ? first.id : null;
  } catch {
    return null;
  }
}
