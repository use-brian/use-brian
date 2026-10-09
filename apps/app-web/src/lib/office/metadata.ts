/** Browser-only read lifetime, never part of an Office command/snapshot schema.
 * [COMP:app-web/office-surface-cache] */
const lifetime = Symbol('office-metadata-lifetime');
type Deadline = { wall: number; monotonic: number; viewerId: string; requestDurationMs: number };
export type OfficeMetadata<T extends object> = T & { readonly [lifetime]: Deadline };

export function attachOfficeMetadata<T extends object>(value: T, validForMs: number, started: number, viewerId: string): OfficeMetadata<T> {
  const now = performance.now();
  const requestDurationMs = now - started;
  const remaining = Math.min(validForMs, 30_000) - requestDurationMs;
  if (!Number.isFinite(validForMs) || !viewerId || !value || typeof value !== 'object' || !Number.isFinite(remaining) || remaining <= 0 || requestDurationMs < 0) throw new Error('office_projection_expired');
  Object.defineProperty(value, lifetime, {value: {wall: Date.now() + remaining, monotonic: now + remaining, viewerId, requestDurationMs}});
  return value as OfficeMetadata<T>;
}

/** Check both clocks so wall-clock rollback and delayed timers cannot extend access. */
export function officeMetadataRemaining(value: unknown, viewerId?: string): number {
  const deadline = value && typeof value === 'object' ? (value as OfficeMetadata<object>)[lifetime] : undefined;
  if (!deadline || (viewerId !== undefined && deadline.viewerId !== viewerId)) return 0;
  const remaining = Math.min(deadline.wall - Date.now(), deadline.monotonic - performance.now());
  return Number.isFinite(remaining) ? Math.max(0, remaining) : 0;
}

/** Renew early enough for the preceding complete read, without changing its deadline. */
export function officeMetadataRenewalDelay(value: unknown, viewerId: string): number {
  const remaining = officeMetadataRemaining(value, viewerId);
  const deadline = value && typeof value === 'object' ? (value as OfficeMetadata<object>)[lifetime] : undefined;
  if (!deadline || remaining <= 0) return 0;
  return Math.max(500, remaining - Math.max(remaining / 2, deadline.requestDurationMs * 1.25));
}


/** A derived view inherits the exact deadline; copying data cannot renew access. */
export function inheritOfficeMetadata<T extends object>(value: T, source: unknown, viewerId: string): OfficeMetadata<T> {
  if (officeMetadataRemaining(source, viewerId) <= 0) throw new Error('office_projection_expired');
  const deadline = (source as OfficeMetadata<object>)[lifetime];
  Object.defineProperty(value, lifetime, {value: deadline});
  return value as OfficeMetadata<T>;
}
