import type { PassiveObserverHealth, PassiveObserverReason } from '../../packages/computer-control/src/passive-observer.js';
import type { NativeBrokerTraceEvent } from '../../packages/computer-control/src/broker-trace.js';
import type { HelperTimingEvent } from '../../packages/computer-control/src/helper-timing.js';
import type { NativeTraceEvent } from '../../packages/core/src/computer-use/trace.js';
/** Same trusted metadata-only binding as API NativeRunObserverFactory. */
export type ObserverBinding = Readonly<{ sessionId: string; epoch: number }>;
export type SourceObserver = (event: NativeTraceEvent) => void;
export type ObserverFactory = (binding: ObserverBinding) => SourceObserver | undefined;
export type HelperObserverFactory = (channelId: string) => Readonly<{
  enabled: true;
  onMetadata(event: HelperTimingEvent): void;
}> | undefined;
export interface PassiveHelperHost {
  /** Registration only for the existing authorized helper client. Pass returned
   * options to its trusted constructor composition; never spawn/execute here.
   * channelId is a main-owned UUID identifying one helper-client lifetime. */
  attachHelperObserver(binding: ObserverBinding, factory: HelperObserverFactory, signal?: AbortSignal): Promise<{
    detach(): void | Promise<void>;
    /** Optional legacy port; trusted synchronous fixed metadata, diagnostics only. */
    health?(): PassiveObserverHealth;
  }>;
}
export type BrokerObserverFactory = (binding: ObserverBinding) => (event: NativeBrokerTraceEvent) => void;
export interface PassiveBrokerHost {
  /** Register the actual default-off desktop broker factory, never run a task. */
  attachBrokerObserver(binding: ObserverBinding, factory: BrokerObserverFactory, signal?: AbortSignal): Promise<{ detach(): void | Promise<void> }>;
}
export interface PassiveHelperTimingHost {
  /** Register NativeIntegrationOptions.helperTimingObserver; original scope is
   * retained on late callbacks. No helper execution/rebinding is permitted. */
  attachHelperTimingObserver(binding: ObserverBinding, observer: (event: HelperTimingEvent) => void, signal?: AbortSignal): Promise<{ detach(): void | Promise<void> }>;
}
export interface PassiveOptions {
  binding: ObserverBinding;
  /** The ONLY execution-affecting port; independent, idempotent local Stop. */
  stopLocalExecutionGate(): void | Promise<void>;
}
export interface PassiveHost {
  /** Register the observer for an already authorized API-owned run. MUST NOT
   * invoke a tool, rerun a goal, create a planner, grant authority, or approve an
   * effect. The API invokes factory after its durable session/epoch claim. */
  attachObserver(binding: ObserverBinding, factory: ObserverFactory, signal?: AbortSignal): Promise<{
    /** Observer unsubscribe only; never a provider/helper/fixture drain claim. */
    detach(): void | Promise<void>;
    /** Optional legacy port; trusted synchronous fixed metadata, diagnostics only. */
    health?(): PassiveObserverHealth;
  }>;
}
export interface SourceDiagnostics {
  readonly type: 'source-diagnostics';
  readonly state: 'incomplete' | 'poisoned';
  readonly publicationAllowed: false;
  readonly routingProfileApproval: false;
  readonly releaseStatus: 'pending';
  readonly drain: 'not_observed';
  readonly fixtureSuccess: null;
  readonly attachmentHealth: readonly Readonly<{ kind: 'api' | 'broker' | 'helper'; state: 'incomplete'; status: 'observed' | 'unknown'; reason: PassiveObserverReason | null; drain: 'not_observed' }>[];
  readonly streams: readonly unknown[];
  readonly broker: Readonly<{ state: 'incomplete' | 'poisoned'; publicationAllowed: false; commands: readonly unknown[] }>;
  readonly axSuccess: null;
  readonly warmAxGateEvidence: 'unavailable';
  readonly helperTiming: Readonly<{ state: 'incomplete' | 'poisoned'; publicationAllowed: false; rows: readonly unknown[] }>;
}
export function createPassiveObserverAdapter(options: PassiveOptions): {
  readonly observerFactory: ObserverFactory;
  readonly helperObserverFactory: HelperObserverFactory;
  readonly brokerObserverFactory: BrokerObserverFactory;
  readonly helperTimingObserver: (event: HelperTimingEvent) => void;
  attach(host: PassiveHost, signal?: AbortSignal): Promise<void>;
  attachHelper(host: PassiveHelperHost | PassiveHelperTimingHost, signal?: AbortSignal): Promise<void>;
  attachBroker(host: PassiveBrokerHost, signal?: AbortSignal): Promise<void>;
  detach(): void;
  stop(): void;
  invalidate(reason: 'safety-defect' | 'observer-failed' | 'cancelled'): false;
  diagnostics(): SourceDiagnostics;
  assertPublishable(): never;
};
