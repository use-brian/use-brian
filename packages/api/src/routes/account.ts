import { Router } from 'express'
import multer from 'multer'
import { query, queryWithRLS, getPool } from '../db/client.js'
import {
  findUserById,
  updateUserTimezone,
  updateUserAvatar,
  clearUserAvatar,
  updateUserProfile,
} from '../db/users.js'
import { isAllowedMime } from './files.js'
import type { LinkedAccountStore } from '../db/linked-accounts.js'
import type { LinkCodeStore } from '../db/link-codes.js'
import type { GcsFilesClient } from '../files/gcs-client.js'
import { buildStorageKey, buildStorageUri } from '../files/gcs-client.js'
import type { FilesClientResolver } from '../files/files-api.js'

type AccountRouteOptions = {
  linkedAccountStore?: LinkedAccountStore
  /**
   * Telegram link-code store for the Settings → Account → Connected accounts
   * connect flow. When absent, POST /telegram/link-code returns 503.
   * See docs/architecture/platform/auth.md → "Linked accounts".
   */
  linkCodeStore?: LinkCodeStore
  /**
   * Resolves the official bot's @username (boot-cached getMe) so the
   * Settings UI can render a `https://t.me/<bot>?start=<code>` deep link.
   * Absent or failing resolver degrades to `botUsername: null` — the UI
   * falls back to showing the code for manual paste.
   */
  getTelegramBotUsername?: () => Promise<string | null>
  /**
   * Resolves the official WhatsApp bot's number so the Settings UI can tell the
   * user where to send their code (and render a `wa.me` deep link). Hosted-only
   * — absent in OSS, which is what gates `POST /whatsapp/link-code` off.
   * See docs/architecture/channels/whatsapp.md → "Account linking".
   */
  getWhatsappOfficialNumber?: () => Promise<string | null>
  /**
   * Default blob client for legacy avatar rows and files-less route gating.
   * New writes route through `filesResolver` instead.
   */
  blobClient?: GcsFilesClient
  /** Routes avatar bytes through the active/recorded workspace backend. */
  filesResolver?: FilesClientResolver
  /** Authorizes the workspace selected by app-web for a new avatar write. */
  workspaceMembership?: (userId: string, workspaceId: string) => Promise<unknown | null>
}

type StoredAvatar = {
  avatarStorageKey: string | null
  avatarStorageWorkspaceId: string | null
  avatarStorageUri: string | null
}

async function clientForStoredAvatar(
  avatar: StoredAvatar,
  blobClient: GcsFilesClient,
  filesResolver: FilesClientResolver,
): Promise<GcsFilesClient> {
  if (avatar.avatarStorageWorkspaceId && avatar.avatarStorageUri) {
    return filesResolver.forUri(avatar.avatarStorageWorkspaceId, avatar.avatarStorageUri)
  }
  return blobClient
}

// Avatars are small: cap at 5 MB and a single file. Memory storage keeps the
// bytes in `req.file.buffer` so we can hand them straight to the blob client.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 1 },
})

/**
 * Account / privacy routes.
 * See docs/architecture/features/privacy-controls.md for the full spec and the
 * rationale behind the team-ownership guard. Component tag: [COMP:api/account-route].
 *
 *   GET    /api/account/linked-accounts      — list linked provider accounts
 *   DELETE /api/account/linked-accounts/:id — unlink a provider account
 *   POST   /api/account/telegram/link-code   — mint a 6-char Telegram link code
 *                                              (first-owned assistant, Settings flow)
 *   DELETE /api/account/memories             — wipe memories + user_souls for the calling user
 *   DELETE /api/account                      — tear down the user's entire footprint
 *   PATCH  /api/account/profile              — update display name
 *   POST   /api/account/avatar               — upload an avatar (blob client required)
 *   DELETE /api/account/avatar               — remove the uploaded avatar
 *
 * All routes here require real auth (no guest fallback) — mounted behind
 * requireAuth, not optionalAuth. The PUBLIC avatar proxy
 * (`GET /api/account/avatar/:userId`) is a SEPARATE router
 * (`accountAvatarPublicRoutes`) mounted without auth — see its docstring and
 * docs/architecture/platform/user-profile.md.
 */
