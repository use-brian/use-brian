// SYNTHETIC-ONLY legacy callback contract; not production instrumentation.
export type Lane = 'llm-ax' | 'hybrid-ax' | 'vision-only';
export type Case = Readonly<{ fixture: string; lane: Lane; trial: number }>;
export type Configuration = Readonly<{ hardware: string; network: string; models: string; build: string; policy: string }>;
export type Header = Configuration & Readonly<{ type: 'header'; version: 2; manifest: string; source: 'live-attended' | 'synthetic'; os: 'macos' | 'windows' | 'linux'; trials: number; seed: number; schedule: string; calibrationFrozen: true; heldOutSealed: true; randomizedOrder: true }>;
export type Consent = Configuration & { attended: true; localConsent: true; fixtureOnly: true; signedPackaged: true };
export type Event = 'unauthorized' | 'wrongWindow' | 'postRevocationDispatch' | 'duplicateEffects' | 'privacyDefects' | 'shadowDispatches' | 'interventions' | 'screenshots' | 'imageUploads';
export type Usage = { inputTokens: number; outputTokens: number; incurredUsd: number };
export type AttemptEnd = (result: { outcome: 'ok' | 'failed' | 'partial' | 'cancelled'; usage: Usage | null }) => void;
export type AttemptStart = (meta: { kind: 'jev' | 'llm' | 'vision'; keySource: 'workspace' | 'platform' }) => AttemptEnd;
export type Fallback = 'none' | 'uncertain' | 'abstain' | 'generation' | 'timeout' | 'rate-limit' | 'invalid' | 'provider-failure' | 'ax-inadequate' | 'no-vision' | 'policy-denied' | 'budget' | 'cancelled';
export type Decision = (meta: { acceptedFast: boolean; fallback: Fallback }) => void;
export type Step = { slot: number; perception: 'ax' | 'cv' | 'none'; warmAx: boolean };
export type OracleSelection = { selection: 'correct' | 'incorrect' | 'abstain' | 'none' };
export type Completion = { evidenceComplete: true; attempts: number; actions: number };
export interface MainFixtureSession {
  consent: Consent;
  /** Frozen fixture slots, including recovery slots, not model-chosen IDs. */
  nextStep(): Promise<Step | null>;
  observe(slot: number, hooks: { event(kind: Event): void }, signal?: AbortSignal): Promise<void>;
  /** Every real provider invocation starts/ends one attempt, even if it fails.
   * Forward actual known accounting; null usage poisons the collection. */
  decide(slot: number, hooks: { beginAttempt: AttemptStart; decision: Decision; event(kind: Event): void }, signal?: AbortSignal): Promise<void>;
  dispatch(slot: number, onDelivered: () => void, signal?: AbortSignal): Promise<void>;
  verifyFreshFixtureState(slot: number, signal?: AbortSignal): Promise<void>;
  oracleSelection(slot: number): Promise<OracleSelection>;
  oracleTask(): Promise<{ success: boolean }>;
  /** Local callbacks only: Stop start at activation, end at execution gate. */
  subscribeLocalSafety(hooks: { event(kind: Event): void; beginStop(): () => void }): () => void;
  /** Reconcile ALL calls/actions and compare independent runtime counters. */
  settleAllAttemptsAndActions(): Promise<Completion>;
  /** Drain callbacks and revoke execution; cannot replay unknown actions.
   * Called once even when creation resolves after cancellation. On failure the
   * adapter initiates cleanup without awaiting a hung drain and unsubscribes. */
  closeAndDrain(): Promise<void>;
}
export interface MainCallbacks {
  /** Must enforce local consent, fixture binary allowlist, configuration,
   * session lease, epochs, policy and effect approvals in trusted main.
   * Unsupported cases throw: never return fake results or skip a fixture.
   * Honor AbortSignal during creation; the adapter also checks after awaiting
   * and closes resource-owning sessions that arrive after cancellation. */
  requireLocalFixtureSession(task: Case, header: Header, signal?: AbortSignal): Promise<MainFixtureSession>;
  /** Idempotent independent Stop. Latch the local gate synchronously, then
   * kill/clean up helper and outstanding calls. Never queue behind AX. */
  stopLocalExecutionGate(): void | Promise<void>;
}
export function createSyntheticSequentialDriver(main: MainCallbacks): {
  readonly source: 'synthetic';
  stop(): void | Promise<void>;
  open(task: Case, header: Header, signal?: AbortSignal): Promise<{
    consent: Consent;
    oracle: { selection(meta: { slot: number }): Promise<OracleSelection>; task(): Promise<{ success: boolean }> };
    run(hooks: RecorderHooks, signal?: AbortSignal): Promise<void>;
    attest(): Promise<Completion>;
    close(): Promise<void>;
  }>;
};
export interface RecorderHooks {
  beginStep(meta: Step): void;
  beginSpan(stage: 'observation' | 'decision' | 'dispatch' | 'verification'): () => void;
  beginAttempt: AttemptStart;
  decision: Decision;
  delivered(): void;
  event(kind: Event): void;
  beginStop(): () => void;
  endStep(): Promise<void>;
}
