"use client";

/** Dedicated application administration. [COMP:app-web/studio-application-management] */
import { ApplicationManagement } from "@/components/applications/application-admin";
import { ProgrammaticAccessShell } from "@/components/studio/programmatic-access-shell";

export default function ApplicationManagementPage() {
  return <ProgrammaticAccessShell active="applications"><ApplicationManagement /></ProgrammaticAccessShell>;
}
