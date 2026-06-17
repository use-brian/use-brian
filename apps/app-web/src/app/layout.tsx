import type { Metadata } from "next";
import { JetBrains_Mono } from "next/font/google";
import { ThemeProvider, THEME_PREPAINT_SCRIPT } from "@/lib/theme";
import { I18nProvider } from "@/lib/i18n/client";
import { getServerDictionary } from "@/lib/i18n/server";
import { ConfirmDialogProvider } from "@/components/ui/confirm-dialog";
import { PromptDialogProvider } from "@/components/ui/prompt-dialog";
import { KindPickerDialogProvider } from "@/components/ui/kind-picker-dialog";
import { RouteProgress } from "@/components/route-progress";
import "./globals.css";

// Mirror apps/web's font system: `--font-rocknroll` is a CSS variable
// pointing at a system Chinese-friendly sans stack (PingFang TC, Noto
// Sans TC). The variable lives in globals.css; no Google Font is loaded
// for the body face anymore — RocknRoll_One looked playful but didn't
// match the main app surface. Mono stays JetBrains_Mono for code.
const jetbrainsMono = JetBrains_Mono({
  variable: "--font-jetbrains-mono",
  subsets: ["latin"],
});

const APP_DESCRIPTION =
  "Your company brain: tasks, CRM, knowledge, and workflows in one AI workspace.";

export const metadata: Metadata = {
  metadataBase: new URL("https://app.sidan.ai"),
  // sidanclaw is the whole authenticated app; "Doc" is just its default tab
  // (alongside Brain, Studio, Workflow, …), so the app-level title/brand is
  // "sidanclaw" — not "Doc by sidanclaw". A page with its own title renders as
  // "<page> · sidanclaw" via the template.
  title: {
    default: "sidanclaw",
    template: "%s · sidanclaw",
  },
  description: APP_DESCRIPTION,
  applicationName: "sidanclaw",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32.png", type: "image/png", sizes: "32x32" },
      { url: "/icon-192.png", type: "image/png", sizes: "192x192" },
      { url: "/icon.png", type: "image/png", sizes: "512x512" },
    ],
    apple: "/apple-touch-icon.png",
  },
  manifest: "/site.webmanifest",
  openGraph: {
    type: "website",
    siteName: "sidanclaw",
    title: "sidanclaw",
    description: APP_DESCRIPTION,
    url: "/",
    images: [{ url: "/icon.png", width: 512, height: 512, alt: "sidanclaw" }],
  },
  twitter: {
    card: "summary",
    title: "sidanclaw",
    description: APP_DESCRIPTION,
    images: ["/icon.png"],
  },
  robots: {
    // Authenticated app — no public content. Discourage indexing across the board.
    index: false,
    follow: false,
  },
  other: {
    "color-scheme": "light dark",
  },
};

// Tag <html> before first paint when we're running inside the Electron desktop
// shell (apps/app-desktop), whose preload exposes `window.sidanclawDesktop`
// BEFORE any page script runs. The `is-canvas-desktop` class gates desktop-only
// chrome in globals.css (a draggable title-bar strip that clears the macOS
// traffic lights + non-selectable app chrome) and is a no-op in the browser.
// On Windows (`platform === "win32"`) the window keeps a standard OS frame with
// no traffic lights, so `is-canvas-desktop-win` zeroes the title-bar inset.
// Same run-before-paint, no-flash shape as THEME_PREPAINT_SCRIPT; no user input.
const DESKTOP_SHELL_PREPAINT_SCRIPT = `(()=>{try{var d=window.sidanclawDesktop;if(!d)return;var c=document.documentElement.classList;c.add("is-canvas-desktop");if(d.platform==="win32")c.add("is-canvas-desktop-win");}catch(e){}})();`;

// Theme is user-switchable. THEME_PREPAINT_SCRIPT (a constant we ship,
// no user input) runs before paint to read the saved choice from
// localStorage and stamp the `dark` class onto <html>, avoiding a
// light-mode flash for users who previously picked dark.
export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const { locale, dict } = await getServerDictionary();
  return (
    <html
      lang={locale}
      className={`${jetbrainsMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <head>
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: DESKTOP_SHELL_PREPAINT_SCRIPT }}
        />
        <script
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: THEME_PREPAINT_SCRIPT }}
        />
      </head>
      <body className="min-h-full flex flex-col">
        {/* Global navigation progress bar — the desktop shell has no browser
            chrome, so this is the only "navigation in flight" signal on a click
            that triggers a route transition. Mounted here so it spans every
            surface. See docs/architecture/features/doc.md → "Navigation progress". */}
        <RouteProgress />
        <I18nProvider locale={locale} dict={dict}>
          <ThemeProvider>{children}</ThemeProvider>
          <ConfirmDialogProvider />
          <PromptDialogProvider />
          <KindPickerDialogProvider />
        </I18nProvider>
      </body>
    </html>
  );
}
