import type { NextResponse } from "next/server";
import { portalConfig } from "./config";

const secure = process.env.NODE_ENV === "production";
const names = ["access_token", "refresh_token", "user"] as const;

function base() {
  const domain = portalConfig().cookieDomain;
  return { secure, sameSite: "lax" as const, path: "/", ...(domain ? { domain } : {}) };
}

const accessCookie = (value: string) => ({ name: "access_token", value, ...base(), httpOnly: false, maxAge: 3600 });
const refreshCookie = (value: string) => ({ name: "refresh_token", value, ...base(), httpOnly: true, maxAge: 30 * 86400 });
const userCookie = (value: string) => ({ name: "user", value, ...base(), httpOnly: false, maxAge: 30 * 86400 });

export function parseLastCookie(header: string, name: string): string | null {
  let found: string | null = null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) found = rest.join("=");
  }
  return found ? decodeURIComponent(found) : null;
}

export function clearAuthCookies(response: NextResponse): void {
  const domain = portalConfig().cookieDomain;
  for (const name of names) {
    response.headers.append("set-cookie", `${name}=; Path=/; Max-Age=0`);
    if (domain) response.headers.append("set-cookie", `${name}=; Path=/; Max-Age=0; Domain=${domain}`);
  }
}

export function installSession(response: NextResponse, data: AuthData): void {
  response.cookies.set(accessCookie(data.accessToken));
  response.cookies.set(refreshCookie(data.refreshToken));
  response.cookies.set(userCookie(JSON.stringify(data.user)));
}

export type AuthData = {
  accessToken: string;
  refreshToken: string;
  user: { id: string; name: string | null; email: string | null; avatarUrl?: string };
  nextPath?: string | null;
};
