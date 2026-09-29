/**
 * Pre-send signal for the doc dock's per-turn re-address. Switching the
 * assistant on the doc dock does NOT reset the thread: the next send simply
 * carries the new `assistantId` and that assistant answers inside the same
 * conversation. Without a hint the only visible change is the header label,
 * so a switch reads as "nothing happened". This resolves whether the composer
 * should say who the next reply will come from.
 *
 * Spec: docs/architecture/features/chat-app.md → "Choosing an assistant" → "Next-reply hint".
 *
 * [COMP:app-web/next-reply-voice]
 */

export interface VoicedMessage {
  role: string;
  senderAssistantId?: string | null;
}

/**
 * The assistant id to name in the "Next reply from X" hint, or null when no
 * hint should show. Shows only when the thread's latest reply carries a voice
 * stamp that differs from the selected assistant, i.e. the user switched
 * mid-thread. An empty thread, a matching voice, or an unstamped latest reply
 * (pre-stamp history, where the previous voice is unknown) shows nothing.
 */
export function nextReplyVoiceHint(
  messages: readonly VoicedMessage[],
  selectedAssistantId: string | null | undefined,
): string | null {
  if (!selectedAssistantId) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    if (!m.senderAssistantId) return null;
    return m.senderAssistantId === selectedAssistantId
      ? null
      : selectedAssistantId;
  }
  return null;
}
