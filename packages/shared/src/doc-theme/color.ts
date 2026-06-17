/**
 * Dependency-free colour maths for the custom-theme builder.
 *
 * Everything works in 6-digit hex at the boundary and HSL internally (simple,
 * deterministic, no deps). The builder ({@link ./build-tokens}) seeds a palette
 * from a few anchor colours, then derives the ~27 core tokens with these
 * helpers — the same idea as the brand palettes' CSS `color-mix`, moved into TS
 * so the result is concrete hex we can store + inject.
 *
 * [COMP:shared/doc-theme-builder]
 */

export type Rgb = { r: number; g: number; b: number }
export type Hsl = { h: number; s: number; l: number }

const clamp = (n: number, lo: number, hi: number): number =>
  n < lo ? lo : n > hi ? hi : n

/** Parse `#rgb` or `#rrggbb` → RGB (0-255). Throws on malformed input. */
export function hexToRgb(hex: string): Rgb {
  const m = /^#?([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.exec(hex.trim())
  if (!m) throw new Error(`Invalid hex colour: ${hex}`)
  let h = m[1]
  if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]
  return {
    r: parseInt(h.slice(0, 2), 16),
    g: parseInt(h.slice(2, 4), 16),
    b: parseInt(h.slice(4, 6), 16),
  }
}

export function rgbToHex({ r, g, b }: Rgb): string {
  const to2 = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, '0')
  return `#${to2(r)}${to2(g)}${to2(b)}`.toUpperCase()
}

export function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const d = max - min
  let h = 0
  if (d !== 0) {
    if (max === rn) h = ((gn - bn) / d) % 6
    else if (max === gn) h = (bn - rn) / d + 2
    else h = (rn - gn) / d + 4
    h *= 60
    if (h < 0) h += 360
  }
  const l = (max + min) / 2
  const s = d === 0 ? 0 : d / (1 - Math.abs(2 * l - 1))
  return { h, s: s * 100, l: l * 100 }
}

export function hslToRgb({ h, s, l }: Hsl): Rgb {
  const sn = clamp(s, 0, 100) / 100
  const ln = clamp(l, 0, 100) / 100
  const c = (1 - Math.abs(2 * ln - 1)) * sn
  const hp = (((h % 360) + 360) % 360) / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let r = 0
  let g = 0
  let b = 0
  if (hp < 1) [r, g, b] = [c, x, 0]
  else if (hp < 2) [r, g, b] = [x, c, 0]
  else if (hp < 3) [r, g, b] = [0, c, x]
  else if (hp < 4) [r, g, b] = [0, x, c]
  else if (hp < 5) [r, g, b] = [x, 0, c]
  else [r, g, b] = [c, 0, x]
  const m = ln - c / 2
  return { r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 }
}

export const hexToHsl = (hex: string): Hsl => rgbToHsl(hexToRgb(hex))
export const hslToHex = (hsl: Hsl): string => rgbToHex(hslToRgb(hsl))

/** Build a hex from H/S/L components (s,l in 0-100). */
export const hsl = (h: number, s: number, l: number): string =>
  hslToHex({ h, s: clamp(s, 0, 100), l: clamp(l, 0, 100) })

/** Linear-RGB mix of two hex colours; `t` in [0,1] is the weight of `b`. */
export function mixHex(a: string, b: string, t: number): string {
  const ca = hexToRgb(a)
  const cb = hexToRgb(b)
  const w = clamp(t, 0, 1)
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * w,
    g: ca.g + (cb.g - ca.g) * w,
    b: ca.b + (cb.b - ca.b) * w,
  })
}

const channelLum = (c: number): number => {
  const s = c / 255
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance of a hex colour. */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex)
  return 0.2126 * channelLum(r) + 0.7152 * channelLum(g) + 0.0722 * channelLum(b)
}

/** WCAG contrast ratio between two hex colours (1–21). */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a)
  const lb = luminance(b)
  const hi = Math.max(la, lb)
  const lo = Math.min(la, lb)
  return (hi + 0.05) / (lo + 0.05)
}

/**
 * Return a foreground close to `fg` that meets `target` contrast against `bg`,
 * nudging its lightness toward black or white (whichever direction raises
 * contrast) in small steps. Guarantees readability for arbitrary seeds; falls
 * back to the higher-contrast extreme if `target` can't be met. Deterministic.
 */
export function ensureReadable(fg: string, bg: string, target = 4.5): string {
  if (contrastRatio(fg, bg) >= target) return fg
  const base = hexToHsl(fg)
  // Push away from the background's lightness: dark bg → lighten fg, light bg → darken.
  const goUp = luminance(bg) < 0.5
  let best = fg
  let bestRatio = contrastRatio(fg, bg)
  for (let step = 1; step <= 20; step++) {
    const l = clamp(base.l + (goUp ? step * 5 : -step * 5), 0, 100)
    const cand = hslToHex({ h: base.h, s: base.s, l })
    const ratio = contrastRatio(cand, bg)
    if (ratio > bestRatio) {
      best = cand
      bestRatio = ratio
    }
    if (ratio >= target) return cand
  }
  // Couldn't hit target within the hue — use the readable extreme.
  return bestRatio >= contrastRatio(best, bg) ? best : goUp ? '#FFFFFF' : '#000000'
}
