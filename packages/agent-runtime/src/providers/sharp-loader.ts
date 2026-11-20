/**
 * Lazy image codec for provider-side image validation. [COMP:core/gemini-image]
 *
 * `sharp` is a native module with a large load cost, and only image
 * generation and image-edit sources need it. Providers load it here when they
 * validate an image, never at module evaluation, so an ordinary chat turn does
 * not load it. A missing or unloadable module is an availability failure with
 * an actionable message (`code: 'image_codec_unavailable'`). Callers load it
 * before any provider dispatch, so an unavailable codec never costs a paid
 * generation, and never report it as a malformed image.
 */
/** The codec surface the providers use, declared structurally so that no
 * runtime module carries even a type edge to the native package. */
type SharpImage = {
  metadata(): Promise<{ format?: string; width?: number; height?: number; pages?: number }>
  raw(): { toBuffer(): Promise<Buffer> }
}
type Sharp = (input: Uint8Array, options: { failOn: 'error'; limitInputPixels: number }) => SharpImage

class ImageCodecUnavailableError extends Error {
  readonly code = 'image_codec_unavailable'
  constructor(cause: unknown) {
    super('image_codec_unavailable: image validation needs the optional "sharp" package, which could not be loaded'
      + ` (${cause instanceof Error ? cause.message : String(cause)}). Install it for this platform`
      + ' (`pnpm add sharp` in the deploying package, or `pnpm rebuild sharp`) and restart.', { cause })
    this.name = 'ImageCodecUnavailableError'
  }
}

let loaded: Promise<Sharp> | null = null

export function loadSharp(): Promise<Sharp> {
  loaded ??= import('sharp').then(
    (module) => ((module as { default?: unknown }).default ?? module) as Sharp,
    (error: unknown) => {
      loaded = null
      throw new ImageCodecUnavailableError(error)
    },
  )
  return loaded
}
