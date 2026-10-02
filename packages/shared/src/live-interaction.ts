/** Live microphone interaction wire contract. [COMP:recordings/live-interaction] */
export const DEFAULT_INTERACTION_RULE = 'When I say Hey Brian, answer the question that follows.'
export type InteractionSource = 'microphone' | 'system'
export type InteractionSettings = { rule: string }
export type InteractionCapture = {
  id: string; workspaceId: string; pageId: string; chatSessionId: string; assistantId: string
  rule: string; state: 'listening' | 'stopped'
}
export type InteractionUtterance = {
  id: string; source: InteractionSource; text: string; startMs: number; endMs: number
  /** Previous provider item, when available, for ordering final ASR events. */
  previousId?: string | null
  /** A source gap or pause breaks pending question assembly. */
  discontinuity?: boolean
}
export type InteractionJob = {
  id: string; captureId: string; chatSessionId: string; pageId: string
  question: string; status: 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'
  answer: string; error: string | null; createdAt: string
  userMessageId?: string | null; assistantMessageId?: string | null
}
/** Routes mounted under /api/recordings/interaction (authenticated):
 * GET /settings -> { rule, available }; PUT /settings {rule} -> {rule}
 * POST /preview {rule,text} -> {question: string|null}
 * POST /start {workspaceId,pageId,chatSessionId,assistantId} -> InteractionCapture
 * Audio enters through POST /api/recordings/live/chunk (existing ~30-second windows):
 * multipart audio + interactionCaptureId + interactionSource ('microphone'|'mixed').
 * Mixed capture may include isolated microphone audio; main audio is system context only.
 * Mic-only audio is transcribed once; mixed isolated audio uses the same configured ASR.
 * Text is server-generated; no token or client utterance endpoint exists.
 * Optional discontinuity='true' breaks pending questions at pause boundaries.
 * Chunk response may include interactionError:true without losing the canonical transcript.
 * Wait for all live windows to finish before POST /:captureId/stop.
 * POST /:captureId/question {id:uuid,action:'submit'|'cancel',text?:string} -> {ok:true}
 * Owner-only, durable request-id deduplication. Submit requires nonempty text (max 8000),
 * bypasses the speech rule, and allows correction after stop. Both actions clear pending
 * pre-control detection, never accepted jobs. Typed text is not transcript evidence.
 * POST /:captureId/stop -> {ok:true}
 * GET /jobs?workspaceId=...&chatSessionId=... -> {jobs:InteractionJob[]}
 * POST /jobs/:jobId/cancel -> {ok:true}; POST /jobs/:jobId/retry -> {ok:true}
 * Jobs retain stable IDs and deliver final text to canonical chat messages.
 */
