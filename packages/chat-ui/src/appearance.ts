/** Only these presentation tokens may cross the extension's app bridge. */
export const CHAT_THEME_TOKENS = [
  '--background', '--foreground', '--secondary', '--secondary-foreground',
  '--muted', '--muted-foreground', '--accent', '--accent-foreground',
  '--border', '--input', '--ring', '--popover', '--popover-foreground',
  '--primary', '--primary-foreground', '--card', '--card-foreground', '--destructive', '--font-rocknroll',
] as const

export type ChatAppearance = { dark: boolean; tokens: Partial<Record<typeof CHAT_THEME_TOKENS[number], string>> }

export function readChatAppearance(root: HTMLElement): ChatAppearance {
  const style = getComputedStyle(root)
  const tokens: ChatAppearance['tokens'] = {}
  for (const token of CHAT_THEME_TOKENS) {
    const value = style.getPropertyValue(token).trim()
    if (value && value.length <= 1024) tokens[token] = value
  }
  return { dark: root.classList.contains('dark'), tokens }
}

/** Set individual properties, with no stylesheet or URL interpolation. */
export function applyChatAppearance(root: HTMLElement, appearance: unknown): void {
  if (!appearance || typeof appearance !== 'object') return
  const input = appearance as Partial<ChatAppearance>
  if (typeof input.dark !== 'boolean' || !input.tokens || typeof input.tokens !== 'object') return
  root.classList.toggle('dark', input.dark)
  root.style.colorScheme = input.dark ? 'dark' : 'light'
  for (const token of CHAT_THEME_TOKENS) {
    const value = input.tokens[token]
    const property = token === '--font-rocknroll' ? 'font-family' : 'color'
    if (typeof value === 'string' && value.length <= 1024 && !/[{};@]|url\s*\(/i.test(value) && CSS.supports(property, value)) root.style.setProperty(token, value)
    else root.style.removeProperty(token)
  }
}
