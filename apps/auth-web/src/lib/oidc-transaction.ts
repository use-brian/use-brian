import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export const OIDC_TRANSACTION_COOKIE = "brian_oidc_tx";
export const OIDC_TRANSACTION_MAX_AGE = 600;

export type OidcTransaction = {
  state: string;
  nonce: string;
  verifier: string;
  createdAt: number;
  next?: string;
};

export function randomBase64Url(bytes = 32): string {
  return randomBytes(bytes).toString("base64url");
}

function signature(payload: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(payload).digest();
}

export function serializeOidcTransaction(transaction: OidcTransaction, secret: string): string {
  const payload = Buffer.from(JSON.stringify(transaction)).toString("base64url");
  return `${payload}.${signature(payload, secret).toString("base64url")}`;
}

export function parseOidcTransaction(
  raw: string | null | undefined,
  secret: string,
  now = Date.now(),
): OidcTransaction | null {
  if (!raw || raw.length > 4096) return null;
  const [payload, supplied, extra] = raw.split(".");
  if (!payload || !supplied || extra) return null;
  let suppliedSignature: Buffer;
  try {
    suppliedSignature = Buffer.from(supplied, "base64url");
  } catch {
    return null;
  }
  const expected = signature(payload, secret);
  if (suppliedSignature.length !== expected.length || !timingSafeEqual(suppliedSignature, expected)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Partial<OidcTransaction>;
    if (
      typeof value.state !== "string" || value.state.length < 32 || value.state.length > 128 ||
      typeof value.nonce !== "string" || value.nonce.length < 32 || value.nonce.length > 128 ||
      typeof value.verifier !== "string" || value.verifier.length < 43 || value.verifier.length > 128 ||
      typeof value.createdAt !== "number" || value.createdAt > now + 30_000 || now - value.createdAt > OIDC_TRANSACTION_MAX_AGE * 1000 ||
      (value.next !== undefined && (typeof value.next !== "string" || value.next.length > 2048))
    ) return null;
    return value as OidcTransaction;
  } catch {
    return null;
  }
}

export function equalState(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
