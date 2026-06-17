/**
 * Browser-computed HMAC SHA-256 signature for the workflow webhook
 * "test request" pane (app-web).
 *
 * Ported from `apps/web/src/lib/workflow-signature.ts` (app consolidation
 * §5a). Mirrors what the backend receiver verifies in
 * `packages/api/src/routes/workflow-webhooks.ts` — the header value is
 * the literal `sha256=<hex>` produced over the raw request body.
 *
 * Pure utility — uses `crypto.subtle` (available in modern browsers and
 * Node 16+). No `Buffer` dependency, so it loads cleanly in the Next.js
 * client bundle.
 *
 * Spec: docs/architecture/features/workflow.md → Webhook UI polish.
 */

/**
 * Compute the `X-Workflow-Signature` header value for a given body and
 * secret. The result is the literal string `sha256=<lowercase-hex>`,
 * ready to drop into a `fetch()` headers map.
 */
export async function computeWebhookSignature(
  secret: string,
  body: string,
): Promise<string> {
  const hex = await hmacSha256Hex(secret, body)
  return `sha256=${hex}`
}

/**
 * Raw HMAC SHA-256 helper — returns the lowercase hex digest. Exposed so
 * tests can assert against a known fixture without re-deriving the
 * header prefix.
 */
export async function hmacSha256Hex(
  secret: string,
  message: string,
): Promise<string> {
  const enc = new TextEncoder()
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message))
  const bytes = new Uint8Array(sig)
  let hex = ""
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i].toString(16).padStart(2, "0")
  }
  return hex
}

/**
 * Render a curl snippet that posts `body` to `url` with the right
 * signature header. The body is single-quoted as one chunk — fine for
 * preview / copy-and-paste, callers that need shell-safe escaping of
 * embedded apostrophes should use the language-specific snippets.
 */
export function curlSnippet(url: string, secret: string, body: string): string {
  // Computed at copy time on the server isn't an option — secrets live
  // in the client. Use a shell sub-process so the user can re-run with
  // a fresh body without re-deriving the signature out of band.
  const escapedSecret = secret.replaceAll("'", "'\\''")
  const escapedBody = body.replaceAll("'", "'\\''")
  return [
    `BODY='${escapedBody}'`,
    `SIG=$(printf '%s' "$BODY" | openssl dgst -sha256 -hmac '${escapedSecret}' | sed 's/^.* //')`,
    `curl -X POST '${url}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H "X-Workflow-Signature: sha256=$SIG" \\`,
    `  --data-binary "$BODY"`,
  ].join("\n")
}

/**
 * Render a Node 18+ snippet using the built-in `crypto` module.
 * Targets `node:crypto` rather than the WebCrypto subtle API so it
 * works without async setup in plain Node scripts.
 */
export function nodeSnippet(url: string, _secret: string): string {
  return [
    `import { createHmac } from "node:crypto"`,
    ``,
    `const url = ${JSON.stringify(url)}`,
    `const secret = process.env.WORKFLOW_SECRET // never inline a secret in source`,
    `const body = JSON.stringify({ /* your payload */ })`,
    `const signature = createHmac("sha256", secret).update(body).digest("hex")`,
    ``,
    `const res = await fetch(url, {`,
    `  method: "POST",`,
    `  headers: {`,
    `    "Content-Type": "application/json",`,
    `    "X-Workflow-Signature": \`sha256=\${signature}\`,`,
    `  },`,
    `  body,`,
    `})`,
    `console.log(res.status, await res.text())`,
  ].join("\n")
}

/**
 * Render a Python 3 snippet using `hmac` + `requests`.
 */
export function pythonSnippet(url: string, _secret: string): string {
  return [
    `import hmac`,
    `import hashlib`,
    `import json`,
    `import os`,
    `import requests`,
    ``,
    `url = ${JSON.stringify(url)}`,
    `secret = os.environ["WORKFLOW_SECRET"].encode()  # never inline a secret`,
    `body = json.dumps({"hello": "world"}).encode()`,
    `signature = hmac.new(secret, body, hashlib.sha256).hexdigest()`,
    ``,
    `res = requests.post(`,
    `    url,`,
    `    headers={`,
    `        "Content-Type": "application/json",`,
    `        "X-Workflow-Signature": f"sha256={signature}",`,
    `    },`,
    `    data=body,`,
    `)`,
    `print(res.status_code, res.text)`,
  ].join("\n")
}
