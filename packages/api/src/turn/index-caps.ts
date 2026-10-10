/**
 * Per-turn caps for the L1 index blocks, ONE definition for every runner
 * (unified-sessions section 4.3: the memory and files indexes were capped in
 * web chat and channels, duplicated, and uncapped on the public API and the
 * A2A / workflow callee).
 *
 * Memories beyond `PER_TURN_INDEX_CAP` are surfaced to the model through a
 * "N more memories stored - use getMemory(...)" footer, so retrieval stays
 * explicit. Sized for ~1,400 input tokens at 60 rows x ~80 chars + footer.
 * See docs/architecture/context-engine/memory-system.md -> "Index cap".
 *
 * [COMP:api/turn-kernel]
 */
export const PER_TURN_INDEX_CAP = 60

/** Per-turn cap for the `# Workspace Files` L1 block (Q3 / company-brain section 10). */
export const PER_TURN_FILES_INDEX_CAP = 50
