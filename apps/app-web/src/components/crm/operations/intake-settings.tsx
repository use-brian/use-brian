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
import { LOCALES, LOCALE_LABELS, type Locale } from "@/lib/i18n/config";
import { useT } from "@/lib/i18n/client";
import { CrmOperationsAuditView } from "./audit-view";
import { CrmPrivacyPolicySettings } from "./privacy-policy-settings";

const stableKey = (label: string) => label.trim().toLowerCase()
  .replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 63);

/** Policies that take a claimed email without a verification key. */
const unverifiedPolicy = (policy: CrmIntakeDefinition["identityPolicy"]) =>
  policy === "new_or_review" || policy === "existing_or_new";

export function CrmIntakeSettings({ workspaceId }: { workspaceId: string }) {
  const t = useT().crmPage.operations;
  const [definitions, setDefinitions] = useState<CrmIntakeDefinition[]>([]);
  const [credentials, setCredentials] = useState<CrmIntakeCredential[]>([]);
  const [purposes, setPurposes] = useState<CrmConsentPurpose[]>([]);
  const [definitionLabel, setDefinitionLabel] = useState("");
  const [definitionKey, setDefinitionKey] = useState("");
  const [identityPolicy, setIdentityPolicy] = useState<CrmIntakeDefinition["identityPolicy"]>("new_or_review");
  const needsVerification = !unverifiedPolicy(identityPolicy);
  const [editingDefinition, setEditingDefinition] = useState<CrmIntakeDefinition | null>(null);
  const [identityProvider, setIdentityProvider] = useState("");
  const [verificationKeyId, setVerificationKeyId] = useState("");
  const [verificationPublicKey, setVerificationPublicKey] = useState("");
  const [verificationMaxAge, setVerificationMaxAge] = useState("");
  const [verificationAcknowledged, setVerificationAcknowledged] = useState(false);
  const [schemaText, setSchemaText] = useState("");
  const [consentMappingsText, setConsentMappingsText] = useState("[]");
  const [credentialLabel, setCredentialLabel] = useState("");
  const [credentialDefinitionId, setCredentialDefinitionId] = useState("");
  const [oneTimeKey, setOneTimeKey] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [editingPurpose, setEditingPurpose] = useState<CrmConsentPurpose | null>(null);
  const [defaultLocale, setDefaultLocale] = useState<Locale | "default">("default");
  const [localeWordings, setLocaleWordings] = useState<Partial<Record<Locale, string>>>({});
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
    if (!definitionLabel.trim() || !definitionKey.trim() || busy || (needsVerification && !verificationAcknowledged)) return;
    setBusy(true);
    setError(null);
    try {
      const fields = JSON.parse(schemaText) as CrmIntakeDefinitionInput["definition"]["fields"];
      await saveCrmIntakeDefinition(workspaceId, {
        ...(editingDefinition ? { definitionId: editingDefinition.id, expectedVersion: editingDefinition.currentVersion, active: editingDefinition.active } : {}),
        definitionKey: definitionKey.trim(),
        label: definitionLabel.trim(),
        definition: {
          fields,
          identityPolicy,
          ...(needsVerification ? { identityVerification: {
            keyId: verificationKeyId.trim(), publicKey: verificationPublicKey.trim(),
            maxAgeSeconds: Number(verificationMaxAge), acknowledged: true as const,
          } } : {}),
          allowedIdentityProvider: identityPolicy === "external_subject" ? identityProvider.trim() : null,
          consentMappings: JSON.parse(consentMappingsText) as CrmIntakeDefinition["consentMappings"],
          queueKey: editingDefinition?.queueKey ?? "general",
          ownerUserId: editingDefinition?.ownerUserId ?? null,
          followUpTaskTemplate: editingDefinition?.followUpTaskTemplate ?? null,
          followUpDueMinutes: editingDefinition?.followUpDueMinutes ?? null,
          maxPayloadBytes: editingDefinition?.maxPayloadBytes ?? 65_536,
          workflowHint: editingDefinition?.workflowHint ?? null,
        },
      });
      selectDefinition(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  function selectDefinition(definition: CrmIntakeDefinition | null) {
    setEditingDefinition(definition);
    setDefinitionLabel(definition?.label ?? ""); setDefinitionKey(definition?.definitionKey ?? "");
    setIdentityPolicy(definition?.identityPolicy ?? "new_or_review");
    setSchemaText(JSON.stringify(definition?.fields ?? starterFields, null, 2));
    setConsentMappingsText(JSON.stringify(definition?.consentMappings ?? [], null, 2));
    setIdentityProvider(definition?.allowedIdentityProvider ?? "");
    setVerificationKeyId(definition?.identityVerification?.keyId ?? "");
    setVerificationPublicKey(definition?.identityVerification?.publicKey ?? "");
    setVerificationMaxAge(definition?.identityVerification ? String(definition.identityVerification.maxAgeSeconds) : "");
    setVerificationAcknowledged(false);
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
      setCopied(false);
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
        ...(editingPurpose ? { purposeId: editingPurpose.id } : {}),
        purposeKey: purposeKey.trim(),
        label: purposeLabel.trim(),
        description: editingPurpose?.description ?? "",
        requiresConsent: editingPurpose?.requiresConsent ?? true,
        applicableChannels: purposeChannels,
        wordingVersion: wordingVersion.trim(),
        wording: wording.trim(),
        defaultLocale: defaultLocale === "default" ? null : defaultLocale,
        localeWordings: Object.fromEntries(Object.entries(localeWordings).filter(([, text]) => text.trim()).map(([locale, text]) => [locale, text.trim()])),
        archived: Boolean(editingPurpose?.archivedAt),
      });
      selectPurpose(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t.saveFailed);
    } finally {
      setBusy(false);
    }
  }

  function selectPurpose(purpose: CrmConsentPurpose | null) {
    setEditingPurpose(purpose);
    setPurposeLabel(purpose?.label ?? "");
    setPurposeKey(purpose?.purposeKey ?? "");
    setWordingVersion(purpose?.wordingVersion ?? "v1");
    setWording(purpose?.wording ?? "");
    setDefaultLocale(purpose?.defaultLocale ?? "default");
    setLocaleWordings(purpose?.localeWordings ?? {});
    setPurposeChannels(purpose?.applicableChannels ?? ["email"]);
  }

  async function rotate(credential: CrmIntakeCredential) {
    if (busy || !await confirmDialog({
      title: t.rotateCredential, description: t.rotateCredentialHelp,
      confirmLabel: t.rotateCredential, cancelLabel: t.cancel,
    })) return;
    setBusy(true); setError(null);
    try {
      const created = await createCrmIntakeCredential(workspaceId, {
        label: credential.label, definitionIds: credential.definitionIds, rotateFromCredentialId: credential.id,
      });
      setOneTimeKey(created.key); setCopied(false);
      await reload();
    } catch (cause) { setError(cause instanceof Error ? cause.message : t.saveFailed); }
    finally { setBusy(false); }
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
            <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.definitionLabel}</span><input className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-[16px] md:text-xs" value={definitionLabel} onChange={(event) => { setDefinitionLabel(event.target.value); if (!definitionKey) setDefinitionKey(stableKey(event.target.value)); }} /></label>
            <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.definitionKey}</span><input disabled={!!editingDefinition} className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-[16px] md:text-xs" value={definitionKey} onChange={(event) => setDefinitionKey(stableKey(event.target.value))} /></label>
            <label className="text-xs sm:col-span-2"><span className="mb-1 block text-muted-foreground">{t.identityPolicy}</span>
              <Select value={identityPolicy} onValueChange={(value) => setIdentityPolicy(value as typeof identityPolicy)}>
                <SelectTrigger className="w-full"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="trusted_verified_email">{t.identityTrustedEmail}</SelectItem>
                  <SelectItem value="new_or_review">{t.identityNewReview}</SelectItem>
                  <SelectItem value="existing_or_new">{t.identityExistingOrNew}</SelectItem>
                  <SelectItem value="external_subject">{t.identityExternalSubject}</SelectItem>
                </SelectContent>
              </Select>
            </label>
            {identityPolicy === "external_subject" && <label className="text-xs sm:col-span-2"><span className="mb-1 block text-muted-foreground">{t.identityProvider}</span><input className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-[16px] md:text-xs" value={identityProvider} onChange={(event) => setIdentityProvider(event.target.value)} /></label>}
            {needsVerification && <div className="space-y-2 rounded-md border border-border p-2 sm:col-span-2">
              <p className="text-xs text-muted-foreground">{t.verificationHelp}</p>
              <label className="block text-xs"><span>{t.verificationKeyId}</span><input className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-[16px] md:text-xs" value={verificationKeyId} onChange={(event) => setVerificationKeyId(event.target.value)} /></label>
              <label className="block text-xs"><span>{t.verificationPublicKey}</span><input className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-[16px] md:text-xs" value={verificationPublicKey} onChange={(event) => setVerificationPublicKey(event.target.value)} /></label>
              <label className="block text-xs"><span>{t.verificationMaxAge}</span><input type="number" min={1} max={86400} className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-[16px] md:text-xs" value={verificationMaxAge} onChange={(event) => setVerificationMaxAge(event.target.value)} /></label>
              <label className="flex items-start gap-2 text-xs"><input type="checkbox" checked={verificationAcknowledged} onChange={(event) => setVerificationAcknowledged(event.target.checked)} /><span>{t.verificationAcknowledgement}</span></label>
            </div>}
            <label className="text-xs sm:col-span-2"><span className="mb-1 block text-muted-foreground">{t.fieldSchema}</span><textarea rows={9} spellCheck={false} className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[16px] md:text-[11px]" value={schemaText} onChange={(event) => setSchemaText(event.target.value)} /></label>
          </div>
          <label className="mt-2 block text-xs"><span className="mb-1 block text-muted-foreground">{t.consentMappings}</span><textarea aria-label={t.consentMappings} rows={4} spellCheck={false} className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 font-mono text-[16px] md:text-[11px]" value={consentMappingsText} onChange={(event) => setConsentMappingsText(event.target.value)} /></label>
          <p className="text-[11px] text-muted-foreground">{t.consentMappingsHelp}</p>
          <Button className="mt-2" size="sm" disabled={busy || !definitionLabel.trim() || !definitionKey.trim() || (needsVerification && (!verificationAcknowledged || !verificationKeyId.trim() || !verificationPublicKey.trim() || !verificationMaxAge))} onClick={() => void createDefinition()}><Plus aria-hidden />{editingDefinition ? t.saveDefinitionVersion : t.createDefinition}</Button>
          {editingDefinition && <Button className="ml-2 mt-2" size="sm" variant="ghost" disabled={busy} onClick={() => selectDefinition(null)}>{t.cancel}</Button>}
          <div className="mt-3 space-y-2">
            {definitions.map((definition) => <div key={definition.id} className="rounded-lg bg-muted/30 px-3 py-2 text-xs"><div className="font-medium">{definition.label}</div><div className="font-mono text-[10px] text-muted-foreground">{definition.definitionKey} · v{definition.currentVersion}</div>{!unverifiedPolicy(definition.identityPolicy) && (!definition.identityVerification || !definition.verificationAcknowledgedByUserId) && <p className="mt-1 text-amber-600">{t.verificationUnconfigured}</p>}<Button size="xs" variant="outline" disabled={busy} onClick={() => selectDefinition(definition)}>{t.editDefinition}</Button></div>)}
            {definitions.length === 0 && <div className="text-xs text-muted-foreground">{t.noDefinitions}</div>}
          </div>
        </div>

        <div className="rounded-xl border border-border p-3">
          <h4 className="text-xs font-semibold">{t.credentials}</h4>
          <p className="mt-1 text-[11px] text-muted-foreground">{t.credentialsHelp}</p>
          {oneTimeKey && <div className="mt-3 rounded-lg border border-amber-500/30 bg-amber-500/10 p-3"><div className="text-xs font-medium">{t.copyNow}</div><div className="mt-2 break-all rounded bg-background p-2 font-mono text-[11px]">{oneTimeKey}</div><Button className="mt-2" size="xs" variant="outline" onClick={() => void navigator.clipboard.writeText(oneTimeKey).then(() => setCopied(true))}>{copied ? <Check aria-hidden /> : <Copy aria-hidden />}{copied ? t.copied : t.copy}</Button></div>}
          <div className="mt-3 grid gap-2">
            <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.credentialLabel}</span><input className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-[16px] md:text-xs" value={credentialLabel} onChange={(event) => setCredentialLabel(event.target.value)} /></label>
            <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.boundDefinition}</span>
              <Select value={credentialDefinitionId} onValueChange={(value) => setCredentialDefinitionId(value ?? "")}>
                <SelectTrigger className="w-full"><SelectValue placeholder={t.pickDefinition} /></SelectTrigger>
                <SelectContent>{definitions.filter((item) => item.active).map((definition) => <SelectItem key={definition.id} value={definition.id}>{definition.label}</SelectItem>)}</SelectContent>
              </Select>
            </label>
          </div>
          <Button className="mt-2" size="sm" disabled={busy || !credentialLabel.trim() || !credentialDefinitionId} onClick={() => void createCredential()}><Plus aria-hidden />{t.createCredential}</Button>
          <div className="mt-3 space-y-2">
            {credentials.map((credential) => <div key={credential.id} className="flex items-center justify-between gap-3 rounded-lg bg-muted/30 px-3 py-2 text-xs"><div><div className="font-medium">{credential.label}</div><div className="break-all font-mono text-[10px] text-muted-foreground">{credential.prefix} · {credential.revokedAt ? t.revoked : t.active}</div></div><Button size="xs" variant="outline" disabled={busy} onClick={() => void rotate(credential)}>{t.rotateCredential}</Button>{!credential.revokedAt && <Button size="icon-xs" variant="ghost" className="max-md:size-9" aria-label={t.revoke} disabled={busy} onClick={() => void revoke(credential)}><RotateCcw aria-hidden /></Button>}</div>)}
            {credentials.length === 0 && <div className="text-xs text-muted-foreground">{t.noCredentials}</div>}
          </div>
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-border p-3">
        <h4 className="text-xs font-semibold">{t.purposes}</h4>
        <p className="mt-1 text-[11px] text-muted-foreground">{t.purposesHelp}</p>
        <p className="mt-1 text-[11px] text-muted-foreground">{t.wordingImmutableHelp}</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-3">
          <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.purposeLabel}</span><input className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-[16px] md:text-xs" value={purposeLabel} onChange={(event) => { setPurposeLabel(event.target.value); if (!purposeKey) setPurposeKey(stableKey(event.target.value)); }} /></label>
          <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.purposeKey}</span><input className="h-9 w-full rounded-md border border-input bg-transparent px-3 font-mono text-[16px] md:text-xs" disabled={Boolean(editingPurpose)} value={purposeKey} onChange={(event) => setPurposeKey(stableKey(event.target.value))} /></label>
          <label className="text-xs"><span className="mb-1 block text-muted-foreground">{t.wordingVersion}</span><input className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-[16px] md:text-xs" value={wordingVersion} onChange={(event) => setWordingVersion(event.target.value)} /></label>
          <label className="text-xs sm:col-span-3"><span className="mb-1 block text-muted-foreground">{t.wording}</span><textarea rows={3} className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-[16px] md:text-xs" value={wording} onChange={(event) => setWording(event.target.value)} /></label>
          <div className="text-xs"><span className="mb-1 block text-muted-foreground">{t.wordingDefaultLocale}</span>
            <Select value={defaultLocale} onValueChange={(value) => setDefaultLocale((value ?? "default") as typeof defaultLocale)}>
              <SelectTrigger aria-label={t.wordingDefaultLocale}><SelectValue /></SelectTrigger><SelectContent>
                <SelectItem value="default">{t.wordingCombined}</SelectItem>
                {LOCALES.map((locale) => <SelectItem key={locale} value={locale}>{LOCALE_LABELS[locale]}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>
          <div className="sm:col-span-3 grid gap-2 sm:grid-cols-2">{LOCALES.map((locale) => <label key={locale} className="text-xs"><span className="mb-1 block text-muted-foreground">{t.wordingTranslation} ({LOCALE_LABELS[locale]})</span><textarea aria-label={`${t.wordingTranslation} (${LOCALE_LABELS[locale]})`} rows={2} maxLength={20000} className="w-full resize-y rounded-md border border-input bg-transparent px-3 py-2 text-[16px] md:text-xs" value={localeWordings[locale] ?? ""} onChange={(event) => setLocaleWordings((current) => ({ ...current, [locale]: event.target.value }))} /></label>)}</div>
          <div className="sm:col-span-3"><div className="mb-1 text-xs text-muted-foreground">{t.channels}</div><div className="flex flex-wrap gap-1">{(["email", "sms", "phone", "whatsapp", "telegram", "slack"] as const).map((channel) => <Button key={channel} type="button" size="xs" variant={purposeChannels.includes(channel) ? "secondary" : "outline"} aria-pressed={purposeChannels.includes(channel)} onClick={() => setPurposeChannels((current) => current.includes(channel) ? current.filter((item) => item !== channel) : [...current, channel])}>{t.channelLabels[channel]}</Button>)}</div></div>
        </div>
        <Button className="mt-2" size="sm" disabled={busy || !purposeLabel.trim() || !purposeKey.trim() || !wording.trim() || purposeChannels.length === 0} onClick={() => void createPurpose()}><Plus aria-hidden />{editingPurpose ? t.saveWordingVersion : t.createPurpose}</Button>
        {editingPurpose && <Button className="mt-2 ml-2" size="sm" variant="outline" disabled={busy} onClick={() => selectPurpose(null)}>{t.cancel}</Button>}
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          {purposes.map((purpose) => <div key={purpose.id} className="rounded-lg bg-muted/30 px-3 py-2 text-xs"><div className="flex items-center justify-between gap-2"><span className="font-medium">{purpose.label}</span><Button size="xs" variant="outline" disabled={busy} onClick={() => selectPurpose(purpose)}>{t.editWording}</Button></div><div className="font-mono text-[10px] text-muted-foreground">{purpose.purposeKey} · {purpose.wordingVersion} · {purpose.archivedAt ? t.archived : purpose.applicableChannels.map((channel) => t.channelLabels[channel]).join(", ")}</div></div>)}
          {purposes.length === 0 && <div className="text-xs text-muted-foreground">{t.noPurposes}</div>}
        </div>
      </div>
      <CrmOperationsAuditView workspaceId={workspaceId} />
      <CrmPrivacyPolicySettings key={workspaceId} workspaceId={workspaceId} />
    </section>
  );
}
