/** Feed's display-only fold of the shared chat protocol. [COMP:app-web/feed-chat-stream] */
import type { Message, ToolUsed, PendingConfirmation } from "@use-brian/chat-ui";
import { appendReasoning, appendStep, EMPTY_LOG, removeToolSteps, updateStepText, type EventLog } from "./build-events";
import { describeToolFromInput, type NarrationDict } from "./tool-narration";
import { extractMessageText, parseMessageAttachments, extractToolUses, extractPresentedDocuments, parsePresentedDocumentPayload, type DocSessionMessage } from "./api/sessions";
import { coalesceAssistantRunMessages } from "@/components/chat-app/chat-transcript";

export type FeedChatTurn = {
  text: string;
  visibleText: string;
  replyPhase: "generating" | "saving" | "finishing";
  reasoning: string;
  resetAnswer: boolean;
  log: EventLog;
  tools: ToolUsed[];
  workers: Record<string, string>;
  toolStarts: Record<string, number>;
  startedAt: number;
  sequence: number;
  messageId?: string;
  researchPhase: "detected" | "starting" | "parallel" | null;
  citations: NonNullable<Message["citations"]>;
  fileAttachments: NonNullable<Message["fileAttachments"]>;
  documents: NonNullable<Message["documents"]>;
};

export function newFeedChatTurn(now = Date.now()): FeedChatTurn {
  return { text: "", visibleText: "", replyPhase: "generating", reasoning: "", resetAnswer: false, log: EMPTY_LOG,
    tools: [], workers: {}, toolStarts: {}, startedAt: now, sequence: 0,
    researchPhase: null, citations: [], fileAttachments: [], documents: [] };
}
export function feedEventPayload(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? data as Record<string, unknown> : {};
}
const str = (value: unknown): string => typeof value === "string" ? value : "";

export function foldFeedChatEvent(previous: FeedChatTurn, event: string, data: Record<string, unknown>, dict: NarrationDict, now = Date.now()): FeedChatTurn {
  const next = { ...previous };
  const mint = () => `feed-event-${++next.sequence}`;
  const id = str(data.id);
  switch (event) {
    case "text_delta":
      next.replyPhase = "generating";
      next.text = (next.resetAnswer ? "" : next.text) + str(data.text);
      next.visibleText = next.text;
      next.resetAnswer = false;
      break;
    case "snapshot":
      if (data.replyPhase === "generating" || data.replyPhase === "saving" || data.replyPhase === "finishing") next.replyPhase = data.replyPhase;
      // The relay sends snapshots, never deltas. Repeated frames must not duplicate text.
      if (typeof data.text === "string") next.text = next.visibleText = data.text;
      next.resetAnswer = false;
      if (typeof data.reasoning === "string") {
        next.reasoning = data.reasoning;
        next.log = appendReasoning(next.log, next.reasoning, mint);
      }
      break;
    case "reasoning":
      next.reasoning += str(data.text);
      next.log = appendReasoning(next.log, next.reasoning, mint);
      break;
    case "worker_start": {
      const workerId = str(data.workerId), description = str(data.description);
      if (workerId && description) {
        next.workers = { ...next.workers, [workerId]: description };
        next.tools = next.tools.map(tool => tool.workerId === workerId ? { ...tool, workerDescription: description } : tool);
      }
      break;
    }
    case "tool_start": {
      next.replyPhase = "generating";
      const name = str(data.name);
      if (!id || !name || next.tools.some(tool => tool.id === id)) break;
      const narration = describeToolFromInput(name, {}, dict);
      const workerId = str(data.workerId) || undefined;
      next.tools = [...next.tools, { id, name, status: "running", ...narration, workerId, workerDescription: workerId ? next.workers[workerId] : undefined }];
      next.toolStarts = { ...next.toolStarts, [id]: now };
      next.log = appendStep(next.log, narration.description, mint, { toolId: id });
      next.reasoning = "";
      next.resetAnswer = true;
      next.visibleText = "";
      break;
    }
    case "tool_input": {
      // A reconnect may first observe input/result, after missing tool_start.
      const seeded = next.tools.some(tool => tool.id === id) ? next : foldFeedChatEvent(next, "tool_start", data, dict, now);
      const name = str(data.name) || seeded.tools.find(tool => tool.id === id)?.name;
      if (!id || !name) break;
      const narration = describeToolFromInput(name, feedEventPayload(data.input), dict);
      return { ...seeded, tools: seeded.tools.map(tool => tool.id === id ? { ...tool, ...narration } : tool), log: updateStepText(seeded.log, id, narration.description, narration.url) };
    }
    case "tool_result":
      next.tools = next.tools.map(tool => tool.id === id ? { ...tool, status: data.isError === true ? "retried" : "done",
        durationMs: next.toolStarts[id] == null ? undefined : Math.max(0, now - next.toolStarts[id]),
        errorMessage: str(data.errorMessage) || undefined } : tool);
      break;
    case "tool_dropped":
      next.tools = next.tools.filter(tool => tool.id !== id);
      next.log = removeToolSteps(next.log, id);
      break;
    case "status":
      if (data.phase === "research_detected") next.researchPhase = "detected";
      if (data.phase === "research_starting") next.researchPhase = "starting";
      if (data.phase === "research_parallel") next.researchPhase = "parallel";
      break;
    case "reply_text_complete":
      if (next.replyPhase === "generating") next.replyPhase = "saving";
      break;
    case "assistant_message_saved":
      if (id) next.replyPhase = "finishing";
      next.messageId = id || next.messageId;
      break;
    case "citation":
      for (const source of Array.isArray(data.sources) ? data.sources : []) {
        const item = feedEventPayload(source);
        if (str(item.url) && str(item.title) && !next.citations.some(c => c.url === item.url)) {
          next.citations = [...next.citations, { url: str(item.url), title: str(item.title) }];
        }
      }
      break;
    case "attachments":
      for (const file of Array.isArray(data.attachments) ? data.attachments : []) {
        const item = feedEventPayload(file);
        if (!["fileId", "workspaceId", "path", "name", "mime"].every(key => typeof item[key] === "string") || typeof item.sizeBytes !== "number") continue;
        const attachment = item as unknown as FeedChatTurn["fileAttachments"][number];
        next.fileAttachments = [...next.fileAttachments.filter(f => f.fileId !== attachment.fileId), attachment];
      }
      break;
    case "document_payload": {
      const document = parsePresentedDocumentPayload(data);
      if (document) next.documents = [...next.documents.filter(d => d.id !== document.id), document];
      break;
    }
  }
  return next;
}

