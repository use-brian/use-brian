"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import {
  LOCALE_COOKIE,
  LOCALE_COOKIE_MAX_AGE,
  isLocale,
  type Locale,
} from "./config";

/**
 * Server Action — set the user's locale cookie and revalidate the
 * current page so the next render uses the new dictionary.
 *
 * The locale switcher invokes this from a `<form action>`, so we get
 * full SSR coverage even with JS disabled. After the action returns,
 * the calling component refreshes.
 */
export async function setLocaleAction(formData: FormData): Promise<void> {
  const next = formData.get("locale");
  if (typeof next !== "string" || !isLocale(next)) return;
  await writeLocaleCookie(next);
  const path = formData.get("path");
  revalidatePath(typeof path === "string" && path.startsWith("/") ? path : "/");
}

async function writeLocaleCookie(locale: Locale): Promise<void> {
  const store = await cookies();
  store.set(LOCALE_COOKIE, locale, {
    path: "/",
    maxAge: LOCALE_COOKIE_MAX_AGE,
    sameSite: "lax",
  });
}
