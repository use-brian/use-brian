/** Local preference for skipping the per-task Allow/Deny window. */

export const PREAPPROVE_TAB_CONTROL_KEY = 'preapproveTabControl'

export type ConsentPreferenceStorage = {
  get(key: string): Promise<Record<string, unknown>>
}

/** Missing or unreadable state is always the safer default: ask the user. */
export async function isTabControlPreapproved(
  storage: ConsentPreferenceStorage,
): Promise<boolean> {
  try {
    const stored = await storage.get(PREAPPROVE_TAB_CONTROL_KEY)
    return stored[PREAPPROVE_TAB_CONTROL_KEY] === true
  } catch {
    return false
  }
}
