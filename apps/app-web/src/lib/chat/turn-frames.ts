/**
 * Zod boundary for chat stream frames. Every frame named in the M5 plan
 * (section 1b) is listed here for the direct `POST /api/chat` stream and the
 * `GET /api/sessions/:id/stream` follow stream, with the field-level
 * tolerance the hosts already apply (`typeof` guards). A frame whose identity
 * fields are missing, or whose name this client does not know, is classified
 * `ignorable`, so a newer server can add frames without breaking this client.
 *
 * Classification drives the conversation controller: paint frames batch,
 * every other class flushes paint first. `turnId` correlation stays with
 * `createChatControllerCoordinator`. See docs/architecture/features/chat-app.md
 * → "Shared client controller ownership". [COMP:app-web/turn-frames]
 */
import { z } from "zod";

export type TurnFrameStream = "direct" | "follow";

export type TurnFrameClass =
  /** Turn and session lifecycle: binding, acceptance, saves, splits. */
  | "lifecycle"
  /** High-rate display frames, coalesced per animation frame. */
  | "paint"
  /** Tool steps and turn attachments accumulated into the transcript. */
  | "activity"
  /** Approval and question cards. */
  | "interaction"
  /** Effects on the surface around the conversation; dispatched once. */
  | "surface-effect"
  /** Presentation-local data (quota, goals, unreachable mentions). */
  | "presentation"
  /** Typed notices (`notice`, `queued`, `input_queued`). */
  | "notice"
  /** Room presence, pins and binding. */
  | "room"
  /** Frames that end a stream or a turn. */
  | "terminal"
  /** Unknown or malformed: never acted on. */
  | "ignorable";

/** Tolerant field readers: a wrong type reads as absent, as in the hosts. */
const optString = z.unknown().transform((value) => (typeof value === "string" ? value : undefined));
const reqString = z.string().min(1);
const optBool = z.unknown().transform((value) => value === true);
const record = z.record(z.unknown());

const payload = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough();
const anyPayload = record;

type FrameSpec = { class: TurnFrameClass; schema: z.ZodTypeAny };

const sessionFrame = payload({ sessionId: optString });
const savedRow = payload({ id: reqString });
const textFrame = payload({ text: optString });
const toolFrame = payload({ id: reqString, name: optString });
const confirmation = payload({ toolCallId: reqString, approvalId: optString, toolName: optString });
const errorFrame = payload({ code: optString, message: optString, error: optString, customEndpoint: optBool });
/** `code`, or (until every server notice carries one) `kind` as the code. */
const noticeFrame = payload({ code: optString, kind: optString }).refine((value) => !!(value.code || value.kind));

const shared: Record<string, FrameSpec> = {
  status: { class: "lifecycle", schema: payload({ status: optString, phase: optString }) },
  user_message_saved: { class: "lifecycle", schema: savedRow },
  done: { class: "terminal", schema: anyPayload },
};

const DIRECT_FRAMES: Record<string, FrameSpec> = {
  ...shared,
  session: { class: "lifecycle", schema: sessionFrame },
  goal_accepted: { class: "presentation", schema: anyPayload },
  input_applied: { class: "lifecycle", schema: payload({ inputId: reqString, messageId: optString }) },
  assistant_message_saved: { class: "lifecycle", schema: savedRow },
  reply_text_complete: { class: "lifecycle", schema: anyPayload },
  reply_complete: { class: "terminal", schema: anyPayload },
  posted: { class: "lifecycle", schema: anyPayload },
  text_delta: { class: "paint", schema: textFrame },
  reasoning: { class: "paint", schema: textFrame },
  worker_start: { class: "activity", schema: payload({ workerId: reqString, description: optString }) },
  tool_start: { class: "activity", schema: payload({ id: reqString, name: reqString }) },
  tool_input: { class: "activity", schema: toolFrame },
  tool_result: { class: "activity", schema: payload({ id: reqString, isError: optBool, output: optString }) },
  tool_dropped: { class: "activity", schema: payload({ id: reqString }) },
  citation: { class: "activity", schema: payload({ sources: z.array(z.unknown()) }) },
  attachments: { class: "activity", schema: payload({ attachments: z.array(z.unknown()) }) },
  document_payload: { class: "activity", schema: anyPayload },
  research_saved: { class: "activity", schema: payload({ activityId: reqString, status: z.enum(["saved", "partial", "failed"]) }) },
  research_quota: { class: "presentation", schema: anyPayload },
  research_quota_exhausted: { class: "presentation", schema: anyPayload },
  mention_unreachable: { class: "presentation", schema: anyPayload },
  queued: { class: "notice", schema: anyPayload },
  input_queued: { class: "notice", schema: anyPayload },
  notice: { class: "notice", schema: noticeFrame },
  tool_confirmation_required: { class: "interaction", schema: confirmation },
  error: { class: "terminal", schema: errorFrame },
  title_update: { class: "surface-effect", schema: sessionFrame },
  view_payload: { class: "surface-effect", schema: anyPayload },
  sub_page_created: { class: "surface-effect", schema: anyPayload },
  page_created: { class: "surface-effect", schema: payload({ pageId: reqString }) },
  comment_posted: { class: "surface-effect", schema: anyPayload },
  comment_resolved: { class: "surface-effect", schema: anyPayload },
  doc_title_update: { class: "surface-effect", schema: anyPayload },
  doc_theme_update: { class: "surface-effect", schema: anyPayload },
  brain_entry_updated: { class: "surface-effect", schema: anyPayload },
  recording_participants_updated: { class: "surface-effect", schema: payload({ recordingId: reqString }) },
};

