/** [COMP:app-web/siri-ask] Web-side validation for the native Siri handoff. */

export const MAX_SIRI_PROMPT_LENGTH = 8_000;

export function normalizeSiriPrompt(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const prompt = raw.trim();
  if (!prompt || prompt.length > MAX_SIRI_PROMPT_LENGTH) return null;
  return prompt;
}

/** Workspace-relative query suffix carried through root and picker redirects. */
export function siriAskSuffix(raw: unknown): string {
  return raw === "1" ? "?ask=1" : "";
}
