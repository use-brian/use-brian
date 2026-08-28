import type { Metadata } from "next";
import "./globals.css";
import { I18nProvider } from "@/lib/i18n/client";
import { serverI18n } from "@/lib/i18n/server";

export const metadata: Metadata = { title: "Use Brian", robots: { index: false, follow: false } };

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const { locale, dictionary } = await serverI18n();
  return <html lang={locale}><body><I18nProvider dictionary={dictionary}>{children}</I18nProvider></body></html>;
}
