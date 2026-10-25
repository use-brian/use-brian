"use client";

/** Shared mini-app icons for App store, app headers and Studio configuration.
 * Spec: docs/architecture/features/workspace-navigation.md.
 * [COMP:app-web/operator-app-bar] */
import { CheckSquare, FileText, Files, Users, Megaphone, MessageSquare,
  MonitorPlay, ShoppingBag, Ticket, type LucideIcon } from "lucide-react";
import type { OperatorAppKey } from "@/lib/operator-apps";

/** App key → glyph — shared with the operator top bar's tab chip
 *  (`components/operator/operator-topbar.tsx`) so the app-bar entry and the
 *  chip can never drift. */
export const APP_ICON: Record<OperatorAppKey, LucideIcon> = {
  page: FileText,
  office: Files,
  tasks: CheckSquare,
  feed: Megaphone,
  crm: Users,
  browsers: MonitorPlay,
  chat: MessageSquare,
  shopify: ShoppingBag,
  association: Ticket,
};