const FOLLOW_FRAMES: Record<string, FrameSpec> = {
  ...shared,
  access_denied: { class: "terminal", schema: z.object({ code: z.literal("conversation_access_denied") }).strict() },
  turn_started: { class: "lifecycle", schema: anyPayload },
  assistant_message_saved: { class: "lifecycle", schema: anyPayload },
  snapshot: { class: "paint", schema: payload({ text: optString, reasoning: optString, assistantId: optString }) },
  activity: { class: "activity", schema: payload({ event: reqString }) },
  pins_changed: { class: "room", schema: anyPayload },
  assistant_changed: { class: "room", schema: anyPayload },
  presence: { class: "room", schema: payload({ viewers: z.array(z.unknown()).optional() }) },
  turn_completed: { class: "terminal", schema: payload({ reason: optString, stoppedByName: optString }) },
};

/** Frame names this client understands, per stream. */
export const TURN_FRAME_NAMES: Readonly<Record<TurnFrameStream, readonly string[]>> = {
  direct: Object.keys(DIRECT_FRAMES),
  follow: Object.keys(FOLLOW_FRAMES),
};

/** Surface-effect frames dispatched once to the originating presentation. */
export const SURFACE_EFFECT_FRAMES: ReadonlySet<string> = new Set(
  Object.entries(DIRECT_FRAMES).filter(([, spec]) => spec.class === "surface-effect").map(([name]) => name),
);

export type ClassifiedTurnFrame = {
  stream: TurnFrameStream;
  event: string;
  class: TurnFrameClass;
  /** The validated payload with unknown fields preserved; `{}` when ignorable. */
  payload: Record<string, unknown>;
  /** Why a frame is ignorable. */
  ignored?: "unknown" | "malformed";
};

/** Validate and classify one parsed SSE frame at the client boundary. */
export function classifyTurnFrame(stream: TurnFrameStream, event: string, data: unknown): ClassifiedTurnFrame {
  const spec = (stream === "direct" ? DIRECT_FRAMES : FOLLOW_FRAMES)[event];
  if (!spec || !Object.hasOwn(stream === "direct" ? DIRECT_FRAMES : FOLLOW_FRAMES, event)) {
    return { stream, event, class: "ignorable", payload: {}, ignored: "unknown" };
  }
  const raw = data && typeof data === "object" && !Array.isArray(data) ? data : {};
  const parsed = spec.schema.safeParse(raw);
  if (!parsed.success) return { stream, event, class: "ignorable", payload: {}, ignored: "malformed" };
  // Keep the original values: tolerant readers only decide admission, and
  // hosts read the raw fields with their own guards.
  const value = { ...(raw as Record<string, unknown>) };
  // Attachment-preparation notices carry `kind` only (server adds `code` in M2).
  if (event === "notice" && typeof value.code !== "string") value.code = value.kind;
  return { stream, event, class: spec.class, payload: value };
}

/** Frames whose arrival must flush batched paint before they apply. */
export function flushesPaint(frame: ClassifiedTurnFrame): boolean {
  return frame.class !== "paint" && frame.class !== "ignorable";
}
