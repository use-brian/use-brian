"use client";

/** Intake definition and least-privilege credential controls. [COMP:app-web/crm-operations] */

import { useEffect, useMemo, useState } from "react";
import { Check, Copy, KeyRound, Plus, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  createCrmIntakeCredential,
  listCrmIntakeCredentials,
  listCrmIntakeDefinitions,
  revokeCrmIntakeCredential,
  saveCrmConsentPurpose,
  saveCrmIntakeDefinition,
  listCrmConsentPurposes,
  type CrmConsentPurpose,
  type CrmDeliveryChannel,
  type CrmIntakeCredential,
  type CrmIntakeDefinition,
  type CrmIntakeDefinitionInput,
} from "@/lib/api/crm";
import { useT } from "@/lib/i18n/client";
import { CrmOperationsAuditView } from "./audit-view";

const stableKey = (label: string) => label.trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 63);

export function CrmIntakeSettings({ workspaceId }: { workspaceId: string }) {
  const t = useT().crmPage.operations;
  const [definitions, setDefinitions] = useState<CrmIntakeDefinition[]>([]);
  const [credentials, setCredentials] = useState<CrmIntakeCredential[]>([]);
  const [purposes, setPurposes] = useState<CrmConsentPurpose[]>([]);
  const [definitionLabel, setDefinitionLabel] = useState("");
  const [definitionKey, setDefinitionKey] = useState("");
  const [identityPolicy, setIdentityPolicy] = useState<CrmIntakeDefinition["identityPolicy"]>("trusted_verified_email");
  const [schemaText, setSchemaText] = useState("");
  const [credentialLabel, setCredentialLabel] = useState("");
  const [credentialDefinitionId, setCredentialDefinitionId] = useState("");
  const [oneTimeKey, setOneTimeKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [purposeLabel, setPurposeLabel] = useState("");
  const [purposeKey, setPurposeKey] = useState("");
  const [wordingVersion, setWordingVersion] = useState("v1");
  const [wording, setWording] = useState("");
  const [purposeChannels, setPurposeChannels] = useState<CrmDeliveryChannel[]>(["email"]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const starterFields = useMemo(() => [
    { key: "name", label: t.defaultNameField, type: "text", required: true, mapping: { kind: "base_field", field: "name" } },
    { key: "email", label: t.defaultEmailField, type: "email", required: true, mapping: { kind: "base_field", field: "email" } },
    { key: "message", label: t.defaultMessageField, type: "text", required: false, maxLength: 5000, mapping: { kind: "submission_only" } },
  ], [t]);

  useEffect(() => {
    setSchemaText(JSON.stringify(starterFields, null, 2));
  }, [starterFields]);

  async function reload() {
    const [nextDefinitions, nextCredentials, nextPurposes] = await Promise.all([
      listCrmIntakeDefinitions(workspaceId),
      listCrmIntakeCredentials(workspaceId),
      listCrmConsentPurposes(workspaceId, true),
    ]);
    setDefinitions(nextDefinitions);
    setCredentials(nextCredentials);
    setPurposes(nextPurposes);
    setCredentialDefinitionId((current) => current || nextDefinitions.find((item) => item.active)?.id || "");
  }

  useEffect(() => {
    void reload().catch((cause) => setError(cause instanceof Error ? cause.message : t.loadFailed));
  }, [workspaceId]);

  async function createDefinition() {
    if (!definitionLabel.trim() || !definitionKey.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      const fields = JSON.parse(schemaText) as CrmIntakeDefinitionInput["definition"]["fields"];
      await saveCrmIntakeDefinition(workspaceId, {
        definitionKey: definitionKey.trim(),
        label: definitionLabel.trim(),
        definition: {
          fields,
          identityPolicy,
          consentMappings: [],
          queueKey: "general",
          followUpTaskTemplate: null,
          followUpDueMinutes: null,
          maxPayloadBytes: 65_536,
        },
      });
      setDefinitionLabel("");
      setDefinitionKey("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  async function createCredential() {
    if (!credentialLabel.trim() || !credentialDefinitionId || busy) return;
    setBusy(true);
    setError(null);
    try {
      const created = await createCrmIntakeCredential(workspaceId, {
        label: credentialLabel.trim(),
        definitionIds: [credentialDefinitionId],
      });
      setOneTimeKey(created.key);
      setCredentialLabel("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  async function createPurpose() {
    if (!purposeLabel.trim() || !purposeKey.trim() || !wording.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      await saveCrmConsentPurpose(workspaceId, {
        purposeKey: purposeKey.trim(),
        label: purposeLabel.trim(),
        description: "",
        requiresConsent: true,
        applicableChannels: purposeChannels,
        wordingVersion: wordingVersion.trim(),
        wording: wording.trim(),
        archived: false,
      });
      setPurposeLabel("");
      setPurposeKey("");
      setWording("");
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(credential: CrmIntakeCredential) {
    const confirmed = await confirmDialog({
      title: t.revokeTitle,
      description: t.revokeDescription.replace("{name}", credential.label),
      confirmLabel: t.revoke,
      cancelLabel: t.cancel,
      variant: "destructive",
    });
    if (!confirmed) return;
    setBusy(true);
    try {
      await revokeCrmIntakeCredential(workspaceId, credential.id);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="border-t border-border pt-5" data-crm-intake-settings>
      <div className="mb-3">
        <h3 className="flex items-center gap-2 text-sm font-semibold"><KeyRound className="size-4" aria-hidden />{t.title}</h3>
        <p className="text-xs text-muted-foreground">{t.description}</p>
      </div>
      {error && <div className="mb-3 rounded-lg bg-destructive/10 px-3 py-2 text-xs text-destructive">{error}</div>}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="rounded-xl border border-border p-3">
          <h4 className="text-xs font-semibold">{t.definitions}</h4>
          <p className="mt-1 text-[11px] text-muted-foreground">{t.definitionsHelp}</p>
          <div className="mt-3 grid gap-2 sm:grid-cols-2">
            <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.definitionLabel}</span><input className="h-9 w-full rounded-md border border-input bg-transparent px-3" value={definitionLabel} onChange={(event) => { setDefinitionLabel(event.target.value); if (!definitionKey) setDefinitionKey(stableKey(event.target.value)); }} /></label>
            <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.definitionKey}</span><input className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono" value={definitionKey} onChange={(event) => setDefinitionKey(stableKey(event.target.value))} /></label>
            <label className="text-xs sm:col-span-2"><span className="mb-1 block text-muted-foreground">{t.identityPolicy}</span>
              <Select value={identityPolicy} onValueChange={(value) => setIdentityPolicy(value as typeof identityPolicy)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="trusted_verified_email">{t.identityTrustedEmail}</SelectItem>
                  <SelectItem value="new_or_review">{t.identityNewReview}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            <label className="text-xs sm:col-span-2"><span className="mb-1 block text-muted-foreground">{t.fieldSchema}</span><textarea rows={9} spellCheck={false} className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[11px]" value={schemaText} onChange={(event) => setSchemaText(event.target.value)} /></label>
          </div>
          <Button className="mt-2" size="sm" disabled={busy || !definitionLabel.trim() || !definitionKey.trim()} onClick={() => void createDefinition()}><Plus aria-hidden />{t.createDefinition}</Button>
          <div className="mt-3 space-y-2">
            {definitions.map((definition) => <div key={definition.id} className="rounded-lg bg-muted/30 px-3 py-2 text-xs"><div className="font-medium">{definition.label}</div><div className="font-mono text-[10px] text-muted-foreground">{definition.definitionKey} · v{definition.currentVersion}</div></div>)}
            {definitions.length === 0 && <div className="text-xs text-muted-foreground">{t.noDefinitions}</div>}
          </div>
        </div>

        <div className="rounded-xl border border-border p-3">
          <h4 className="text-xs font-semibold">{t.credentials}</h4>
          <p className="mt-1 text-[11px] text-muted-foreground">{t.credentialsHelp}</p>
          {oneTimeKey && <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3"><div className="text-xs font-medium">{t.copyNow}</div><div className="mt-2 break-all rounded bg-background p-2 font-mono text-[11px]">{oneTimeKey}</div><Button className="mt-2" size="xs" variant="outline" onClick={() => void navigator.clipboard.writeText(oneTimeKey).then(() => setCopied(true))}>{copied ? <Check aria-hidden /> : <Copy aria-hidden />}{copied ? t.copied : t.copy}</Button></div>}
          <div className="mt-3 grid gap-2">
            <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.credentialLabel}</span><input className="h-9 w-full rounded-md border border-input bg-transparent px-3" value={credentialLabel} onChange={(event) => setCredentialLabel(event.target.value)} /></label>
            <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.boundDefinition}</span>
              <Select value={credentialDefinitionId} onValueChange={(value) => setCredentialDefinitionId(value ?? "")}>
                <SelectTrigger className="w-full"><SelectValue placeholder={t.pickDefinition} /></SelectTrigger>
                <SelectContent>{definitions.filter((item) => item.active).map((definition) => <SelectItem key={definition.id} value={definition.id}>{definition.label}</SelectItem>)}</SelectContent>
              </Select>
            </label>
          </div>
          <Button className="mt-2" size="sm" disabled={busy || !credentialLabel.trim() || !credentialDefinitionId} onClick={() => void createCredential()}><Plus aria-hidden />{t.createCredential}</Button>
          <div className="mt-3 space-y-2">
            {credentials.map((credential) => <div key={credential.id} className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-3 py-2 text-xs"><div><div className="font-medium">{credential.label}</div><div className="font-mono text-[10px] text-muted-foreground">{credential.prefix} · {credential.revokedAt ? t.revoked : t.active}</div></div>{!credential.revokedAt && <Button size="icon-xs" variant="ghost" aria-label={t.revoke} disabled={busy} onClick={() => void revoke(credential)}><RotateCcw aria-hidden /></Button>}</div>)}
            {credentials.length === 0 && <div className="text-xs text-muted-foreground">{t.noCredentials}</div>}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-border p-3">
        <h4 className="text-xs font-semibold">{t.purposes}</h4>
        <p className="mt-1 text-[11px] text-muted-foreground">{t.purposesHelp}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.purposeLabel}</span><input className="h-9 w-full rounded-md border border-input bg-transparent px-3" value={purposeLabel} onChange={(event) => { setPurposeLabel(event.target.value); if (!purposeKey) setPurposeKey(stableKey(event.target.value)); }} /></label>
          <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.purposeKey}</span><input className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono" value={purposeKey} onChange={(event) => setPurposeKey(stableKey(event.target.value))} /></label>
          <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.wordingVersion}</span><input className="h-9 w-full rounded-md border border-input bg-transparent px-3" value={wordingVersion} onChange={(event) => setWordingVersion(event.target.value)} /></label>
          <label className="text-xs sm:col-span-3"><span className="mb-1 block text-muted-foreground">{t.wording}</span><textarea rows={3} className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2" value={wording} onChange={(event) => setWording(event.target.value)} /></label>
          <div className="sm:col-span-3"><div className="mb-1 text-xs text-muted-foreground">{t.channels}</div><div className="flex flex-wrap gap-1">{(["email", "sms", "phone", "whatsapp", "telegram", "slack"] as const).map((channel) => <Button key={channel} type="button" size="xs" variant={purposeChannels.includes(channel) ? "secondary" : "outline"} aria-pressed={purposeChannels.includes(channel)} onClick={() => setPurposeChannels((current) => current.includes(channel) ? current.filter((item) => item !== channel) : [...current, channel])}>{t.channelLabels[channel]}</Button>)}</div></div>
        </div>
        <Button className="mt-2" size="sm" disabled={busy || !purposeLabel.trim() || !purposeKey.trim() || !wording.trim() || purposeChannels.length === 0} onClick={() => void createPurpose()}><Plus aria-hidden />{t.createPurpose}</Button>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {purposes.map((purpose) => <div key={purpose.id} className="rounded-lg bg-muted/30 px-3 py-2 text-xs"><div className="font-medium">{purpose.label}</div><div className="font-mono text-[10px] text-muted-foreground">{purpose.purposeKey} · {purpose.wordingVersion} · {purpose.archivedAt ? t.archived : purpose.applicableChannels.map((channel) => t.channelLabels[channel]).join(", ")}</div></div>)}
          {purposes.length === 0 && <div className="text-xs text-muted-foreground">{t.noPurposes}</div>}
        </div>
      </div>
      <CrmOperationsAuditView workspaceId={workspaceId} />
    </section>
  );
}
