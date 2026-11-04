import { isLocale } from "@/lib/i18n/config";
/** Device-local locale changes update the mounted desktop tree without losing auth progress. */
export async function setLocaleAction(formData: FormData): Promise<void> {
  const locale = formData.get("locale");
  if (typeof locale !== "string" || !isLocale(locale)) return;
  try { localStorage.setItem("doc:locale", locale); } catch { /* The mounted preference still applies. */ }
  window.dispatchEvent(new CustomEvent("brian:locale", { detail: locale }));
}
