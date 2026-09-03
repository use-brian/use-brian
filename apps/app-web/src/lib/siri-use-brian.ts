/** [COMP:app-web/siri-use-brian] Validation for the native Siri handoff. */

export const MAX_SIRI_PROMPT_LENGTH = 8_000;

export function normalizeUseBrianPrompt(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const prompt = raw.trim();
  if (!prompt || prompt.length > MAX_SIRI_PROMPT_LENGTH) return null;
  return prompt;
}

/** Workspace-relative query suffix carried through root and picker redirects. */
export function useBrianSuffix(raw: unknown): string {
  return raw === "1" ? "?useBrian=1" : "";
}

export function useBrianWorkspacePath(
  workspaceId: string,
  raw: unknown,
): string | null {
  const suffix = useBrianSuffix(raw);
  return suffix ? `/w/${workspaceId}/p${suffix}` : null;
}
