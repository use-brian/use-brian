#!/usr/bin/env node
// [COMP:app-web/conversation-controller] M5 browser qualification fixtures (test fixture only).
// Prepares invented identities on a LOCAL OSS stack (never a hosted or personal deployment):
//   - local owner (POST /auth/local-session) and dev users m5-mate, m5-other (POST /auth/dev-login?as=)
//   - m5-mate added as a workspace member, then given `confidential` clearance through the product's
//     reviewed access command (command-review, then access.command.apply), so it can read rooms the
//     owner starts; without it the room answers 403 "Session context unavailable"
//   - a second assistant "M5 Helper" for response groups, raised to `confidential` (the room clearance rule)
//   - a private page for dock journeys
// Writes M5_WORK_DIR/fixtures.json. Usage: M5_WORK_DIR=/tmp/m5 node m5-qualification-fixtures.mjs
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'

const API = process.env.M5_API || 'http://127.0.0.1:4100'
const WORK = process.env.M5_WORK_DIR || '/tmp/m5-qualification'
mkdirSync(WORK, { recursive: true })

async function token(as) {
  const r = await fetch(as ? `${API}/auth/dev-login?as=${as}` : `${API}/auth/local-session`, { method: 'POST' })
  if (!r.ok) throw new Error(`sign-in ${as ?? 'owner'} failed: ${r.status}`)
  return r.json()
}
async function api(tok, method, path, body) {
  const r = await fetch(`${API}${path}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined })
  let j = null
  try { j = await r.json() } catch { /* empty body */ }
  return { status: r.status, body: j }
}

const owner = await token()
const mate = await token('m5-mate')
const other = await token('m5-other')
const ws = await api(owner.accessToken, 'GET', '/api/workspaces')
const list = ws.body?.workspaces ?? ws.body?.teams ?? ws.body
const workspaceId = process.env.M5_WORKSPACE_ID || list?.[0]?.id
if (!workspaceId) throw new Error('owner workspace not found')

const addMember = await api(owner.accessToken, 'POST', `/api/workspaces/${workspaceId}/members`, { email: mate.user.email, memberRole: 'member' })
const overview = await api(owner.accessToken, 'GET', `/api/workspaces/${workspaceId}/access`)
const rev = String(overview.body?.policyRevision)
const review = await api(owner.accessToken, 'POST', `/api/workspaces/${workspaceId}/access/command-review`, {
  command: { type: 'member.access.set', userId: mate.user.id, clearance: 'confidential', teamScopeMode: 'legacy', expectedPolicyRevision: rev },
  expectedPolicyRevision: rev, idempotencyKey: randomUUID(),
})
const apply = review.body?.id
  ? await api(owner.accessToken, 'POST', `/api/workspaces/${workspaceId}/access/commands`, { type: 'access.command.apply', reviewId: review.body.id, payloadHash: review.body.payloadHash })
  : { status: null }
const helper = await api(owner.accessToken, 'POST', `/api/workspaces/${workspaceId}/assistants`, { name: 'M5 Helper' })
const assistants = await api(owner.accessToken, 'GET', `/api/assistants?workspaceId=${workspaceId}`)
// Room clearance rule (m2-room-clearance-rule.md): a response-group member must be cleared exactly to the room's
// clearance, and the owner's rooms run at `confidential`. A new assistant starts at `internal`, so without this the
// Helper is skipped ("not cleared to read this room") and the J9 group cannot be exercised.
const helperId = helper.body?.id ?? helper.body?.assistant?.id ?? (assistants.body?.assistants ?? assistants.body ?? []).find((a) => a.name === 'M5 Helper')?.id
async function applyAccess(command) {
  const r = String((await api(owner.accessToken, 'GET', `/api/workspaces/${workspaceId}/access`)).body?.policyRevision)
  const rv = await api(owner.accessToken, 'POST', `/api/workspaces/${workspaceId}/access/command-review`, { command, expectedPolicyRevision: r, idempotencyKey: randomUUID() })
  const ap = rv.body?.id ? await api(owner.accessToken, 'POST', `/api/workspaces/${workspaceId}/access/commands`, { type: 'access.command.apply', reviewId: rv.body.id, payloadHash: rv.body.payloadHash }) : { status: null }
  return { review: rv.status, apply: ap.status }
}
const helperClearance = helperId ? await applyAccess({ type: 'assistant.clearance.set', assistantId: helperId, clearance: 'confidential' }) : { review: null, apply: null }
const page = await api(owner.accessToken, 'POST', `/api/workspaces/${workspaceId}/views/draft`, { name: 'M5 dock page', teamspaceId: null })

const out = {
  workspaceId,
  owner: owner.user, mate: mate.user, other: other.user,
  addMember: addMember.status, clearanceReview: review.status, clearanceApply: apply.status, createAssistant: helper.status,
  helperClearanceReview: helperClearance.review, helperClearanceApply: helperClearance.apply,
  assistants: (assistants.body?.assistants ?? assistants.body ?? []).map((a) => ({ id: a.id, name: a.name })),
  pageId: page.body?.id ?? null,
}
writeFileSync(`${WORK}/fixtures.json`, JSON.stringify(out, null, 2))
writeFileSync(`${WORK}/m5-note.txt`, 'M5 qualification attachment.\nInvented content only.\n')
console.log(JSON.stringify(out, null, 2))