export function accountRoutes(options: AccountRouteOptions = {}): Router {
  const router = Router()

  // ── GET /api/account/linked-accounts ──────────────────────────

  router.get('/linked-accounts', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' })
      return
    }
    if (!options.linkedAccountStore) {
      res.json({ linkedAccounts: [] })
      return
    }
    try {
      const linkedAccounts = await options.linkedAccountStore.listForUser(userId)
      res.json({ linkedAccounts })
    } catch (err) {
      console.error('[account] list linked accounts failed:', err)
      res.status(500).json({ error: 'Failed to list linked accounts' })
    }
  })

  // ── DELETE /api/account/linked-accounts/:id ─────────────────────

  router.delete('/linked-accounts/:id', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' })
      return
    }
    if (!options.linkedAccountStore) {
      res.status(404).json({ error: 'Not found' })
      return
    }
    try {
      const deleted = await options.linkedAccountStore.deleteForUser(userId, req.params.id)
      if (!deleted) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      res.json({ ok: true })
    } catch (err) {
      console.error('[account] delete linked account failed:', err)
      res.status(500).json({ error: 'Failed to delete linked account' })
    }
  })

  // ── POST /api/account/telegram/link-code ────────────────────────
  // Settings → Account → Connected accounts "Connect" flow. Mints a
  // 6-char code bound to the user's FIRST-OWNED assistant (same rule the
  // Mini App onramp uses — see tryLinkTelegram in routes/auth.ts). The
  // user delivers the code via the t.me deep link (`/start <code>`) or by
  // pasting it into the bot chat; redemption upserts the identity row, so
  // a Telegram account already linked elsewhere MOVES to this user.
  // See docs/architecture/platform/auth.md → "Linked accounts".

  router.post('/telegram/link-code', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' })
      return
    }
    if (!options.linkCodeStore) {
      res.status(503).json({ error: 'Telegram linking not configured' })
      return
    }

    try {
      const assistantRow = await query<{ id: string }>(
        `SELECT id FROM assistants
         WHERE owner_user_id = $1
         ORDER BY created_at ASC
         LIMIT 1`,
        [userId],
      )
      const assistantId = assistantRow.rows[0]?.id
      if (!assistantId) {
        res.status(409).json({ error: 'no_assistant' })
        return
      }

      const code = await options.linkCodeStore.create({ userId, assistantId })
      const botUsername = options.getTelegramBotUsername
        ? await options.getTelegramBotUsername().catch(() => null)
        : null
      res.json({ code: code.code, expiresAt: code.expiresAt, botUsername })
    } catch (err) {
      console.error('[account] telegram link-code failed:', err)
      res.status(500).json({ error: 'Failed to generate linking code' })
    }
  })

  // ── POST /api/account/whatsapp/link-code ────────────────────────
  // Settings → Account → Connected accounts "Connect" flow for the official
  // WhatsApp bot. Same shape as the Telegram route above: mint a 6-char code
  // bound to the user's FIRST-OWNED assistant; the user sends it to the
  // official number and the bot redeems it (whatsapp.ts → "Step A: Link code
  // detection"), upserting the `whatsapp` identity.
  //
  // `officialNumber` is returned so the UI can name the number to message and
  // build a wa.me deep link. It doubles as the hosted gate: the resolver is
  // injected only by the hosted API, so OSS gets 503 rather than a code the
  // user has nowhere to send. See docs/architecture/channels/whatsapp.md →
  // "Account linking".

  router.post('/whatsapp/link-code', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' })
      return
    }
    if (!options.linkCodeStore || !options.getWhatsappOfficialNumber) {
      res.status(503).json({ error: 'WhatsApp linking not configured' })
      return
    }

    try {
      // A code the user can't deliver is worse than an honest failure — resolve
      // the number first and refuse if the official bot isn't paired.
      const officialNumber = await options.getWhatsappOfficialNumber().catch(() => null)
      if (!officialNumber) {
        res.status(503).json({ error: 'official_bot_unavailable' })
        return
      }

      const assistantRow = await query<{ id: string }>(
        `SELECT id FROM assistants
         WHERE owner_user_id = $1
         ORDER BY created_at ASC
         LIMIT 1`,
        [userId],
      )
      const assistantId = assistantRow.rows[0]?.id
      if (!assistantId) {
        res.status(409).json({ error: 'no_assistant' })
        return
      }

      const code = await options.linkCodeStore.create({ userId, assistantId })
      res.json({ code: code.code, expiresAt: code.expiresAt, officialNumber })
    } catch (err) {
      console.error('[account] whatsapp link-code failed:', err)
      res.status(500).json({ error: 'Failed to generate linking code' })
    }
  })

  // ── PATCH /api/account/timezone ─────────────────────────────────

  router.patch('/timezone', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' })
      return
    }

    const { timezone } = req.body as { timezone?: string }
    if (!timezone || typeof timezone !== 'string') {
      res.status(400).json({ error: 'Missing timezone' })
      return
    }

    // Validate IANA timezone
    try {
      Intl.DateTimeFormat(undefined, { timeZone: timezone })
    } catch {
      res.status(400).json({ error: 'Invalid IANA timezone' })
      return
    }

    try {
      await updateUserTimezone(userId, timezone)
      res.json({ ok: true, timezone })
    } catch (err) {
      console.error('[account] timezone update failed:', err)
      res.status(500).json({ error: 'Failed to update timezone' })
    }
  })

  // ── DELETE /api/account/memories ───────────────────────────────

  router.delete('/memories', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' })
      return
    }

    try {
      // RLS double-scopes by user_id, but we still pass the predicate
      // explicitly so the DELETE is obvious on inspection.
      const mem = await queryWithRLS(
        userId,
        `DELETE FROM memories WHERE user_id = $1`,
        [userId],
      )
      const souls = await queryWithRLS(
        userId,
        `DELETE FROM user_souls WHERE user_id = $1`,
        [userId],
      )

      // Fire-and-forget analytics event — do not block on failure.
      query(
        `INSERT INTO analytics_events (user_id, event_name, metadata, channel_type)
         VALUES ($1, $2, $3, 'web')`,
        [
          userId,
          'memories_wiped',
          JSON.stringify({ count: (mem.rowCount ?? 0) + (souls.rowCount ?? 0) }),
        ],
      ).catch((err) => console.error('memories_wiped analytics log failed:', err))

      res.json({
        ok: true,
        memoriesDeleted: mem.rowCount ?? 0,
        soulsDeleted: souls.rowCount ?? 0,
      })
    } catch (err) {
      console.error('Delete memories error:', err)
      res.status(500).json({ error: 'Failed to delete memories' })
    }
  })

  // ── DELETE /api/account ────────────────────────────────────────

  router.delete('/', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' })
      return
    }

    try {
      // Capture a snapshot of the user for the final analytics event + logs.
      // If the user is already gone, treat it as idempotent success (204).
      const user = await findUserById(userId)
      if (!user) {
        res.status(204).end()
        return
      }

      // ── Pre-flight: team-ownership guard ─────────────────────
      // Any assistant the user owns that has OTHER members must be
      // transferred first. We refuse the delete rather than silently
      // destroying shared team data. See migration 007's comment on
      // why assistants.owner_user_id stays RESTRICT.
      //
      // Post-089 (team-connector promotion Stage 5): team assistants
      // have NULL owner_user_id, so this query only catches shared
      // personal assistants (the pre-promotion case). The separate
      // team-ownership guard below catches the post-promotion case.
      const teamOwned = await query<{ id: string; name: string; member_count: string }>(
        `SELECT a.id, a.name, COUNT(am.*) as member_count
         FROM assistants a
         JOIN assistant_members am ON am.assistant_id = a.id
         WHERE a.owner_user_id = $1
         GROUP BY a.id, a.name
         HAVING COUNT(am.*) > 1`,
        [userId],
      )

      if (teamOwned.rows.length > 0) {
        res.status(409).json({
          error: 'transfer_ownership_required',
          message:
            'You still own assistants with other members. Transfer ownership or remove the other members before deleting your account.',
          assistants: teamOwned.rows.map((r) => ({
            id: r.id,
            name: r.name,
            memberCount: Number(r.member_count),
          })),
        })
        return
      }

      // ── Pre-flight: team-owner guard ─────────────────────────
      // Owned workspaces cascade via FK on `workspaces.owner_user_id
      // ON DELETE CASCADE`, which would silently wipe workspace
      // assistants + sessions + memories + KB. That is only a problem
      // when the workspace has OTHER members — so the guard blocks on
      // shared workspaces only. Solo-owned workspaces (including the
      // auto-created Personal one, which is never user-deletable) hold
      // nobody else's data and are torn down by the cascade below.
      // The pre-2026-07-21 version blocked on ANY owned workspace,
      // which made account deletion unsatisfiable for every user: the
      // Personal workspace exists since signup and can't be deleted.
      const ownedTeams = await query<{ id: string; name: string; member_count: string }>(
        `SELECT w.id, w.name,
                (SELECT COUNT(*) FROM workspace_members wm
                  WHERE wm.workspace_id = w.id AND wm.user_id <> $1) AS member_count
           FROM workspaces w
          WHERE w.owner_user_id = $1
            AND EXISTS (
              SELECT 1 FROM workspace_members wm
               WHERE wm.workspace_id = w.id AND wm.user_id <> $1
            )`,
        [userId],
      )

      if (ownedTeams.rows.length > 0) {
        res.status(409).json({
          error: 'transfer_team_ownership_required',
          message:
            'You still own workspaces with other members. Transfer ownership, remove the other members, or delete these workspaces before deleting your account — otherwise their shared data (assistants, memories, knowledge) would be lost.',
          teams: ownedTeams.rows.map((r) => ({
            id: r.id,
            name: r.name,
            memberCount: Number(r.member_count),
          })),
        })
        return
      }

      // ── Transactional teardown ───────────────────────────────
      // Single pooled client wrapping BEGIN/COMMIT. Every statement rolls
      // back together on failure — nothing half-deleted.
      const client = await getPool().connect()
      let ownedAssistantsDeleted = 0
      try {
        await client.query('BEGIN')

        // Final analytics event goes FIRST — the user row still exists
        // so the FK is valid. It'll be cascade-deleted along with the user
        // below, but that's fine because analytics is fire-and-forget and
        // the event would only matter in a future warehouse sink anyway.
        await client.query(
          `INSERT INTO analytics_events (user_id, event_name, metadata, channel_type)
           VALUES ($1, $2, $3, 'web')`,
          [
            userId,
            'account_deleted',
            JSON.stringify({
              had_stripe_customer: user.stripeCustomerId !== null,
              auth_provider: user.authProvider,
            }),
          ],
        )

        // Delete solo-owned assistants (owner + zero other members).
        // Cascades through all assistant-scoped children via migration 007.
        const solo = await client.query(
          `DELETE FROM assistants
           WHERE owner_user_id = $1
             AND NOT EXISTS (
               SELECT 1 FROM assistant_members
               WHERE assistant_id = assistants.id
                 AND user_id <> $1
             )`,
          [userId],
        )
        ownedAssistantsDeleted = solo.rowCount ?? 0

        // Finally, the user itself. Everything else (memberships in OTHER
        // team assistants, personal usage_tracking, memories in other
        // assistants, etc.) cascades via migration 007.
        await client.query(`DELETE FROM users WHERE id = $1`, [userId])

        await client.query('COMMIT')
      } catch (err) {
        await client.query('ROLLBACK').catch(() => {})
        throw err
      } finally {
        client.release()
      }

      // ── Deferred cleanup (warnings only — see 25-privacy-controls.md) ──
      if (user.stripeCustomerId) {
        console.warn(
          `[account-delete] Stripe customer cleanup owed: ${user.stripeCustomerId} (user ${userId})`,
        )
      }
      console.warn(
        `[account-delete] Refresh token denylist owed: user ${userId} — access tokens expire within 1h`,
      )
      console.log(
        `[account-delete] Deleted user ${userId}, ${ownedAssistantsDeleted} assistants cascaded`,
      )

      res.status(204).end()
    } catch (err) {
      console.error('Delete account error:', err)
      res.status(500).json({ error: 'Failed to delete account' })
    }
  })

  // ── PATCH /api/account/profile ─────────────────────────────────
  // Update the display name. Avatar routes follow, gated on a blob client.

  router.patch('/profile', async (req, res) => {
    const userId = req.userId
    if (!userId) {
      res.status(401).json({ error: 'Missing or invalid Authorization header' })
      return
    }

    const raw = (req.body as { name?: unknown }).name
    if (typeof raw !== 'string') {
      res.status(400).json({ error: 'Missing name' })
      return
    }
    const name = raw.trim()
    if (name.length < 1 || name.length > 80) {
      res.status(400).json({ error: 'Name must be 1–80 characters' })
      return
    }

    try {
      await updateUserProfile(userId, { name })
      res.json({ name })
    } catch (err) {
      console.error('[account] profile update failed:', err)
      res.status(500).json({ error: 'Failed to update profile' })
    }
  })

  // ── Avatar upload / remove (only when storage + membership are wired) ──
  // GET /api/account/avatar/:userId is served by the separate PUBLIC router
  // (accountAvatarPublicRoutes) — it must be reachable without a Bearer token.

  if (options.blobClient && options.filesResolver && options.workspaceMembership) {
    const blobClient = options.blobClient
    const filesResolver = options.filesResolver
    const workspaceMembership = options.workspaceMembership

    // POST /api/account/avatar — multipart fields "file" + "workspaceId".
    router.post('/avatar', upload.single('file'), async (req, res) => {
      const userId = req.userId
      if (!userId) {
        res.status(401).json({ error: 'Missing or invalid Authorization header' })
        return
      }

      const file = req.file
      if (!file) {
        res.status(400).json({ error: 'No file provided' })
        return
      }
      if (!isAllowedMime(file.mimetype) || !file.mimetype.startsWith('image/')) {
        res.status(400).json({ error: 'Avatar must be an image' })
        return
      }

      const workspaceId = typeof req.body.workspaceId === 'string' ? req.body.workspaceId.trim() : ''
      if (!workspaceId) {
        res.status(400).json({ error: 'Missing workspaceId' })
        return
      }

      try {
        if (!(await workspaceMembership(userId, workspaceId))) {
          res.status(403).json({ error: 'Not a member of this workspace' })
          return
        }

        const current = await findUserById(userId)
        const avatarId = crypto.randomUUID()
        const key = buildStorageKey(workspaceId, avatarId)
        const resolved = await filesResolver.forWorkspace(workspaceId)
        const storageUri = buildStorageUri(resolved.bucket, workspaceId, avatarId, resolved.uriScheme)
        await resolved.gcs.writeBlob(key, file.buffer, {
          workspaceId,
          createdByUserId: userId,
          mime: file.mimetype,
        })

        // Absolute proxy URL composed from the request so it works across the
        // api / dev / prod hosts. The `?v=` cache-bust forces the <img> to
        // refetch after a re-upload (the proxy URL path is otherwise stable).
        const v = avatarId.slice(0, 8)
        const avatarUrl = `${req.protocol}://${req.get('host')}/api/account/avatar/${userId}?v=${v}`
        try {
          const updated = await updateUserAvatar(userId, {
            url: avatarUrl,
            storageKey: key,
            storageWorkspaceId: workspaceId,
            storageUri,
            previousStorageKey: current?.avatarStorageKey ?? null,
          })
          if (!updated) {
            await resolved.gcs.deleteBlob(key).catch(() => {})
            res.status(409).json({ error: 'Avatar changed concurrently. Try again.' })
            return
          }
        } catch (err) {
          await resolved.gcs.deleteBlob(key).catch(() => {})
          throw err
        }

        // Persist the new provenance before deleting the old object. A failed
        // cleanup leaves an orphan, not a user with a broken avatar URL.
        if (current?.avatarStorageKey) {
          const previousClient = await clientForStoredAvatar(current, blobClient, filesResolver).catch(() => null)
          await previousClient?.deleteBlob(current.avatarStorageKey).catch(() => {})
        }
        res.json({ avatarUrl })
      } catch (err) {
        console.error('[account] avatar upload failed:', err)
        res.status(500).json({ error: 'Failed to upload avatar' })
      }
    })

    // DELETE /api/account/avatar — remove the uploaded photo.
    router.delete('/avatar', async (req, res) => {
      const userId = req.userId
      if (!userId) {
        res.status(401).json({ error: 'Missing or invalid Authorization header' })
        return
      }

      try {
        const current = await findUserById(userId)
        if (current?.avatarStorageKey) {
          const storedClient = await clientForStoredAvatar(current, blobClient, filesResolver)
          await storedClient.deleteBlob(current.avatarStorageKey).catch(() => {})
        }
        const cleared = await clearUserAvatar(userId, current?.avatarStorageKey ?? null)
        if (!cleared) {
          res.status(409).json({ error: 'Avatar changed concurrently. Try again.' })
          return
        }
        res.json({ ok: true })
      } catch (err) {
        console.error('[account] avatar delete failed:', err)
        res.status(500).json({ error: 'Failed to remove avatar' })
      }
    })
  }

  return router
}

