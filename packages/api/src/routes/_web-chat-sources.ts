import { isWorkspaceWideWebChat, type WebChatEventScope } from './_web-chat-event-scope.js'
import type { RequestHandler } from 'express'

export type WebChatSourceSession = WebChatEventScope & {
  id: string
  workspaceId: string
  assistantId: string
  userId: string
  title: string | null
  appOrigin: string | null
}

// No surface filter: workflow docks and app-assistant chats are web inputs,
// too. Public/API and internally generated workflow channels stay excluded.
// Bounded discovery: inspect the 200 most recently active candidate sessions;
// unreadable candidates are omitted, not replaced with metadata placeholders.
export const WEB_CHAT_SOURCE_SQL = `
  SELECT s.id, a.workspace_id AS "workspaceId", s.assistant_id AS "assistantId",
         s.user_id AS "userId", s.channel_type AS "channelType", s.title,
         s.app_origin AS "appOrigin", s.visibility, s.mode, s.anchor_kind AS "anchorKind",
         s.effective_clearance AS "effectiveClearance",
         s.context_compartments AS "contextCompartments",
         s.context_group_id AS "contextGroupId",
         s.context_project_id AS "contextProjectId"
    FROM sessions s JOIN assistants a ON a.id = s.assistant_id
   WHERE a.workspace_id = $1 AND s.channel_type = 'web' AND s.anchor_kind = 'none'
     AND s.visibility = 'workspace' AND s.mode IS NULL
     AND s.effective_clearance = 'public'
     AND s.context_group_id IS NULL AND s.context_project_id IS NULL
     AND s.context_compartments = ARRAY[]::text[]
   ORDER BY s.last_active_at DESC, s.id
   LIMIT 200`

/** Listing is discovery, not a grant to read a session or execute a workflow.
 * The session UUID is the web source's integration id AND channel id, matching
 * dispatchPersistedWebInput; never substitute the user-chosen channel alias.
 * Apply the SAME producer eligibility guard before returning any label, then
 * the normal session read gate. Read permission alone cannot authorize fan-out.
 */
export function webChatSourcesHandler(deps: {
  isWorkspaceMember: (userId: string, workspaceId: string) => Promise<boolean>
  listCandidates: (workspaceId: string, userId: string) => Promise<WebChatSourceSession[]>
  canReadSession: (userId: string, session: WebChatSourceSession) => Promise<boolean>
}): RequestHandler {
  return async (req, res) => {
    const userId = (req as typeof req & { userId?: string }).userId
    if (!userId) { res.status(401).json({ error: 'Unauthorized' }); return }
    const workspaceId = req.query.workspaceId
    if (typeof workspaceId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(workspaceId)) {
      res.status(400).json({ error: 'workspaceId must be a UUID' }); return
    }
    try {
      if (!await deps.isWorkspaceMember(userId, workspaceId)) {
        res.status(403).json({ error: 'Workspace access required' }); return
      }
      const sessions = await deps.listCandidates(workspaceId, userId)
      const sources = []
      for (const session of sessions) {
        if (session.workspaceId !== workspaceId || !isWorkspaceWideWebChat(session)) continue
        if (!await deps.canReadSession(userId, session)) continue
        sources.push({
          id: session.id,
          channelType: 'web',
          displayName: `${session.title || 'New Chat'} · ${session.appOrigin || 'assistant'} · ${session.id.slice(0, 8)}`,
        })
      }
      res.json({ sources })
    } catch (error) {
      console.error('Web chat source listing failed:', error)
      res.status(500).json({ error: 'Failed to list chat sources' })
    }
  }
}
