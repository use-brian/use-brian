"use client";

/**
 * Google Drive Picker (app-web).
 *
 * Ported from `apps/web/src/components/drive-picker.tsx`
 * (app consolidation §9 #5). Loads the gapi + picker libraries, fetches a
 * short-lived OAuth access token from the backend, and opens the Picker so the
 * user can grant per-file access to the gdrive connector. Picked files flow to
 * the caller via `onPicked`; the caller is responsible for POSTing them to
 * `/api/connectors/gdrive/authorized-files`.
 *
 * INFRA NOTE (degraded): the Picker needs `NEXT_PUBLIC_GOOGLE_API_KEY` and
 * `NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER` — env vars app-web does not set yet.
 * When unset, `open()` surfaces an actionable "not configured" message rather
 * than failing silently, so the UI degrades gracefully until the deployment
 * supplies them.
 *
 * See docs/architecture/integrations/mcp.md → "The `gdrive` connector".
 *
 * [COMP:app-web/drive-picker]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Script from "next/script";
import { authFetch } from "@/lib/auth-fetch";
import { useT } from "@/lib/i18n/client";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";
const GOOGLE_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_API_KEY ?? "";
const GOOGLE_PROJECT_NUMBER = process.env.NEXT_PUBLIC_GOOGLE_PROJECT_NUMBER ?? "";

export type PickedFile = {
  id: string;
  name: string;
  mimeType: string;
};

// Minimal ambient typing for the subset of `google.picker` we actually touch.
// Full typings live in @types/google.picker but we don't depend on that package.
type PickerDocument = {
  id: string;
  name: string;
  mimeType: string;
};

type PickerCallbackData = {
  action: string;
  docs?: PickerDocument[];
};

type PickerInstance = {
  setVisible: (visible: boolean) => PickerInstance;
};

interface PickerBuilder {
  setOAuthToken: (token: string) => PickerBuilder;
  setDeveloperKey: (key: string) => PickerBuilder;
  setAppId: (id: string) => PickerBuilder;
  addView: (view: unknown) => PickerBuilder;
  enableFeature: (feature: string) => PickerBuilder;
  setCallback: (cb: (data: PickerCallbackData) => void) => PickerBuilder;
  build: () => PickerInstance;
}

interface DocsView {
  setMimeTypes: (mimeTypes: string) => DocsView;
  setSelectFolderEnabled: (enabled: boolean) => DocsView;
}

type GooglePicker = {
  picker: {
    PickerBuilder: new () => PickerBuilder;
    DocsView: new (viewId?: unknown) => DocsView;
    ViewId: { DOCS: unknown; SPREADSHEETS: unknown; PRESENTATIONS: unknown };
    Action: { PICKED: string; CANCEL: string };
    Feature: { MULTISELECT_ENABLED: string; SUPPORT_DRIVES: string };
  };
};

declare global {
  interface Window {
    gapi?: {
      load: (name: string, cb: () => void) => void;
    };
    google?: GooglePicker;
  }
}

type PickerReadyState = {
  /** Fully ready: scripts loaded and env vars configured. */
  ready: boolean;
  /** If not ready, why. Surfaced as a tooltip/message. */
  disabledReason?: string;
};

type DrivePickerProps = {
  /** Whether the picker trigger is mounted. */
  children: (
    props: {
      open: () => void;
      isOpening: boolean;
      disabled: boolean;
      disabledReason?: string;
    } & PickerReadyState,
  ) => React.ReactNode;
  onPicked: (files: PickedFile[]) => void;
  onError?: (message: string) => void;
};

export function DrivePicker({ children, onPicked, onError }: DrivePickerProps) {
  const t = useT();
  const [apiLoaded, setApiLoaded] = useState(false);
  const [pickerLoaded, setPickerLoaded] = useState(false);
  const [isOpening, setIsOpening] = useState(false);
  const lastTokenRef = useRef<{ token: string; expiresAt: number } | null>(null);

  // Load the `picker` module once gapi itself has loaded.
  useEffect(() => {
    if (!apiLoaded || pickerLoaded) return;
    if (!window.gapi) return;
    window.gapi.load("picker", () => setPickerLoaded(true));
  }, [apiLoaded, pickerLoaded]);

  const getAccessToken = useCallback(async (): Promise<string> => {
    const cached = lastTokenRef.current;
    if (cached && cached.expiresAt > Date.now() + 60_000) return cached.token;

    const res = await authFetch(`${API_URL}/api/connectors/gdrive/access-token`);
    if (!res.ok) {
      throw new Error(
        res.status === 409 ? t.drivePicker.connectFirst : t.drivePicker.noToken,
      );
    }
    const body = (await res.json()) as { accessToken: string; expiresIn: number };
    lastTokenRef.current = {
      token: body.accessToken,
      expiresAt: Date.now() + body.expiresIn * 1000,
    };
    return body.accessToken;
  }, [t]);

  const open = useCallback(async () => {
    if (!GOOGLE_API_KEY || !GOOGLE_PROJECT_NUMBER) {
      onError?.(t.drivePicker.notConfigured);
      return;
    }
    if (!pickerLoaded || !window.google?.picker) {
      onError?.(t.drivePicker.loading);
      return;
    }

    setIsOpening(true);
    try {
      const token = await getAccessToken();
      const picker = window.google.picker;

      const docsView = new picker.DocsView(picker.ViewId.DOCS);
      docsView.setSelectFolderEnabled(false);
      const sheetsView = new picker.DocsView(picker.ViewId.SPREADSHEETS);
      const slidesView = new picker.DocsView(picker.ViewId.PRESENTATIONS);

      new picker.PickerBuilder()
        .setOAuthToken(token)
        .setDeveloperKey(GOOGLE_API_KEY)
        .setAppId(GOOGLE_PROJECT_NUMBER)
        .addView(docsView)
        .addView(sheetsView)
        .addView(slidesView)
        .enableFeature(picker.Feature.MULTISELECT_ENABLED)
        .enableFeature(picker.Feature.SUPPORT_DRIVES)
        .setCallback((data) => {
          if (data.action === picker.Action.PICKED && data.docs?.length) {
            onPicked(
              data.docs.map((d) => ({ id: d.id, name: d.name, mimeType: d.mimeType })),
            );
          }
        })
        .build()
        .setVisible(true);
    } catch (err) {
      onError?.(err instanceof Error ? err.message : t.drivePicker.pickerFailed);
    } finally {
      setIsOpening(false);
    }
  }, [pickerLoaded, getAccessToken, onPicked, onError, t]);

  // Only keep `disabled` for loading states — unconfigured env still lets the
  // click through so `open()` can surface an actionable error. Otherwise the
  // user sees a greyed-out button with no explanation.
  const notConfigured = !GOOGLE_API_KEY || !GOOGLE_PROJECT_NUMBER;
  const disabled = !notConfigured && !pickerLoaded;
  const disabledReason = notConfigured
    ? t.drivePicker.notConfiguredDeployment
    : !pickerLoaded
      ? t.drivePicker.loadingPicker
      : undefined;
  const ready = !disabled && !notConfigured;

  return (
    <>
      <Script
        src="https://apis.google.com/js/api.js"
        strategy="afterInteractive"
        onLoad={() => setApiLoaded(true)}
      />
      {children({ open, isOpening, disabled, disabledReason, ready })}
    </>
  );
}