export function feedTurnMessage(turn: FeedChatTurn, now = Date.now()): Message | null {
  if (!turn.text.trim() && !turn.tools.length && !turn.documents.length && !turn.fileAttachments.length && !turn.citations.length) return null;
  return { id: turn.messageId ?? `assistant-${turn.startedAt}`, role: "assistant", text: turn.text,
    timestamp: new Date(now), toolsUsed: turn.tools, citations: turn.citations,
    fileAttachments: turn.fileAttachments, documents: turn.documents, activityDurationMs: Math.max(0, now - turn.startedAt) };
}

export function feedConfirmation(data: Record<string, unknown>, sessionId: string): PendingConfirmation | null {
  const toolCallId = str(data.toolCallId);
  if (!toolCallId || !sessionId) return null;
  return { toolCallId, sessionId, allowPersistentApproval: data.allowPersistentApproval === true, approvalId: str(data.approvalId) || undefined,
    toolName: str(data.toolName), displayName: str(data.displayName) || undefined,
    input: feedEventPayload(data.input), description: str(data.description) || undefined,
    displayLines: Array.isArray(data.displayLines) ? data.displayLines.filter((line): line is string => typeof line === "string") : undefined, status: "pending" };
}

export function mapFeedTranscript(rows: DocSessionMessage[], dict: NarrationDict): Message[] {
  return coalesceAssistantRunMessages(rows.filter(row => row.role === "user" || row.role === "assistant").map(row => ({
    id: row.id, role: row.role as "user" | "assistant", text: extractMessageText(row.content), timestamp: new Date(row.timestamp),
    senderAssistantId: row.senderAssistantId,
    ...(row.replyToText ? { replyTo: { text: row.replyToText } } : {}),
    attachments: row.role === "user" ? parseMessageAttachments(row.content).attachments.map(file => ({ id: file.id, fileName: file.name, mimeType: file.mime, localPreviewUrl: file.dataUrl })) : [],
    toolsUsed: row.role === "assistant" ? extractToolUses(row.content).map(tool => ({ id: tool.id, name: tool.name, status: "done" as const, ...describeToolFromInput(tool.name, tool.input, dict) })) : [],
    documents: extractPresentedDocuments(row.content), fileAttachments: row.attachments,
  })).filter(row => row.text.trim() || row.toolsUsed.length || row.documents.length || row.attachments.length || row.fileAttachments?.length));
}
