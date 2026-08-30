/**
 * Inline data-URI stripping for every text lane that reaches the brain.
 *
 * [COMP:files/data-uri]
 *
 * WHY THIS EXISTS. A data URI is bytes wearing a text costume. It survives
 * every check a document has — it is valid UTF-8, it sits inside real prose,
 * it parses, it chunks, it embeds — and it is never knowledge. Twice now it
 * has walked straight through ingest as if it were the document:
 *
 *   2026-08-05, HTML. A 4.1 MB saved report whose 43 inline JPEGs were 2.82 M
 *   of its 2.87 M characters. Turndown copied every payload into `![alt](…)`
 *   and the brain indexed 2,000 segments of image bytes. Fixed in ./html.ts —
 *   for HTML only.
 *
 *   2026-08-28, Markdown. A Google Docs "Download as Markdown" export of the
 *   ESN Oulu Survival Guide: 83 KB of guide, then 119 reference-style image
 *   definitions worth 16.78 MB — 99.5% of the file. `text/markdown` takes the
 *   generic `text/*` branch, which hands back the raw buffer, so the guide
 *   ingested as 1,387 segments of which 1,280 were base64. Pipeline B then
 *   read that noise: 56 extraction calls, 1.45 M input tokens, $0.74, and ten
 *   task candidates of which eight were hallucinated out of the blobs
 *   ("Review technical documentation on carrier injection and radiative
 *   recombination in LEDs").
 *
 * The second incident is the first one's lesson unlearned: the fix was written
 * on the branch where the bug was found instead of on the boundary every
 * format crosses. So this module exists to be called from the boundaries, not
 * from the branches — `parseFileContent` (bytes → text, which is also the text
 * Pipeline B extracts from) and `chunkFileText` (text → segments, which every
 * segment writer converges on).
 *
 * WHAT SURVIVES. The MIME prefix, so `![Toripolliisi](data:image/png)` still
 * reads as an image the document had — the alt text is the part that carries
 * meaning, and it is untouched. Only the payload goes. Non-base64 data URIs
 * (`data:image/svg+xml,<svg…>`) are left alone: that payload is markup a
 * reader can actually read, and dropping it would drop content.
 */

/**
 * Inline base64 payload of a data URI. Linear (a single greedy character
 * class), so a 16 MB document is one pass with no backtracking.
 */
const BASE64_DATA_URI = /data:([a-z0-9/+.-]+);base64,[A-Za-z0-9+/=]+/gi

/** Replace every inline base64 payload with its bare `data:<mime>` prefix. Idempotent. */
export function stripDataUris(text: string): string {
  return text.replace(BASE64_DATA_URI, 'data:$1')
}
