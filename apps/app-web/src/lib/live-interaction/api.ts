import { authFetch } from "@/lib/auth-fetch";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
// Consume the source contract until the shared package publishes this subpath.
export type { InteractionCapture, InteractionJob, InteractionSource } from "../../../../../packages/shared/src/live-interaction";
export { DEFAULT_INTERACTION_RULE } from "../../../../../packages/shared/src/live-interaction";

import type { InteractionUtterance as SharedInteractionUtterance } from "../../../../../packages/shared/src/live-interaction";
export type InteractionUtterance = SharedInteractionUtterance & { discontinuity?: boolean };

export class InteractionRequestError extends Error {
  constructor(public status: number) { super(`Interaction ${status}`); }
}

export async function interactionRequest<T>(path: string, body?: unknown, method = body === undefined ? "GET" : "POST"): Promise<T> {
  const response = await authFetch(`${publicRuntimeConfig().apiUrl ?? "http://localhost:4000"}/api/recordings/interaction${path}`, {
    method, headers: { "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new InteractionRequestError(response.status);
  return response.json() as Promise<T>;
}
