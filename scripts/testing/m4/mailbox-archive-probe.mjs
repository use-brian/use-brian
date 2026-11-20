/** [COMP:invariants/chat-import-graph] Fictional read-only archive probe. */
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

export const MAILBOX_QUERY = 'fictional amber notebook'
export const MAILBOX_PROMPT = `Search my synced email archive for "${MAILBOX_QUERY}" and tell me the receipt from the matching email.`
export const MAILBOX_RECEIPT = 'Fictional mailbox receipt LARCH-6291.'

export function mailboxFixtureResponse(request) {
  const messages = request.messages ?? []
  const text = value => typeof value === 'string' ? value : JSON.stringify(value)
  if (!messages.some(message => message.role === 'user' && text(message.content)?.includes(MAILBOX_PROMPT))) return null
  const offered = name => request.tools?.some(tool => tool.function?.name === name)
  const toolResults = messages.filter(message => message.role === 'tool').map(message => text(message.content))
  if (toolResults.some(result => result?.includes(MAILBOX_RECEIPT))) return { answer: MAILBOX_RECEIPT, receivedArchiveReceipt: true }
  const discovered = toolResults.map(result => /^\[([^\]]+)\][^\n]*?\bsearchEmailArchive:/m.exec(result ?? '')).find(Boolean)
  if (discovered && offered('mcp_call') && toolResults.length === 1) {
    return { name: 'mcp_call', args: { server: discovered[1], tool: 'searchEmailArchive', args: { query: MAILBOX_QUERY } } }
  }
  if (toolResults.length === 0 && offered('searchEmailArchive')) return { name: 'searchEmailArchive', args: { query: MAILBOX_QUERY } }
  if (toolResults.length === 0 && offered('mcp_search')) return { name: 'mcp_search', args: { query: 'searchEmailArchive', limit: 1 } }
  return { answer: 'The fictional archive did not return a receipt.', receivedArchiveReceipt: false }
}

function provisionMailbox(root, env, workspaceId) {
  const script = fileURLToPath(new URL('./provision-mailbox.mjs', import.meta.url))
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], { cwd: root, env: { ...env, BRIAN_ACCEPTANCE_OSS_ROOT: root,
      BRIAN_ACCEPTANCE_WORKSPACE_ID: workspaceId }, stdio: ['ignore', 'ignore', 'pipe', 'ipc'] })
    let result, errorOutput = ''
    child.stderr.on('data', chunk => { errorOutput += chunk })
    child.once('message', message => { if (message.type === 'fixture-mailbox') result = message })
    child.once('error', reject)
    child.once('close', code => code === 0 && result ? resolve(result) : reject(new Error(`Fixture mailbox provisioning failed (${code}): ${errorOutput.slice(-1000)}`)))
  })
}

export async function runMailboxArchiveProbe({ root, fixtureEnv, port, turn, accessToken, provider }) {
  const seed = await provisionMailbox(root, fixtureEnv, turn.workspaceId)
  const base = `http://127.0.0.1:${port}`
  const headers = { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' }
  const request = (path, body) => fetch(base + path, {
    method: body ? 'POST' : 'GET', headers, signal: AbortSignal.timeout(90_000), ...(body ? { body: JSON.stringify(body) } : {}),
  })
  const created = await request('/api/sessions/workspace', { workspaceId: turn.workspaceId })
  if (created.status !== 201) throw new Error(`Mailbox conversation creation: HTTP ${created.status}`)
  const { id: sessionId, assistantId } = await created.json()
  const requestStart = provider.requests.length
  const response = await request('/api/chat', { workspaceId: turn.workspaceId, sessionId, assistantId, message: MAILBOX_PROMPT, mode: 'default' })
  const frames = (await response.text()).split(/\r?\n\r?\n/)
  const events = frames.flatMap(frame => {
    const type = /^event: ([^\r\n]+)$/m.exec(frame)?.[1]
    const data = frame.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n')
    return type && data ? [{ type, data: JSON.parse(data) }] : []
  })
  const assistant = events.filter(event => event.type === 'text_delta').map(event => event.data.text).join('')
  const tools = events.filter(event => event.type === 'tool_result').map(event => ({ name: event.data.name, isError: event.data.isError }))
  const providerRequests = provider.requests.slice(requestStart)
  if (response.status !== 200 || events.some(event => event.type === 'error') || assistant !== MAILBOX_RECEIPT
    || !tools.some(tool => ['searchEmailArchive', 'mcp_call'].includes(tool.name) && !tool.isError)
    || !providerRequests.some(request => request.receivedArchiveReceipt === true)) {
    return { status: 'fail', reason: 'Injected archive search did not deliver the seeded receipt', httpStatus: response.status,
      tools, providerActions: providerRequests.map(request => request.mailboxAction).filter(Boolean) }
  }
  const history = await request(`/api/sessions/${sessionId}/messages`)
  if (!history.ok) throw new Error(`Mailbox conversation reopen: HTTP ${history.status}`)
  const body = await history.json()
  const messages = Array.isArray(body) ? body : body.messages
  const last = messages?.at(-1)
  const persisted = Array.isArray(last?.content) ? last.content.filter(part => part.type === 'text').map(part => part.text).join('') : last?.content
  if (last?.role !== 'assistant' || persisted !== MAILBOX_RECEIPT) throw new Error('Mailbox answer changed in reopened history')
  return { status: 'pass', httpStatus: response.status, path: 'searchEmailArchive via injected connector and owner-scoped database archive',
    sessionId, exactReopenedAnswer: true, fixtureMessageSegments: seed.segmentCount, outsiderArchiveVisible: seed.outsiderVisible, tools }
}
