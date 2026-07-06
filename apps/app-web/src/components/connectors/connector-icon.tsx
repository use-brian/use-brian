/**
 * Connector icon set (app-web).
 *
 * Originally ported from the pre-consolidation `apps/web` copy (app
 * consolidation §9 #5), now the single home for the set — `apps/web` is
 * marketing-only and no longer carries this component. No app-local imports.
 * Used by Studio -> Assistants -> Tools (assistant-scoped connectors list) and
 * Studio -> Events (ingest sources, keyed on the source's `provider`).
 *
 * Official connector icons are inlined SVGs (brand colors, consistent size).
 * Community / custom connectors fall back to their `icon_url` or a plug glyph.
 *
 * Adding an official connector: add a case in ConnectorIcon() only.
 */

function GmailIcon() {
  return (
    <svg width="20" height="16" viewBox="0 0 24 18" fill="none">
      <path d="M2.4 18h3.6V8.7L0 5.4V15.6C0 16.92 1.08 18 2.4 18Z" fill="#4285F4" />
      <path d="M18 18h3.6c1.32 0 2.4-1.08 2.4-2.4V5.4L18 8.7V18Z" fill="#34A853" />
      <path d="M18 2.4V8.7l6-4.5V3.6c0-2.94-3.36-4.62-5.7-2.85L18 2.4Z" fill="#FBBC04" />
      <path d="M6 8.7V2.4l6 4.5 6-4.5v6.3l-6 4.5L6 8.7Z" fill="#EA4335" />
      <path d="M0 3.6v1.8l6 4.5V2.4L5.7.75C3.36-1.02 0 .66 0 3.6Z" fill="#C5221F" />
    </svg>
  );
}

function GoogleCalendarIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path d="M18.316 5.684H5.684v12.632h12.632V5.684Z" fill="#fff" />
      <path d="M18.316 24l5.684-5.684h-5.684V24Z" fill="#1A73E8" />
      <path d="M24 5.684h-5.684v12.632H24V5.684Z" fill="#1A73E8" />
      <path d="M18.316 18.316H5.684V24h12.632v-5.684Z" fill="#1A73E8" />
      <path d="M0 18.316V21.6A2.4 2.4 0 0 0 2.4 24h2.284v-5.684H0Z" fill="#0D47A1" />
      <path d="M24 5.684V2.4A2.4 2.4 0 0 0 21.6 0h-3.284v5.684H24Z" fill="#1A73E8" />
      <path d="M18.316 0H2.4A2.4 2.4 0 0 0 0 2.4v15.916h5.684V5.684h12.632V0Z" fill="#4285F4" />
      <path d="M8.342 16.2a3.6 3.6 0 0 1-1.51-1.17l.85-.7c.28.4.6.7.98.92.38.22.81.33 1.28.33.49 0 .91-.12 1.26-.37.35-.25.52-.58.52-.99 0-.42-.18-.75-.55-1-.37-.25-.84-.37-1.42-.37h-.88v-1.05h.79c.5 0 .9-.11 1.22-.33.32-.22.48-.53.48-.92 0-.35-.15-.64-.46-.85-.31-.21-.69-.32-1.14-.32-.44 0-.8.1-1.08.29-.28.19-.5.44-.65.74l-.93-.62c.24-.45.58-.81 1.03-1.08.45-.27 1-.4 1.64-.4.49 0 .93.08 1.32.24.39.16.69.39.92.69.23.3.34.65.34 1.04 0 .42-.12.78-.36 1.08-.24.3-.55.52-.93.66v.06c.46.13.83.37 1.1.72.27.35.41.76.41 1.23 0 .44-.12.84-.36 1.18-.24.34-.58.61-1.01.8-.43.19-.93.29-1.49.29-.7 0-1.3-.15-1.83-.46Zm7.28-.18V9.78l-1.6 1.06-.5-.88 2.3-1.5h1.02v7.56h-1.22Z" fill="#1A73E8" />
    </svg>
  );
}

function GoogleDriveIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 87.3 78">
      <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8H0c0 1.55.4 3.1 1.2 4.5l5.4 9.35z" fill="#0066DA" />
      <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5l16.15-28z" fill="#00AC47" />
      <path d="M73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5H59.85L53.9 62.3l-6.25 14.5h25.9z" fill="#EA4335" />
      <path d="M43.65 25 57.4 1.2C56.05.4 54.5 0 52.9 0H34.4c-1.6 0-3.15.45-4.5 1.2L43.65 25z" fill="#00832D" />
      <path d="M59.8 53H27.5L13.75 76.8c1.35.8 2.9 1.2 4.5 1.2h36.85c1.6 0 3.15-.45 4.5-1.2L59.8 53z" fill="#2684FC" />
      <path d="M73.4 26.5 60.6 4.5c-.8-1.4-1.95-2.5-3.3-3.3L43.65 25l16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5l-12.65-22z" fill="#FFBA00" />
    </svg>
  );
}

function GitHubIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
      <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12Z" />
    </svg>
  );
}

