"use client";

/**
 * In-memory hand-off for drag-drop / paste media uploads.
 *
 * When a file is dropped or pasted onto the page editor, `doc-media-paste.ts`
 * inserts an EMPTY media block (`ref: null`) immediately — so a placeholder
 * appears the instant the file lands — and stashes the raw `File` here, keyed
 * by the new block's id. The matching `BlockImage` / `BlockFile` claims it on
 * mount and runs the SAME durable upload its picker uses, so the "Uploading…"
 * → filled (or inline-error) feedback renders ON THE BLOCK, through one code
 * path with one error surface.
 *
 * The map is process-local and ephemeral: only the client that performed the
 * drop holds the bytes (other collaborators see the empty placeholder fill in
 * via Yjs once the `ref` lands), and a reload before the claim simply leaves
 * the normal empty picker — never a stuck "uploading" state, because nothing
 * about the in-flight upload is persisted into the Y.Doc.
 *
 * [COMP:app-web/media-uploads]
 */

const pending = new Map<string, File>();

/** Stash a dropped/pasted file for the freshly-inserted block `id` to claim. */
export function queueMediaUpload(id: string, file: File): void {
  pending.set(id, file);
}

/**
 * True if block `id` has a file waiting — lets a block paint "Uploading…" on
 * its very first render (before the claim effect runs) so there is no flash of
 * the empty picker.
 */
export function hasPendingMediaUpload(id: string): boolean {
  return pending.has(id);
}

/** Claim (and remove) the file queued for block `id`, if any. */
export function takeMediaUpload(id: string): File | undefined {
  const file = pending.get(id);
  if (file) pending.delete(id);
  return file;
}