/**
 * Public avatar proxy. Separate router so `GET /:userId` is reachable WITHOUT
 * a Bearer token — an `<img>` can't send one, and the photo renders cross-app
 * and for other members. Mounted at `/api/account/avatar` BEFORE the authed
 * `/api/account` router; the authed POST/DELETE `/avatar` handlers have no
 * match here so Express falls through to them. Only uploaded avatars use this
 * URL (Google users keep their hot-link). Avatars are low-sensitivity —
 * consistent with Google avatar URLs already being world-readable.
 *
 * See docs/architecture/platform/user-profile.md → "Uploading your own photo".
 */
export function accountAvatarPublicRoutes(options: {
  blobClient: GcsFilesClient
  filesResolver: FilesClientResolver
}): Router {
  const router = Router()

  router.get('/:userId', async (req, res) => {
    try {
      const user = await findUserById(req.params.userId)
      if (!user || !user.avatarStorageKey) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      const storedClient = await clientForStoredAvatar(user, options.blobClient, options.filesResolver)
      const blob = await storedClient.readBlob(user.avatarStorageKey)
      if (!blob) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      res.setHeader('Content-Type', blob.mime)
      res.setHeader('Cache-Control', 'public, max-age=3600')
      res.send(blob.bytes)
    } catch (err) {
      console.error('[account] avatar proxy failed:', err)
      res.status(500).json({ error: 'Failed to load avatar' })
    }
  })

  return router
}
