/**
 * Assistant authoring path for custom Home apps — `writeHomeApp`,
 * `getHomeApp`, `listHomeApps`.
 *
 * The `writeBrowserSkill` precedent: an assistant authors an artifact
 * conversationally, and the SERVER re-validates it on every write rather than
 * trusting what the model produced. Fail closed — a bundle that does not
 * validate is not saved at all, because a half-valid app is a thing an admin
 * would then be asked to grant scopes to.
 *
 * Three properties that are not obvious from the schema:
 *
 *   - **Authoring never bypasses consent.** A written app lands (or stays) at
 *     `needs_consent` if its manifest asks for more than the standing grant,
 *     exactly like a GitHub sync. The assistant can build an app; only a human
 *     admin can give it access to anything.
 *   - **A write is a full bundle replace**, not a patch. Partial writes would
 *     let a file survive from a previous version that the current manifest
 *     never declared — and that file would still be served.
 *   - **`read` scope cannot author.** These are registered only for
 *     `read_write`, the same bar as every other write tool.
 *
 * Spec: docs/architecture/features/home-apps.md → "Custom apps".
 * [COMP:api/home-app-tools]
 */

import { z } from 'zod'
import type { FilesApi } from '@use-brian/core'
import { MANIFEST_FILENAME, contentTypeFor, lintBundle, validateBundle } from '@use-brian/brian-app'
import {
  applyHomeAppManifest,
  createHomeApp,
  getHomeApp,
  listHomeApps,
  type HomeAppRow,
} from '../db/home-apps-store.js'

/** One authored file. Text only — an assistant cannot produce binary here. */
export type AuthoredFile = { path: string; content: string }

/**
 * What the WRITE SEAM accepts: authored text, or raw bytes. The zip importer
 * is the bytes producer — a zip can carry a png or a woff, which the
 * assistant's text-only tool schema cannot express, and round-tripping binary
 * through a utf8 string would corrupt it.
 */
export type BundleWriteFile = AuthoredFile | { path: string; bytes: Uint8Array }

function fileByteLength(file: BundleWriteFile): number {
  return 'bytes' in file ? file.bytes.byteLength : Buffer.byteLength(file.content, 'utf8')
}

export type HomeAppToolDeps = {
  filesApi: FilesApi
  workspaceId: string
  /** The acting user, recorded as the app's creator. */
  actingUserId: string | null
  /** Where bundle files live (injected so the route module stays the owner). */
  bundlePath: (appId: string, path: string) => string
  /** Wipe an app's stored bundle before a replace. */
  clearBundle: (workspaceId: string, appId: string) => Promise<void>
}

const fileSchema = z.object({
  path: z.string().min(1).max(255),
  content: z.string().max(2 * 1024 * 1024),
})

export type WriteHomeAppInput = {
  files: BundleWriteFile[]
  /**
   * Provenance of the write — `assistant` (the tool) or `upload` (the zip
   * importer). Same-kind + same-name is an UPDATE, so a re-uploaded zip
   * replaces the uploaded app it came from and never touches an
   * assistant-authored app that happens to share a name.
   */
  kind?: 'assistant' | 'upload'
}

export type WriteHomeAppResult =
  | { ok: true; app: HomeAppRow; created: boolean; warnings: string[] }
  | { ok: false; message: string }

/**
 * Validate + persist an authored bundle. Exported separately from the tool
 * wrapper so the same path is testable without an MCP harness — and so a
 * future REST/zip importer reuses it rather than growing a second write path.
 */
export async function writeHomeAppBundle(
  deps: HomeAppToolDeps,
  input: WriteHomeAppInput,
): Promise<WriteHomeAppResult> {
  const manifestFile = input.files.find((f) => f.path === MANIFEST_FILENAME)
  if (!manifestFile) {
    return { ok: false, message: `The bundle must include ${MANIFEST_FILENAME}.` }
  }
  const manifestText =
    'bytes' in manifestFile
      ? Buffer.from(manifestFile.bytes).toString('utf8')
      : manifestFile.content
  let manifestJson: unknown
  try {
    manifestJson = JSON.parse(manifestText)
  } catch (err) {
    return { ok: false, message: `${MANIFEST_FILENAME} is not valid JSON: ${(err as Error).message}` }
  }

  const validated = validateBundle({
    files: input.files.map((f) => ({ path: f.path, bytes: fileByteLength(f) })),
    manifestJson,
  })
  if (!validated.ok) {
    return {
      ok: false,
      message:
        'The bundle did not validate:\n' +
        validated.issues.map((i) => `  ${i.path || '(bundle)'} — ${i.message}`).join('\n'),
    }
  }

  // Same workspace + same KIND + same name = an UPDATE. Assistant-authored and
  // uploaded apps have no repo to key on, and minting a second row per write
  // would leave the strip holding a stale twin of every app ever touched. The
  // kind is part of the key so a re-uploaded zip can never overwrite an
  // assistant-authored app that shares its name.
  const kind = input.kind ?? 'assistant'
  const existing = (await listHomeApps(deps.workspaceId)).find(
    (a) => a.kind === kind && a.name === validated.manifest.name,
  )

  const app = existing
    ? (await applyHomeAppManifest({ appId: existing.id, manifest: validated.manifest }))?.app
    : await createHomeApp({
        workspaceId: deps.workspaceId,
        kind,
        manifest: validated.manifest,
        createdBy: deps.actingUserId,
      })
  if (!app) return { ok: false, message: 'Could not save the app (it may have been deleted).' }

  // Full replace. A patch would let a file from a previous version survive
  // that the current manifest never declared — and it would still be served.
  await deps.clearBundle(deps.workspaceId, app.id)
  const ctx = { workspaceId: deps.workspaceId, userId: deps.actingUserId ?? '', system: true } as never
  for (const file of input.files) {
    // Bytes ride `writeBytes` (byte-preserving — a png through a utf8 string
    // would corrupt); authored text rides `write`.
    const written =
      'bytes' in file
        ? await deps.filesApi.writeBytes(ctx, {
            path: deps.bundlePath(app.id, file.path),
            bytes: file.bytes,
            mime: contentTypeFor(file.path) ?? 'application/octet-stream',
          })
        : await deps.filesApi.write(ctx, {
            path: deps.bundlePath(app.id, file.path),
            content: file.content,
          })
    if (!written.ok) {
      return { ok: false, message: `Could not store ${file.path}.` }
    }
  }

  const warnings = lintBundle({ files: validated.files, manifest: validated.manifest }).map(
    (f) => `${f.path || '(bundle)'} — ${f.message}`,
  )
  return { ok: true, app, created: !existing, warnings }
}

/** Human-readable summary of what an app is waiting on, for the tool result. */
export function describeAppStatus(app: HomeAppRow): string {
  if (app.status === 'disabled') return 'turned off by an admin'
  if (app.status === 'needs_consent') {
    return app.grantedScopes
      ? 'waiting on re-consent — it now asks for more access than was granted'
      : 'waiting on consent — a workspace owner or admin must approve its access before it renders'
  }
  return 'live on Home'
}

/** Zod input schema for the `writeHomeApp` tool. */
export const writeHomeAppSchema = {
  files: z
    .array(fileSchema)
    .min(1)
    .max(100)
    .describe(
      `Every file in the bundle, including ${MANIFEST_FILENAME}. This REPLACES the app's ` +
        'current files entirely - include everything, not just what changed.',
    ),
}
