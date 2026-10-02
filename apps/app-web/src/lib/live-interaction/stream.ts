/** WebRTC transcription only. Never owns/stops the durable recorder's tracks.
 * [COMP:app-web/live-interaction] */
import { interactionRequest, type InteractionSource, type InteractionUtterance } from "./api";

type ProviderEvent = { type: string; item_id?: string; previous_item_id?: string | null; transcript?: string; audio_start_ms?: number; audio_end_ms?: number };
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Provider finals may arrive out of order. Keep provider identities, not text hashes. */
export class UtteranceAssembler {
  private items = new Map<string, Partial<InteractionUtterance>>();
  private delivered = new Set<string>();
  private failed = new Set<string>();
  private discontinuity = false;
  markDiscontinuity() { this.discontinuity = true; }
  constructor(private source: InteractionSource, private offset: number) {}
  accept(event: ProviderEvent): InteractionUtterance[] {
    if (!event.item_id || this.delivered.has(event.item_id)) return [];
    if (event.type === "conversation.item.input_audio_transcription.failed") {
      this.items.delete(event.item_id);
      this.delivered.add(event.item_id);
      this.failed.add(event.item_id);
      this.markDiscontinuity();
      return this.flush(false);
    }
    const item = this.items.get(event.item_id) ?? { id: event.item_id, source: this.source };
    if (event.type === "input_audio_buffer.committed") item.previousId = event.previous_item_id ?? null;
    if (event.type === "input_audio_buffer.speech_started") item.startMs = this.offset + (event.audio_start_ms ?? 0);
    if (event.type === "input_audio_buffer.speech_stopped") item.endMs = this.offset + (event.audio_end_ms ?? 0);
    if (event.type === "conversation.item.input_audio_transcription.completed") item.text = event.transcript ?? "";
    this.items.set(event.item_id, item);
    return this.flush(false);
  }
  get hasPending() { return this.items.size > 0; }
  flush(force: boolean): InteractionUtterance[] {
    const result: InteractionUtterance[] = [];
    let changed = true;
    while (changed) {
      changed = false;
      for (const [id, item] of this.items) {
        if (item.text === undefined || item.startMs === undefined || item.endMs === undefined) continue;
        if (!force && (item.previousId === undefined || (item.previousId && !this.delivered.has(item.previousId)))) continue;
        if (this.discontinuity || (item.previousId && this.failed.has(item.previousId)) ||
          (force && (item.previousId === undefined || (item.previousId && !this.delivered.has(item.previousId))))) {
          item.discontinuity = true;
          this.discontinuity = false;
        }
        result.push(item as InteractionUtterance);
        this.items.delete(id); this.delivered.add(id); changed = true;
      }
    }
    return result;
  }
}

export class InteractionStream {
  private pc: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private tracks: MediaStreamTrack[] = [];
  private stopping = false;
  private retries = 0;
  private reconnecting = false;
  private paused = false;
  private delivery = Promise.resolve();
  private deliveryGap = false;
  private connectionGap = false;
  private pending = new Set<Promise<void>>();
  private assembler: UtteranceAssembler | null = null;
  private lastEvent = Date.now();
  private stopPromise?: Promise<void>;
  private connectionTimer?: ReturnType<typeof setTimeout>;
  private connectedAt = 0;
  private pauses: { start: number; end?: number }[] = [];
  constructor(private captureId: string, private source: InteractionSource, private input: MediaStream,
    private clock: () => number, private onGap: () => void,
    private onPersisted?: (utterance: InteractionUtterance) => void) {}

