/**
 * Line-based unified diff for KB write previews.
 *
 * Powers the `updateKnowledgeEntry` confirmation card's "view proposed
 * change" — the server computes old-vs-new here because only it holds the
 * old body (the client sees just the tool input). Output is plain
 * `string[]` lines in unified-diff notation (`@@` hunk headers, `-`/`+`/
 * space-prefixed lines) so it degrades to readable text on channel
 * surfaces; the web confirmation card renders it as a styled diff block.
 *
 * Deterministic, dependency-free, and bounded: common prefix/suffix lines
 * are trimmed first (typical KB edits are localized), the middle runs an
 * LCS diff up to `MAX_LCS_LINES` per side, and anything larger degrades to
 * one whole-middle replacement hunk rather than an O(n·m) blowup.
 *
 * See docs/architecture/features/knowledge-base.md → "Update previews are
 * diffs". [COMP:knowledge/text-diff]
 */

const DEFAULT_CONTEXT = 2
const DEFAULT_MAX_LINES = 40
/** Per-side ceiling for the LCS middle. Above it: single replacement hunk. */
const MAX_LCS_LINES = 400

type DiffOp = { kind: 'same' | 'del' | 'add'; line: string }

/**
 * Unified-diff lines for `oldText` → `newText`. Empty array = no line-level
 * change. Output is capped at `maxLines` diff lines (hunk headers included)
 * with a trailing `…` elision marker when truncated.
 */
export function unifiedDiffLines(
  oldText: string,
  newText: string,
  opts?: { context?: number; maxLines?: number },
): string[] {
  const context = opts?.context ?? DEFAULT_CONTEXT
  const maxLines = opts?.maxLines ?? DEFAULT_MAX_LINES

  const oldLines = splitLines(oldText)
  const newLines = splitLines(newText)

  // Trim the common prefix / suffix — the diff proper only runs on the middle.
  let start = 0
  while (start < oldLines.length && start < newLines.length && oldLines[start] === newLines[start]) start++
  let oldEnd = oldLines.length
  let newEnd = newLines.length
  while (oldEnd > start && newEnd > start && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--
    newEnd--
  }

  const oldMid = oldLines.slice(start, oldEnd)
  const newMid = newLines.slice(start, newEnd)
  if (oldMid.length === 0 && newMid.length === 0) return []

  const ops: DiffOp[] =
    oldMid.length > MAX_LCS_LINES || newMid.length > MAX_LCS_LINES
      ? [
          ...oldMid.map((line): DiffOp => ({ kind: 'del', line })),
          ...newMid.map((line): DiffOp => ({ kind: 'add', line })),
        ]
      : lcsOps(oldMid, newMid)

  // Re-attach up to `context` lines of the trimmed common prefix/suffix so
  // hunks read anchored, then group changes into hunks.
  const preContext = oldLines.slice(Math.max(0, start - context), start)
  const postContext = oldLines.slice(oldEnd, Math.min(oldLines.length, oldEnd + context))
  const full: DiffOp[] = [
    ...preContext.map((line): DiffOp => ({ kind: 'same', line })),
    ...ops,
    ...postContext.map((line): DiffOp => ({ kind: 'same', line })),
  ]

  const out = renderHunks(full, {
    oldStart: Math.max(0, start - context) + 1,
    newStart: Math.max(0, start - context) + 1,
    context,
  })

  if (out.length > maxLines) {
    return [...out.slice(0, maxLines), `… (${out.length - maxLines} more diff lines)`]
  }
  return out
}

function splitLines(text: string): string[] {
  // A trailing newline should not manufacture a phantom empty last line.
  const normalized = text.replace(/\r\n/g, '\n')
  const lines = normalized.split('\n')
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

/** Standard LCS DP over the (bounded) middle, walked back into ops. */
function lcsOps(a: string[], b: string[]): DiffOp[] {
  const n = a.length
  const m = b.length
  // (n+1)×(m+1) table of LCS lengths.
  const table: Uint32Array = new Uint32Array((n + 1) * (m + 1))
  const idx = (i: number, j: number) => i * (m + 1) + j
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[idx(i, j)] =
        a[i] === b[j]
          ? table[idx(i + 1, j + 1)] + 1
          : Math.max(table[idx(i + 1, j)], table[idx(i, j + 1)])
    }
  }
  const ops: DiffOp[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: 'same', line: a[i] })
      i++
      j++
    } else if (table[idx(i + 1, j)] >= table[idx(i, j + 1)]) {
      ops.push({ kind: 'del', line: a[i] })
      i++
    } else {
      ops.push({ kind: 'add', line: b[j] })
      j++
    }
  }
  while (i < n) ops.push({ kind: 'del', line: a[i++] })
  while (j < m) ops.push({ kind: 'add', line: b[j++] })
  return ops
}

/**
 * Group ops into `@@ -a,b +c,d @@` hunks, keeping at most `context` common
 * lines around each change run and eliding longer common stretches.
 */
function renderHunks(
  ops: DiffOp[],
  opts: { oldStart: number; newStart: number; context: number },
): string[] {
  const { context } = opts
  // Indices of ops that are changes.
  const changed = ops.map((op) => op.kind !== 'same')
  if (!changed.some(Boolean)) return []

  // Mark ops to include: every change ± context common lines.
  const include = new Array<boolean>(ops.length).fill(false)
  for (let k = 0; k < ops.length; k++) {
    if (!changed[k]) continue
    for (let d = Math.max(0, k - context); d <= Math.min(ops.length - 1, k + context); d++) {
      include[d] = true
    }
  }

  const out: string[] = []
  let oldLine = opts.oldStart
  let newLine = opts.newStart
  let k = 0
  while (k < ops.length) {
    if (!include[k]) {
      if (ops[k].kind !== 'add') oldLine++
      if (ops[k].kind !== 'del') newLine++
      k++
      continue
    }
    // Start of a hunk — collect until the next excluded op.
    const hunkStart = k
    let end = k
    while (end < ops.length && include[end]) end++
    let oldCount = 0
    let newCount = 0
    for (let d = hunkStart; d < end; d++) {
      if (ops[d].kind !== 'add') oldCount++
      if (ops[d].kind !== 'del') newCount++
    }
    out.push(`@@ -${oldLine},${oldCount} +${newLine},${newCount} @@`)
    for (let d = hunkStart; d < end; d++) {
      const op = ops[d]
      out.push(op.kind === 'del' ? `- ${op.line}` : op.kind === 'add' ? `+ ${op.line}` : `  ${op.line}`)
      if (op.kind !== 'add') oldLine++
      if (op.kind !== 'del') newLine++
    }
    k = end
  }
  return out
}
