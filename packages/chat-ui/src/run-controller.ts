/**
 * Framework-neutral run lifecycle for chat hosts.
 *
 * Phase and transport connection are separate on purpose: a run can be
 * suspended on an approval while its direct response disconnects and a
 * reconnect stream is being opened. [COMP:chat-ui/run-controller]
 */

export type ChatRunPhase =
  | 'idle'
  | 'running'
  | 'suspended'
  | 'completed'
  | 'cancelled'
  | 'failed'

export type ChatConnectionState =
  | 'idle'
  | 'connected'
  | 'disconnected'
  | 'reconnecting'

export type ChatControllerIdentity = {
  sessionId: string | null
  generation: number
}

export type ChatRunState = {
  identity: ChatControllerIdentity
  phase: ChatRunPhase
  connection: ChatConnectionState
  error: string | null
}

export const initialChatRunState: ChatRunState = {
  identity: { sessionId: null, generation: 0 },
  phase: 'idle',
  connection: 'idle',
  error: null,
}

export type ChatRunAction =
  | { type: 'visit'; identity: ChatControllerIdentity }
  | { type: 'adopt-session'; identity: ChatControllerIdentity; sessionId: string }
  | { type: 'begin'; identity: ChatControllerIdentity }
  | { type: 'suspend'; identity: ChatControllerIdentity }
  | { type: 'disconnect'; identity: ChatControllerIdentity }
  | { type: 'reconnect'; identity: ChatControllerIdentity }
  | { type: 'connected'; identity: ChatControllerIdentity }
  | { type: 'complete'; identity: ChatControllerIdentity }
  | { type: 'cancel'; identity: ChatControllerIdentity }
  | { type: 'fail'; identity: ChatControllerIdentity; error?: string }

export function sameChatControllerIdentity(
  current: ChatControllerIdentity,
  candidate: ChatControllerIdentity,
): boolean {
  if (current.generation !== candidate.generation) return false
  // A fresh turn has no server session id until its `session` frame arrives.
  // Generation is its identity during that short provisional window.
  return current.sessionId === null || candidate.sessionId === null
    ? true
    : current.sessionId === candidate.sessionId
}

function isTerminal(phase: ChatRunPhase): boolean {
  return phase === 'completed' || phase === 'cancelled' || phase === 'failed'
}

export function chatRunReducer(
  state: ChatRunState,
  action: ChatRunAction,
): ChatRunState {
  if (action.type === 'visit') {
    if (action.identity.generation <= state.identity.generation) return state
    return {
      identity: action.identity,
      phase: 'idle',
      connection: 'idle',
      error: null,
    }
  }

  if (!sameChatControllerIdentity(state.identity, action.identity)) return state

  if (action.type === 'adopt-session') {
    if (state.identity.sessionId === action.sessionId) return state
    if (state.identity.sessionId !== null) return state
    return { ...state, identity: { ...state.identity, sessionId: action.sessionId } }
  }

  if (action.type === 'begin') {
    return {
      ...state,
      identity: action.identity,
      phase: 'running',
      connection: 'connected',
      error: null,
    }
  }

  if (isTerminal(state.phase)) return state

  switch (action.type) {
    case 'suspend':
      return { ...state, phase: 'suspended' }
    case 'disconnect':
      return { ...state, connection: 'disconnected' }
    case 'reconnect':
      return { ...state, connection: 'reconnecting' }
    case 'connected':
      return { ...state, connection: 'connected' }
    case 'complete':
      return { ...state, phase: 'completed', connection: 'idle' }
    case 'cancel':
      return { ...state, phase: 'cancelled', connection: 'idle' }
    case 'fail':
      return {
        ...state,
        phase: 'failed',
        connection: 'idle',
        error: action.error ?? null,
      }
  }
}
