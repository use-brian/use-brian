/**
 * Pure helpers for the custom-connector "Preflight headers" editor.
 *
 * Preflight headers are non-secret operational HTTP headers (tenant, tracing,
 * routing) persisted to `connector_instance.config.preflightHeaders` and merged
 * over the connector's auth headers at injection time (server-side
 * `preflightHeadersToRecord` + `mergeValidatedHeaders`). This module mirrors the
 * server's RFC 7230 / no-CRLF validation so the user gets an inline error
 * instead of a header that is silently dropped at inject time.
 *
 * Spec: docs/architecture/engine/tool-hooks.md → "Config later" / "Header merge".
 * Component tag: [COMP:app-web/connector-preflight-headers].
 */

import { isValidHeaderName } from "./connector-auth-form";

export type PreflightHeaderRow = { name: string; value: string };

export type PreflightHeadersError = "invalidName" | "emptyValue" | "duplicateName";

export type BuildPreflightResult =
  | { ok: true; payload: PreflightHeaderRow[] }
  | { ok: false; error: PreflightHeadersError; index: number };

const MAX_VALUE_LENGTH = 8192;

/**
 * Validate + normalize the editor rows into the array persisted to
 * `config.preflightHeaders`. Blank rows (no name AND no value) are dropped; a
 * named row needs a non-empty, single-line value. Duplicate names are rejected
 * case-insensitively (HTTP header names are case-insensitive, and the server
 * merge would otherwise collapse them). The name is trimmed; the value is kept
 * verbatim (leading/trailing spaces can be significant).
 */
export function buildPreflightHeadersPayload(rows: PreflightHeaderRow[]): BuildPreflightResult {
  const payload: PreflightHeaderRow[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < rows.length; i++) {
    const name = rows[i].name.trim();
    const value = rows[i].value;

    if (name.length === 0 && value.trim().length === 0) continue; // incomplete row → skip

    if (!isValidHeaderName(name)) return { ok: false, error: "invalidName", index: i };
    if (value.length === 0 || /[\r\n]/.test(value) || value.length > MAX_VALUE_LENGTH) {
      return { ok: false, error: "emptyValue", index: i };
    }

    const lower = name.toLowerCase();
    if (seen.has(lower)) return { ok: false, error: "duplicateName", index: i };
    seen.add(lower);

    payload.push({ name, value });
  }

  return { ok: true, payload };
}

/** Read stored preflight-header rows out of a connector's config blob, tolerant of junk. */
export function readPreflightHeaders(
  config: Record<string, unknown> | null | undefined,
): PreflightHeaderRow[] {
  const raw = config?.preflightHeaders;
  if (!Array.isArray(raw)) return [];
  const out: PreflightHeaderRow[] = [];
  for (const row of raw) {
    if (
      row && typeof row === "object" &&
      typeof (row as PreflightHeaderRow).name === "string" &&
      typeof (row as PreflightHeaderRow).value === "string"
    ) {
      out.push({ name: (row as PreflightHeaderRow).name, value: (row as PreflightHeaderRow).value });
    }
  }
  return out;
}
