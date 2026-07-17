/**
 * Custom-connector auth form logic — pure, page-free, unit-testable.
 *
 * Maps the Studio → Connectors add/edit form state to the POST/PATCH
 * /api/connectors/custom payload, mirroring the server contract
 * (docs/architecture/integrations/mcp.md → "Custom connector auth"):
 *
 * - Add mode (`current = null`): every auth type except `none` requires
 *   its secret fields.
 * - Edit mode: blank secret fields KEEP the stored secret when the auth
 *   type (and, for `custom_header`, the header name) is unchanged;
 *   changing either requires re-entering the secret.
 * - Header names are validated client-side against the same RFC 7230
 *   token rule the API enforces.
 *
 * Component tag: [COMP:app-web/connector-auth-form].
 */

import type { ConnectorAuthType } from "@sidanclaw/shared/builtin-connectors";

export type CustomConnectorForm = {
  name: string;
  url: string;
  authType: ConnectorAuthType;
  oauthClientId: string;
  oauthClientSecret: string;
  bearerToken: string;
  headerName: string;
  headerValue: string;
};

/** The stored row's auth state; null = add mode. */
export type CurrentConnectorAuth = {
  authType: ConnectorAuthType;
  authHeaderName?: string;
} | null;

export type ConnectorAuthFormError = "secretRequired" | "invalidHeaderName";

export type BuildPayloadResult =
  | { ok: true; payload: Record<string, string> }
  | { ok: false; error: ConnectorAuthFormError };

/** Same RFC 7230 token rule the API enforces (mcp/auth-headers.ts). */
const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export function isValidHeaderName(name: string): boolean {
  return name.length > 0 && name.length <= 128 && HEADER_NAME_RE.test(name);
}

export function buildCustomConnectorPayload(
  form: CustomConnectorForm,
  current: CurrentConnectorAuth,
): BuildPayloadResult {
  const base: Record<string, string> = {
    name: form.name.trim(),
    url: form.url.trim(),
    authType: form.authType,
  };

  switch (form.authType) {
    case "none":
      return { ok: true, payload: base };

    case "oauth": {
      const id = form.oauthClientId.trim();
      const secret = form.oauthClientSecret.trim();
      if (id && secret) {
        return { ok: true, payload: { ...base, oauthClientId: id, oauthClientSecret: secret } };
      }
      if (current?.authType === "oauth" && !id && !secret) {
        return { ok: true, payload: base };
      }
      return { ok: false, error: "secretRequired" };
    }

    case "bearer": {
      const token = form.bearerToken.trim();
      if (token) {
        return { ok: true, payload: { ...base, bearerToken: token } };
      }
      if (current?.authType === "bearer") {
        return { ok: true, payload: base };
      }
      return { ok: false, error: "secretRequired" };
    }

    case "custom_header": {
      const headerName = form.headerName.trim();
      const headerValue = form.headerValue.trim();
      if (headerName && !isValidHeaderName(headerName)) {
        return { ok: false, error: "invalidHeaderName" };
      }
      if (headerName && headerValue) {
        return { ok: true, payload: { ...base, headerName, headerValue } };
      }
      // Keep-secret: type unchanged AND the header name unchanged (or
      // omitted). A renamed header without its value must re-enter it.
      if (
        current?.authType === "custom_header" &&
        !headerValue &&
        (!headerName || headerName === current.authHeaderName)
      ) {
        return { ok: true, payload: headerName ? { ...base, headerName } : base };
      }
      return { ok: false, error: "secretRequired" };
    }

    // `gcs` / `s3` (and any future first-party storage credential kind) are not
    // custom-MCP auth schemes — they have their own connect forms and never
    // reach here.
    default:
      return { ok: false, error: "secretRequired" };
  }
}
