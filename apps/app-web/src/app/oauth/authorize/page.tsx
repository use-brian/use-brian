"use client";
import { Suspense } from "react";
import { useSearchParams } from "next/navigation";
import { ApplicationConsent } from "./application-consent";
import { WorkspaceConsent } from "./workspace-consent";
function Consent() { return useSearchParams()?.get('application') ? <ApplicationConsent /> : <WorkspaceConsent />; }
export default function Page() { return <Suspense><Consent /></Suspense>; }