function FathomIcon() {
  // Official Fathom logotype, sourced from fathom.ai (logotype-new.svg):
  // teal vertical bar + two cyan diagonal strokes. Width pinned to 18 to
  // match the rest of the icon set; native viewBox preserved.
  return (
    <svg width="18" height="18" viewBox="0 0 151 153" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path
        d="M0.921341 102.282V133.75C0.921341 142.004 6.05756 149.478 13.7776 151.959C26.8963 156.161 38.9436 146.302 38.9436 133.578V121.731L0.921341 102.282Z"
        fill="#007299"
      />
      <path
        d="M131.888 95.7704C129.031 95.7704 126.132 95.1181 123.402 93.7281L11.8239 36.9625C2.58091 32.2579 -1.71496 20.9347 2.59143 11.3757C7.08689 1.36768 18.7877 -2.78095 28.3773 2.09476L139.934 58.8497C149.292 63.6078 153.578 75.5298 148.893 85.0566C145.564 91.8463 138.852 95.7704 131.867 95.7704H131.888Z"
        fill="#00BEFF"
      />
      <path
        d="M75.8841 124.447C73.0272 124.447 70.1283 123.795 67.3974 122.405L11.8239 94.1344C2.58091 89.4298 -1.71496 78.1066 2.59143 68.5477C7.08689 58.5396 18.7877 54.391 28.3878 59.2667L83.9403 87.5266C93.2988 92.2847 97.5841 104.207 92.8996 113.733C89.57 120.523 82.8584 124.447 75.8736 124.447H75.8841Z"
        fill="#00BEFF"
      />
    </svg>
  );
}

function GcsIcon() {
  // Google Cloud Storage product mark — the two stacked storage slabs on the
  // 24px grid, in the official Google blues (dot + dash cut-outs rendered as
  // white shapes, matching the on-white console rendering). Hand-inlined like
  // the rest of the official set.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <rect x="2" y="4.5" width="20" height="6.5" rx="0.75" fill="#4285F4" />
      <rect x="2" y="13" width="20" height="6.5" rx="0.75" fill="#669DF6" />
      <circle cx="6.2" cy="7.75" r="1.3" fill="#fff" />
      <circle cx="6.2" cy="16.25" r="1.3" fill="#fff" />
      <rect x="11" y="6.9" width="7.8" height="1.7" rx="0.85" fill="#fff" />
      <rect x="11" y="15.4" width="7.8" height="1.7" rx="0.85" fill="#fff" />
    </svg>
  );
}

function FilesIcon() {
  // Workspace Files — folder + document glyph. Strokes only, no fill, so it
  // inherits the surrounding text color in both dark and light themes.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" xmlns="http://www.w3.org/2000/svg">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
      <path d="M7 12h6" />
      <path d="M7 15h10" />
    </svg>
  );
}

function NotionIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 100 100" fill="none">
      <path d="M6.017 4.313l55.333-4.087c6.797-.583 8.543-.19 12.817 2.917l17.663 12.443c2.913 2.14 3.883 2.723 3.883 5.053v68.243c0 4.277-1.553 6.807-6.99 7.193L24.467 99.967c-4.08.193-6.023-.39-8.16-3.113L3.3 79.94c-2.333-3.113-3.3-5.443-3.3-8.167V11.113c0-3.497 1.553-6.413 6.017-6.8Z" fill="#fff" />
      <path fillRule="evenodd" clipRule="evenodd" d="M61.35.227l-55.333 4.087C1.553 4.7 0 7.617 0 11.113v60.66c0 2.723.967 5.053 3.3 8.167l12.007 16.913c2.137 2.723 4.08 3.307 8.16 3.113L88.723 96.08c5.437-.387 6.99-2.917 6.99-7.193V20.64c0-2.21-.852-2.845-3.443-4.733L74.167 3.14C69.893.033 68.147-.357 61.35.227ZM25.723 19.263c-5.53.337-6.793.413-9.95-2.21L7.89 10.727c-.78-.78-.39-1.753 1.163-1.947l52.617-3.89c4.667-.39 7.003 1.167 8.75 2.527l9.457 6.807c.39.193 1.36 1.36.193 1.36l-54.347 3.487v.193ZM19.297 88.4V29.68c0-2.527.78-3.697 3.103-3.893L86 22.347c2.14-.193 3.107 1.167 3.107 3.693v58.527c0 2.527-.39 4.667-3.893 4.86l-62.803 3.693c-3.5.193-5.113-.973-5.113-4.72ZM74.36 33.5c.39 1.75 0 3.5-1.75 3.7l-3.11.583v43.313c-2.723 1.363-5.247 2.14-7.393 2.14-3.497 0-4.277-.967-6.803-4.083L37.873 50.97v27.527l6.413 1.36s0 3.5-4.857 3.5l-13.39.777c-.39-.777 0-2.723 1.36-3.11l3.497-.967V41.173l-4.86-.39c-.39-1.75.583-4.277 3.3-4.47L43.06 35.64l18.273 28.11V38.573l-5.247-.583c-.39-2.14 1.167-3.7 3.107-3.89l13.167-.6Z" fill="#000" />
    </svg>
  );
}

function WhatsAppIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
      <path
        d="M.057 24l1.687-6.163a11.867 11.867 0 0 1-1.587-5.946C.16 5.335 5.495 0 12.05 0a11.817 11.817 0 0 1 8.413 3.488 11.824 11.824 0 0 1 3.48 8.414c-.003 6.557-5.338 11.892-11.893 11.892a11.9 11.9 0 0 1-5.688-1.448L.057 24z"
        fill="#25D366"
      />
      <path
        d="M9.06 7.1c-.22-.49-.45-.5-.66-.51l-.56-.007c-.196 0-.51.073-.78.366-.27.293-1.026 1.003-1.026 2.445 0 1.442 1.05 2.836 1.196 3.032.146.196 2.027 3.248 5.01 4.42 2.48.978 2.984.784 3.522.735.538-.05 1.736-.71 1.98-1.395.245-.685.245-1.272.171-1.395-.073-.122-.269-.196-.563-.342-.293-.146-1.736-.857-2.005-.955-.269-.098-.465-.146-.66.147-.196.293-.758.954-.93 1.15-.171.196-.343.22-.636.073-.293-.147-1.238-.456-2.358-1.455-.872-.778-1.46-1.738-1.632-2.031-.171-.293-.018-.451.129-.597.132-.131.293-.342.44-.513.146-.171.195-.293.293-.489.098-.196.049-.366-.025-.513-.073-.146-.642-1.595-.902-2.176z"
        fill="#fff"
      />
    </svg>
  );
}

function SlackIcon() {
  // Official Slack mark — four-color octothorpe (viewBox 0 0 24 24). Brand
  // colors hard-coded like the rest of the official set. Slack ingest sources
  // (provider `slack`) reach this via `connectorId="slack"`; without the case
  // they fell through to the plug fallback and read as a generic/GitHub icon.
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M5.042 15.165a2.528 2.528 0 0 1-2.52 2.523A2.528 2.528 0 0 1 0 15.165a2.527 2.527 0 0 1 2.522-2.52h2.52v2.52z" fill="#E01E5A" />
      <path d="M6.313 15.165a2.527 2.527 0 0 1 2.521-2.52 2.527 2.527 0 0 1 2.521 2.52v6.313A2.528 2.528 0 0 1 8.834 24a2.528 2.528 0 0 1-2.521-2.522v-6.313z" fill="#E01E5A" />
      <path d="M8.834 5.042a2.528 2.528 0 0 1-2.521-2.52A2.528 2.528 0 0 1 8.834 0a2.528 2.528 0 0 1 2.521 2.522v2.52H8.834z" fill="#36C5F0" />
      <path d="M8.834 6.313a2.528 2.528 0 0 1 2.521 2.521 2.528 2.528 0 0 1-2.521 2.521H2.522A2.528 2.528 0 0 1 0 8.834a2.528 2.528 0 0 1 2.522-2.521h6.312z" fill="#36C5F0" />
      <path d="M18.956 8.834a2.528 2.528 0 0 1 2.522-2.521A2.528 2.528 0 0 1 24 8.834a2.528 2.528 0 0 1-2.522 2.521h-2.522V8.834z" fill="#2EB67D" />
      <path d="M17.688 8.834a2.528 2.528 0 0 1-2.522 2.521 2.527 2.527 0 0 1-2.52-2.521V2.522A2.527 2.527 0 0 1 15.166 0a2.528 2.528 0 0 1 2.522 2.522v6.312z" fill="#2EB67D" />
      <path d="M15.166 18.956a2.528 2.528 0 0 1 2.522 2.522A2.528 2.528 0 0 1 15.166 24a2.527 2.527 0 0 1-2.52-2.522v-2.522h2.52z" fill="#ECB22E" />
      <path d="M15.166 17.688a2.527 2.527 0 0 1-2.52-2.523 2.526 2.526 0 0 1 2.52-2.52h6.312A2.527 2.527 0 0 1 24 15.165a2.528 2.528 0 0 1-2.522 2.523h-6.312z" fill="#ECB22E" />
    </svg>
  );
}

import type { ReactNode } from "react";

export function ConnectorIcon({
  connectorId,
  iconUrl,
  fallback,
}: {
  connectorId: string;
  iconUrl?: string;
  /** Rendered when the connector has no built-in icon and no iconUrl. Defaults to a plug glyph. */
  fallback?: ReactNode;
}) {
  switch (connectorId) {
    case "gmail": return <GmailIcon />;
    case "gcal": return <GoogleCalendarIcon />;
    case "gdrive": return <GoogleDriveIcon />;
    case "github": return <GitHubIcon />;
    case "slack": return <SlackIcon />;
    case "notion": return <NotionIcon />;
    case "fathom": return <FathomIcon />;
    case "whatsapp": return <WhatsAppIcon />;
    case "files": return <FilesIcon />;
    case "gcs": return <GcsIcon />;
    default:
      if (iconUrl) {
        return (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={iconUrl}
            alt=""
            className="w-5 h-5 rounded"
            onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
          />
        );
      }
      return fallback !== undefined ? <>{fallback}</> : <span className="text-sm">&#128268;</span>;
  }
}
