/**
 * First-party Learn Japanese installation routes.
 *
 * These endpoints accept Brian OAuth access tokens only. The token selects a
 * single workspace and identifies the consenting user. Installation rechecks
 * that user's live admin role and requires read_write scope before creating
 * one workspace-owned Japanese Teacher app assistant.
 *
 * Component tag: [COMP:api/learn-japanese-install].
 * Spec: docs/architecture/features/programmatic-access.md
 */

import { randomInt } from 'node:crypto'
import { Router, type Request } from 'express'
import type { BrainAuth } from '../brain-mcp/auth.js'
import { authenticateBrainRequest } from '../brain-mcp/auth.js'
import type { BrainKeyStore } from '../db/brain-keys-store.js'
import type { OAuthAuthorizationStore } from '../db/oauth-authorization-store.js'
import { query } from '../db/client.js'
import type { WorkspaceStore } from '../db/workspace-store.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'

type AssistantRow = {
  id: string
  name: string
}

type QueryResult<Row> = {
  rows: Row[]
  rowCount?: number | null
}

export type LearnJapaneseQuery = <Row>(
  sql: string,
  params?: unknown[],
) => Promise<QueryResult<Row>>

type Options = {
  brainKeyStore: BrainKeyStore
  authorizationStore: OAuthAuthorizationStore
  workspaceStore: WorkspaceStore
  webAppUrl: string
  authenticate?: (req: Request) => Promise<BrainAuth | null>
  runQuery?: LearnJapaneseQuery
}

const ASSISTANT_NAME = 'Japanese Teacher'

function assistantUrl(webAppUrl: string, workspaceId: string, assistantId: string): string {
  const url = new URL(`/w/${workspaceId}/chat`, webAppUrl)
  url.searchParams.set('assistant', assistantId)
  return url.toString()
}

export function learnJapaneseRoutes(opts: Options): Router {
  const router = Router()
  const runQuery = opts.runQuery ?? (query as LearnJapaneseQuery)
  const authenticate = opts.authenticate ?? ((req: Request) =>
    authenticateBrainRequest(req, {
      brainKeyStore: opts.brainKeyStore,
      authorizationStore: opts.authorizationStore,
    }))

  async function oauthAuth(req: Request): Promise<BrainAuth | null> {
    const auth = await authenticate(req)
    return auth?.authKind === 'oauth_token' && auth.actingUserId ? auth : null
  }

  router.post('/install', async (req, res) => {
    const auth = await oauthAuth(req)
    if (!auth) {
      res.status(401).json({ error: 'oauth_token_required' })
      return
    }
    if (auth.scope !== 'read_write') {
      res.status(403).json({ error: 'read_write_scope_required' })
      return
    }

    const role = await opts.workspaceStore.getRole(auth.actingUserId!, auth.workspaceId)
    if (role !== 'owner' && role !== 'admin') {
      res.status(403).json({ error: 'workspace_admin_required' })
      return
    }

    try {
      const existing = await runQuery<AssistantRow>(
        `SELECT id, name
         FROM assistants
         WHERE workspace_id = $1 AND kind = 'app' AND app_type = 'learn-japanese'
         ORDER BY created_at ASC
         LIMIT 1`,
        [auth.workspaceId],
      )

      let assistant = existing.rows[0]
      let created = false
      if (!assistant) {
        const inserted = await runQuery<AssistantRow>(
          `INSERT INTO assistants
             (name, owner_user_id, workspace_id, icon_seed, clearance, kind, app_type, bio)
           VALUES ($1, NULL, $2, $3, 'internal', 'app', 'learn-japanese', $4)
           ON CONFLICT DO NOTHING
           RETURNING id, name`,
          [
            ASSISTANT_NAME,
            auth.workspaceId,
            randomInt(0, 1_000_000),
            'Conversation practice and corrective teaching for Japanese learners',
          ],
        )
        assistant = inserted.rows[0]
        created = Boolean(assistant)

        // A concurrent install may have won the partial unique index. Resolve
        // its row and return the same successful installation.
        if (!assistant) {
          const raced = await runQuery<AssistantRow>(
            `SELECT id, name
             FROM assistants
             WHERE workspace_id = $1 AND kind = 'app' AND app_type = 'learn-japanese'
             ORDER BY created_at ASC
             LIMIT 1`,
            [auth.workspaceId],
          )
          assistant = raced.rows[0]
        }
      }

      if (!assistant) {
        throw new Error('Japanese Teacher installation did not produce an assistant')
      }
      if (created) {
        notifyWorkspaceChange(auth.workspaceId, 'assistant', 'create', assistant.id)
      }
      res.status(created ? 201 : 200).json({
        workspaceId: auth.workspaceId,
        assistantId: assistant.id,
        assistantName: assistant.name,
        assistantUrl: assistantUrl(opts.webAppUrl, auth.workspaceId, assistant.id),
        created,
      })
    } catch (err) {
      console.error('[learn-japanese] install failed:', err)
      res.status(500).json({ error: 'install_failed' })
    }
  })

  router.delete('/connection', async (req, res) => {
    const auth = await oauthAuth(req)
    if (!auth) {
      res.status(401).json({ error: 'oauth_token_required' })
      return
    }
    try {
      await opts.authorizationStore.revoke(auth.actingUserId!, auth.keyId)
      res.status(204).end()
    } catch (err) {
      console.error('[learn-japanese] disconnect failed:', err)
      res.status(500).json({ error: 'disconnect_failed' })
    }
  })

  return router
}
