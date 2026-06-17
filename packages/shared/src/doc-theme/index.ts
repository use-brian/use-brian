/**
 * Doc custom-theme contract — pure, browser-safe, no deps beyond zod.
 * Spec: docs/architecture/features/doc-custom-themes.md.
 */
export * from './types.js'
export * from './build-tokens.js'
export {
  hexToRgb,
  rgbToHex,
  hexToHsl,
  hslToHex,
  hsl,
  mixHex,
  luminance,
  contrastRatio,
  ensureReadable,
} from './color.js'
