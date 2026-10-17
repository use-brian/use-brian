/** Versioned Feed image capability and verified provider tariff. [COMP:core/gemini-image] */
export type FeedImageRates = { version: string; inputPerMillion: number; textPerMillion: number; imagePerMillion: number; imageTokens: number }
export const FEED_IMAGE_CAPABILITY = {
  version: 2, callTimeoutMs: 300_000, model: 'gemini-nano-banana-2.1', size: '1K', candidates: 1,
  inputCharacters: 32_000, outputTokens: 4096, maxImageBytes: 20 * 1024 * 1024, maxSourceImageBytes: 14 * 1024 * 1024, maxImagePixels: 16_777_216,
  rates: { version: 'google-ai-studio-standard:2026-10-17:1K', inputPerMillion: 1.50, textPerMillion: 7.50, imagePerMillion: 30, imageTokens: 1120 },
  source: 'https://ai.google.dev/gemini-api/docs/pricing',
} as const
export type FeedImageConfig = { model: string; rates: FeedImageRates; transport: 'ai-studio' | 'vertex' }
export function feedImageCost(rates: FeedImageRates, inputTokens: number, outputTokens: number, imageTokens?: number) {
  const image = Math.min(Math.max(0, imageTokens ?? outputTokens), Math.max(0, outputTokens))
  return (Math.max(0, inputTokens) * rates.inputPerMillion + image * rates.imagePerMillion + Math.max(0, outputTokens - image) * rates.textPerMillion) / 1_000_000
}
/** Existing Feed destination ceilings, shared by UI and canonical publication. */
export const FEED_MEDIA_CAPS: Readonly<Record<string, number>> = { threads: 10, twitter: 4, instagram: 10, xhs: 9, linkedin: 20, email: 20 }
export const FEED_TEXT_CAPS: Readonly<Record<string, number>> = { twitter: 280, threads: 500, instagram: 2200, xhs: 1000, linkedin: 3000, email: 100_000 }
