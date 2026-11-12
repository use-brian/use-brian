"use client";

/** Plan-specific application form controls and a non-submitting preview. [COMP:app-web/association] */
import { useState } from "react";
import { ChevronDown, Eye, Square } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import type { MembershipOptionalField, WebsiteMembershipPlan } from "@/lib/api/association";
import { Button } from "@/components/ui/button";
import { AssociationChoice } from "./operator-controls";
import { InlineNotice, SwitchField } from "./ui";

const optionalFields = ["position", "interests", "special_request", "proposer"] as const;

type Application = WebsiteMembershipPlan["application"];

export function MembershipApplicationPreview({ application, name, free }: {
  application: Application;
  name: string;
  free: boolean;
}) {
  const s = useT().associationPage.staff;
  const selected = application.optionalFields ?? optionalFields;
  const requiredProposer = application.proposerRequired;
  const sponsored = free && requiredProposer;
  const fields: Array<{ label: string; required: boolean; kind?: "select" | "area" | "check" }> = [
    { label: s.salutation, required: true, kind: "select" },
    { label: s.firstName, required: true },
    { label: s.lastName, required: true },
    { label: s.email, required: true },
    { label: s.phone, required: true },
    { label: s.identityFragment, required: true },
    { label: s.birthDate, required: true },
    { label: s.industry, required: true, kind: "select" },
    { label: s.organisation, required: true },
    ...(selected.includes("position") ? [{ label: s.jobTitle, required: false }] : []),
    { label: s.mailingAddress, required: true, kind: "area" },
    { label: s.referral, required: true, kind: "select" },
    ...(selected.includes("interests") ? [{ label: s.interests, required: false, kind: "check" as const }] : []),
    ...(selected.includes("special_request") ? [{ label: s.specialRequest, required: false, kind: "area" as const }] : []),
    ...(selected.includes("proposer") || requiredProposer ? [
      { label: sponsored ? s.sponsorName : s.proposerName, required: requiredProposer },
      { label: sponsored ? s.sponsorEmail : s.proposerEmail, required: requiredProposer },
    ] : []),
    { label: s.conduct, required: true, kind: "check" },
    { label: s.membershipConsent, required: true, kind: "check" },
    { label: s.marketingConsent, required: false, kind: "check" },
  ];
  return <div className="max-w-2xl space-y-4 rounded-xl border bg-background p-4 sm:p-6" data-membership-form-preview>
    <h4 className="text-lg font-semibold">{name || s.applicationForm}</h4>
    <p className="text-sm text-muted-foreground">{s.previewOnly}</p>
    {application.type === "enquiry" ? <InlineNotice tone="neutral">{s.enquiryForm}</InlineNotice> :
      <ul className="grid gap-4 sm:grid-cols-2">
        {fields.map(({ label, required, kind }) => <li key={label} className={kind === "check" || kind === "area" ? "sm:col-span-2" : "min-w-0"}>
          <div className="flex items-start gap-2 text-sm">
            {kind === "check" && <Square aria-hidden className="mt-0.5 size-4 shrink-0" />}
            <span className="font-medium">{label}</span>
            <span className="text-xs text-muted-foreground">{required ? s.required : s.optional}</span>
          </div>
          {kind !== "check" && <div aria-hidden className={`mt-1.5 flex items-center justify-end rounded-md bg-muted px-3 ${kind === "area" ? "h-16" : "h-10"}`}>
            {kind === "select" && <ChevronDown className="size-4 text-muted-foreground" />}
          </div>}
        </li>)}
      </ul>}
  </div>;
}

export function MembershipApplicationEditor({ application, name, free, onChange }: {
  application: WebsiteMembershipPlan["application"];
  name: string;
  free: boolean;
  onChange: (application: WebsiteMembershipPlan["application"]) => void;
}) {
  const t = useT().associationPage, s = t.staff, c = t.publishing;
  const [preview, setPreview] = useState(false);
  const selected = application.optionalFields ?? optionalFields;
  const labels: Record<MembershipOptionalField, string> = {
    position: s.jobTitle, interests: s.interests, special_request: s.specialRequest, proposer: s.proposerDetails,
  };

  function toggleField(field: MembershipOptionalField, included: boolean) {
    onChange({ ...application, optionalFields: optionalFields.filter(key => key === field ? included : selected.includes(key)) });
  }

  return <section className="space-y-4 rounded-xl border border-border bg-background p-5" data-membership-form-editor>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><h3 className="font-semibold">{s.applicationForm}</h3><p className="mt-1 text-sm text-muted-foreground">{s.applicationHelp}</p></div>
      <Button type="button" variant="outline" className="min-h-11 md:min-h-9" aria-pressed={preview} onClick={() => setPreview(value => !value)}>
        <Eye aria-hidden className="size-4" />{preview ? s.backToEditor : s.previewForm}
      </Button>
    </header>
    {preview ? <MembershipApplicationPreview application={application} name={name} free={free} /> : <>
      <AssociationChoice label={c.type} value={application.type} values={["application", "enquiry"]}
        labels={{ application: c.application, enquiry: c.enquiry }}
        onChange={type => onChange({ ...application, type: type as WebsiteMembershipPlan["application"]["type"] })} />
      {application.type === "enquiry" ? <InlineNotice tone="neutral">{s.enquiryForm}</InlineNotice> : <>
        <SwitchField label={c.proposer} checked={application.proposerRequired} onChange={proposerRequired => onChange({ ...application, proposerRequired })} />
        <div className="grid gap-2 sm:grid-cols-2">
          {optionalFields.map(field => <SwitchField key={field} label={labels[field]} checked={selected.includes(field) || (field === "proposer" && application.proposerRequired)}
            disabled={field === "proposer" && application.proposerRequired} onChange={included => toggleField(field, included)} />)}
        </div>
      </>}
    </>}
  </section>;
}
