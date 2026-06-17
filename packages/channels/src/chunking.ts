/**
 * Format-aware text chunking.
 * Splits at paragraph → sentence → newline boundaries, respecting platform limits.
 */

export function chunkText(text: string, maxLength: number): string[] {
  if (text.length <= maxLength) return [text]

  const chunks: string[] = []
  let remaining = text

  while (remaining.length > 0) {
    if (remaining.length <= maxLength) {
      chunks.push(remaining)
      break
    }

    const minCut = Math.floor(maxLength * 0.5)
    let cutPoint = remaining.lastIndexOf('\n\n', maxLength)
    if (cutPoint < minCut) cutPoint = remaining.lastIndexOf('\n', maxLength)
    if (cutPoint < minCut) cutPoint = remaining.lastIndexOf('. ', maxLength)
    if (cutPoint < minCut) cutPoint = maxLength

    // Include the period if we split at ". "
    if (remaining[cutPoint] === '.') cutPoint += 1

    chunks.push(remaining.slice(0, cutPoint))
    remaining = remaining.slice(cutPoint).trimStart()
  }

  return chunks
}
