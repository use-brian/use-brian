"use client";

/** Plan-specific application form controls and a non-submitting preview. [COMP:app-web/association] */
import { useState } from "react";
import { Eye } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import type { MembershipOptionalField, WebsiteMembershipPlan } from "@/lib/api/association";
import { Button } from "@/components/ui/button";
import { AssociationChoice } from "./operator-controls";
import { InlineNotice, SwitchField } from "./ui";

const optionalFields = ["position", "interests", "special_request", "proposer"] as const;

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
    {preview ? <div className="max-w-xl space-y-4 rounded-lg bg-muted/25 p-4" data-membership-form-preview>
      <p className="text-sm text-muted-foreground">{s.previewOnly}</p>
      <h4 className="text-lg font-semibold">{name || s.applicationForm}</h4>
      {application.type === "enquiry" ? <InlineNotice tone="neutral">{s.enquiryForm}</InlineNotice> :
        <ul className="grid gap-2 sm:grid-cols-2">
          {[
            [s.salutation, true], [s.firstName, true], [s.lastName, true], [s.email, true], [s.phone, true],
            [s.identityFragment, true], [s.birthDate, true], [s.industry, true], [s.organisation, true],
            ...(selected.includes("position") ? [[s.jobTitle, false]] : []),
            [s.mailingAddress, true], [s.referral, true],
            ...(selected.includes("interests") ? [[s.interests, false]] : []),
            ...(selected.includes("special_request") ? [[s.specialRequest, false]] : []),
            ...(selected.includes("proposer") || application.proposerRequired ? [[free && application.proposerRequired ? s.sponsorName : s.proposerName, application.proposerRequired], [free && application.proposerRequired ? s.sponsorEmail : s.proposerEmail, application.proposerRequired]] : []),
            [s.conduct, true], [s.membershipConsent, true], [s.marketingConsent, false],
          ].map(([label, required]) => <li key={String(label)} className="min-w-0 rounded-md bg-background px-3 py-2 text-sm">
            <span className="block break-words font-medium">{label}</span><span className="text-xs text-muted-foreground">{required ? s.required : s.optional}</span>
          </li>)}
        </ul>}
    </div> : <>
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
