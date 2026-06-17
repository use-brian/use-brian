/**
 * Deterministic per-user cursor color for collaboration presence. The same
 * user always gets the same color across sessions/devices; the AI's
 * "Assistant" peer is just another userId hashed here.
 *
 * [COMP:app-web/cursor-color]
 */

/** Theme-friendly palette (Radix-ish hues that read on light + dark). */
export const CURSOR_PALETTE = [
  '#E5484D',
  '#D6409F',
  '#8E4EC6',
  '#3E63DD',
  '#0091FF',
  '#12A594',
  '#30A46C',
  '#F76B15',
  '#FFB224',
  '#46A758',
] as const

export function colorForUserId(userId: string): string {
  let hash = 0
  for (let i = 0; i < userId.length; i++) {
    hash = (hash * 31 + userId.charCodeAt(i)) >>> 0
  }
  return CURSOR_PALETTE[hash % CURSOR_PALETTE.length]
}

/**
 * Pick a legible text colour (near-black or white) for initials drawn on a
 * cursor-colour background. The palette spans dark hues (blue/purple) and
 * light ones (amber `#FFB224`), so a uniform white washes out on the lighter
 * swatches — choose by perceived luminance instead. Non-hex inputs (e.g. a
 * `var(--primary)` fallback) default to white.
 */
export function readableTextColor(color: string): string {
  let hex = color.startsWith('#') ? color.slice(1) : ''
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('')
  if (hex.length !== 6) return '#ffffff'
  const r = parseInt(hex.slice(0, 2), 16) / 255
  const g = parseInt(hex.slice(2, 4), 16) / 255
  const b = parseInt(hex.slice(4, 6), 16) / 255
  // Perceived luminance (sRGB coefficients); >0.6 reads as a "light" swatch.
  const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b
  return luminance > 0.6 ? '#1f2937' : '#ffffff'
}
