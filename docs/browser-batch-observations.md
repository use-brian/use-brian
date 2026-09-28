# Browser batches and versioned observations

`browserFillForm` is a composing tool for the **Chromium local browser only**.
It is registered at API boot and advertised by the shared computer connector,
with write classification and default `allow` policy (workspace policy still applies).

Scan the page, prepare known independent values, then call:

```json
{
  "fields": [
    { "action": "fill", "ref": "@e1", "value": "Ada" },
    { "action": "select", "ref": "@e2", "value": "GB" },
    { "action": "check", "ref": "@e3", "checked": true }
  ],
  "observation": "auto"
}
```

The ordered batch accepts 1–50 distinct refs. `fill` replaces text; `select`
chooses a native dropdown option by exact value or unique enabled visible label;
`check` sets a native
checkbox/radio state. To deselect a checked radio, select another radio.
All public refs are resolved before execution. Fields then execute sequentially
without model round trips, stopping on failure. Results report `success`,
`failed`, or `skipped` per field and include a fresh observation when available.
There is **no transactional rollback**: earlier changes remain after a later
failure. Inspect the result and refresh before retrying uncertain changes.

Batches never target submit buttons or press Enter. Like ordinary typing,
page event handlers may autosave or navigate in response to edits. Use `browserClick` with `intent: "submit"`
separately so the normal send approval gate applies. Custom widgets fall back
to `browserClick`/`browserType`. Cloud and Firefox do not support this batch
API; use those individual tools instead (unsupported batches return an error,
not an automatically replayed sequence).

## Observations and refs

`browserSnapshot`, `browserClick`, and `browserFillForm` accept `observation`:

- `auto` (default): full view initially, then a diff only when smaller.
- `full`: reset the baseline and return a full view with new refs.
- `diff`: request changes against the prior version; unsafe baselines still
  return a full view.

This is separate from snapshot `mode: "interactive" | "full"`, which controls
whether informational accessibility rows are included. Such rows have no
action refs. Navigate, click, tab-open/switch, and batch-fill follow-ups use full
accessibility mode so new questions, instructions, and validation messages are
not dropped; explicit `browserSnapshot` defaults to interactive mode. Checked,
required, disabled, and invalid states are included when supplied by the provider.
Snapshot pagination uses `offset` and `limit` (maximum 150).

Headers identify the observation version and, for diffs, the base version.
Diffs mark removed (`-`), added (`+`), and changed/moved (`~`) rows; positions
are zero-based (removals refer to the old view, others to the new view).

Ref continuity relies on provider document IDs and unique, document-scoped
DOM node IDs—not labels, values, positions, or scan-local provider refs.
Those IDs are private; session-owned public `@e…` refs resolve to the latest
provider refs. Only act on refs valid in the latest observation. The same DOM
node can retain a ref across safe diffs, but replacements cannot inherit it.
Full resets invalidate old refs. Document, URL, scope, or mode changes,
missing/ambiguous IDs, and pagination force full views. Incomplete or oversized
observations cannot seed the next diff; only the returned page window binds refs.
Providers without reliable IDs (including cloud/Firefox fallback paths) remain
usable through full snapshots rather than guessed identity matching.

## Bounded settling

Chromium waits for DOM quiet before snapshots and final batch verification: 100 ms without observed
mutations, bounded by 750 ms, including a host-side deadline for throttled page
timers or evaluation failures. This is best-effort settling, not network idle,
a guarantee that the application has finished, or a transaction boundary.
Continuously updating pages therefore cannot block observations indefinitely.

## Watching browser actions

Chromium scrolls actionable fields into view before typing or batch edits and
shows a temporary cursor/focus pulse in captured frames. The overlay is excluded
from accessibility content and removed automatically. Screenshots stay serialized
with browser operations to preserve protected-fill privacy: a fast batch may show
only its final field in the viewer, rather than every intermediate edit. No
per-field animation delay is added to batch execution.

The viewer polls more frequently after delivered input; see
[Takeover API polling](../apps/app-web/docs/takeover-polling.md). Cloud WS/SSE
streams retain their existing streaming behavior; these cursor enhancements are
for the Chromium extension.

This reduces repeated LLM context; the extension still scans the accessibility
tree locally. It does not prune observations already in conversation history.
Use `observation: "full"` to recover a baseline after history compaction or when
additional context is needed. Batch/click/snapshot results have a 24,000-character
output cap; unsafe or incomplete baselines fall back to a full observation.