  async start(): Promise<void> {
    try { await this.connect(); }
    catch { if (!this.stopping) await this.reconnect(); }
  }
  private async connect(): Promise<void> {
    if (this.stopping) return;
    const token = await interactionRequest<{ value: string; expiresAt: number }>(`/${this.captureId}/token`, { source: this.source });
    if (this.stopping) return;
    const pc = new RTCPeerConnection(); this.pc = pc;
    this.assembler = new UtteranceAssembler(this.source, this.clock());
    const assembler = this.assembler;
    if (this.connectionGap || this.paused) assembler.markDiscontinuity();
    this.connectionGap = false;
    this.connectedAt = Date.now();
    this.pauses = this.paused ? [{ start: 0 }] : [];
    this.tracks = this.input.getAudioTracks().map((track) => track.clone());
    for (const track of this.tracks) {
      track.enabled = !this.paused;
      pc.addTrack(track, new MediaStream([track]));
    }
    const channel = pc.createDataChannel("oai-events"); this.channel = channel;
    channel.onopen = () => { clearTimeout(this.connectionTimer); this.retries = 0; };
    channel.onclose = () => { if (!this.stopping && this.pc === pc) void this.reconnect(); };
    this.connectionTimer = setTimeout(() => { if (this.pc === pc && channel.readyState !== "open") void this.reconnect(); }, 15_000);
    channel.onmessage = ({ data }) => {
      this.lastEvent = Date.now();
      try {
        const event = JSON.parse(data) as ProviderEvent;
        if (event.type === "error" || event.type === "conversation.item.input_audio_transcription.failed") {
          this.onGap();
          if (event.type === "error" || !event.item_id) assembler.markDiscontinuity();
        }
        // Provider time includes muted pause intervals; recorder time does not.
        const adjust = (ms: number) => Math.max(0, Math.round(ms - this.pauses.reduce((sum, pause) => sum + Math.max(0, Math.min(ms, pause.end ?? ms) - pause.start), 0)));
        if (event.audio_start_ms !== undefined) event.audio_start_ms = adjust(event.audio_start_ms);
        if (event.audio_end_ms !== undefined) event.audio_end_ms = adjust(event.audio_end_ms);
        for (const utterance of assembler.accept(event)) this.deliver(utterance);
      } catch { assembler.markDiscontinuity(); this.onGap(); }
    };
    pc.onconnectionstatechange = () => {
      if (["failed", "disconnected"].includes(pc.connectionState)) void this.reconnect();
    };
    try {
      const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
      const response = await fetch("https://api.openai.com/v1/realtime/calls", {
        method: "POST", headers: { Authorization: `Bearer ${token.value}`, "Content-Type": "application/sdp" },
        body: offer.sdp, signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`ASR ${response.status}`);
      const sdp = await response.text();
      if (!this.stopping && this.pc === pc) await pc.setRemoteDescription({ type: "answer", sdp });
    } catch (error) { if (this.pc === pc) this.close(); throw error; }
  }
  private deliver(utterance: InteractionUtterance) {
    if (this.pending.size >= 100) { this.assembler?.markDiscontinuity(); this.onGap(); return; }
    // Idempotent retries retain provider item_id and source and predecessor.
    const send = async () => {
      if (this.deliveryGap) { utterance.discontinuity = true; this.deliveryGap = false; }
      for (let attempt = 0; attempt < 3; attempt++) {
        try { await interactionRequest(`/${this.captureId}/utterances`, utterance); this.onPersisted?.(utterance); return; }
        catch { if (attempt === 2) { this.deliveryGap = true; this.onGap(); return; } await wait(500 * (attempt + 1)); }
      }
    };
    // Preserve microphone utterance order even when HTTP requests/retries differ
    // in latency. The system source has its own independent delivery lane.
    const task = this.delivery.then(send); this.delivery = task; this.pending.add(task);
    void task.finally(() => this.pending.delete(task));
  }
  private async reconnect() {
    if (this.stopping || this.reconnecting) return;
    this.reconnecting = true; this.onGap();
    for (const item of this.assembler?.flush(true) ?? []) this.deliver(item);
    if (this.assembler?.hasPending) this.onGap();
    this.close();
    this.connectionGap = true;
    while (!this.stopping && this.retries < 3) {
      await wait(1000 * ++this.retries);
      try { await this.connect(); break; } catch { this.onGap(); }
    }
    this.reconnecting = false;
  }
  setPaused(paused: boolean) {
    if (paused === this.paused) return;
    const at = Math.max(0, Date.now() - this.connectedAt);
    if (paused) this.pauses.push({ start: at });
    else if (this.pauses.length) this.pauses[this.pauses.length - 1].end = at;
    this.paused = paused;
    this.assembler?.markDiscontinuity();
    for (const track of this.tracks) track.enabled = !paused;
  }
  private close() {
    clearTimeout(this.connectionTimer);
    this.pc && (this.pc.onconnectionstatechange = null);
    this.tracks.forEach((track) => track.stop()); this.tracks = [];
    if (this.channel) { this.channel.onmessage = null; this.channel.onopen = null; this.channel.onclose = null; }
    this.channel?.close(); this.channel = null; this.pc?.close(); this.pc = null;
  }
  stop(): Promise<void> {
    return this.stopPromise ??= this.drain();
  }
  private async drain() {
    this.stopping = true;
    // Keep the channel alive through server VAD (500ms) and final transcription.
    this.tracks.forEach((track) => { track.enabled = false; });
    const started = Date.now();
    do { await wait(250); } while (Date.now() - started < 2000 || ((this.assembler?.hasPending || Date.now() - this.lastEvent < 1500) && Date.now() - started < 8000));
    for (const item of this.assembler?.flush(true) ?? []) this.deliver(item);
    if (this.assembler?.hasPending) this.onGap();
    this.close();
    await Promise.all([...this.pending]);
  }
}
