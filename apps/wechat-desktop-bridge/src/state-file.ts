/**
 * Per-chat cursor persistence. Shape `{ version: 1, cursors: { [chatId]: localId } }`.
 * Writes go through a temp file + rename so a crash mid-write never leaves a
 * truncated file (the next boot would otherwise re-seed every cursor).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

export type BridgeStateFile = { version: 1; cursors: Record<string, number> }

export function emptyState(): BridgeStateFile {
  return { version: 1, cursors: {} }
}

/** Returns the persisted state, or an empty one when the file is missing or unreadable. */
export async function loadStateFile(path: string): Promise<{ state: BridgeStateFile; fresh: boolean }> {
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch {
    return { state: emptyState(), fresh: true }
  }
  try {
    const parsed = JSON.parse(raw) as Partial<BridgeStateFile>
    if (parsed && parsed.version === 1 && parsed.cursors && typeof parsed.cursors === 'object') {
      const cursors: Record<string, number> = {}
      for (const [k, v] of Object.entries(parsed.cursors)) {
        if (typeof v === 'number' && Number.isFinite(v)) cursors[k] = v
      }
      return { state: { version: 1, cursors }, fresh: false }
    }
  } catch {
    /* fall through */
  }
  console.warn(`[bridge] state file ${path} is unreadable; starting with empty cursors`)
  return { state: emptyState(), fresh: true }
}

export async function saveStateFile(path: string, state: BridgeStateFile): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`
  await writeFile(tmp, JSON.stringify(state), 'utf8')
  await rename(tmp, path)
}
