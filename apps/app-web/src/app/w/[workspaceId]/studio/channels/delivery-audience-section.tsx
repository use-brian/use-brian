"use client";

import { useEffect, useId, useRef, useState } from "react";
import { X } from "lucide-react";
import { useT, useLocale } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { ChannelConfigUpdateError, updateChannelConfig, type Channel, type DeliveryAudienceBindingInput } from "@/lib/api/channels";

import { SearchableSelect, type SearchableSelectItem } from "@/components/ui/searchable-select";
import { listContextProjects } from "@/lib/api/context-scopes";
import { fetchDepartments } from "@/lib/api/departments";
import { format } from "@/lib/i18n/format";
import { listChannelDestinations, listWorkspaceMemberOptions } from "@/lib/api/workflow";

type Draft = {
  identity: string;
  session: number;
  index: number | null;
  baseline: string;
  channelId: string;
  audienceType: "group" | "individual";
  clearance: "public" | "internal" | "confidential";
  /** Department keys (`team:<id>`): the only labels the v2 read honours. */
  compartments: string[];
  /** Group only: replaces the department and project lists with no cap. */
  companyWide: boolean;
  projects: string;
  recipient: string;
  expires: string;
};
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const list = (value: string) => [...new Set(value.split(",").map((v) => v.trim()).filter(Boolean))];
const buttonClass = "min-h-8 max-sm:min-h-11 rounded-md border border-border px-3 text-sm disabled:opacity-50";
const inputClass = "min-h-8 max-sm:min-h-11 w-full min-w-0 rounded-md border border-input bg-background px-3 text-base md:text-sm";

/** Strip server-owned metadata: the config endpoint validates entries strictly. */
function toInput(binding: DeliveryAudienceBindingInput): DeliveryAudienceBindingInput {
  return {
    channelId: binding.channelId, audienceType: binding.audienceType,
    clearance: binding.clearance, compartments: binding.compartments,
    projectIds: binding.projectIds, recipientUserId: binding.recipientUserId ?? null,
    expiresAt: binding.expiresAt ?? null,
    ...(binding.companyWide ? { companyWide: true } : {}),
  };
}

export function DeliveryAudienceSection({ workspaceId, channel, canManage, onUpdated }: {
  workspaceId: string;
  channel: Channel;
  canManage: boolean;
  onUpdated: (channel: Channel) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const copy = t.studioPage.channels.deliveryAudience;
  const id = useId();
  const bindings = channel.config?.deliveryAudienceBindings ?? [];
  const fingerprint = JSON.stringify(bindings);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<"invalid" | "saveError" | "changed" | "permissionError" | "signInError" | "missingIntegration" | null>(null);
  const [invalidFields, setInvalidFields] = useState<string[]>([]);
  const [saved, setSaved] = useState(false);
  const locked = useRef(false);
  const identity = JSON.stringify([workspaceId, channel.id, channel.integrationId, channel.channelType]);
  const session = useRef(0);
  const [options, setOptions] = useState<{ destinations: SearchableSelectItem[]; projects: SearchableSelectItem[]; members: SearchableSelectItem[]; failed: boolean }>({ destinations: [], projects: [], members: [], failed: false });
  // Departments the viewer is in, keyed the way a binding stores them.
  const [departments, setDepartments] = useState<SearchableSelectItem[]>([]);
  useEffect(() => {
    let cancelled = false;
    fetchDepartments(workspaceId).then((result) => {
      if (cancelled) return;
      setDepartments((Array.isArray(result?.departments) ? result.departments : [])
        .filter((department) => department.myClearance !== null && department.status === "active")
        .map((department) => ({ value: `team:${department.departmentId}`, label: department.name })));
    }).catch(() => { if (!cancelled) setDepartments([]); });
    return () => { cancelled = true; };
  }, [workspaceId]);
  const departmentName = (departmentKey: string) => departments.find((item) => item.value === departmentKey)?.label ?? copy.unknownDepartment;
  const editorSession = draft?.session;
  const editorIdentity = draft?.identity;
  useEffect(() => {
    if (!editorSession || editorIdentity !== identity || !canManage) return;
    let cancelled = false;
    setOptions({ destinations: [], projects: [], members: [], failed: false });
    const load = async () => {
      const results = await Promise.allSettled([
        listChannelDestinations(workspaceId, { throwOnError: true }), listContextProjects(workspaceId),
        listWorkspaceMemberOptions(workspaceId, { throwOnError: true }),
      ]);
      if (cancelled) return;
      const [destinations, projects, members] = results;
      setOptions({
        destinations: destinations.status === "fulfilled" ? destinations.value
          .filter((item) => Boolean(channel.integrationId) && item.channelIntegrationId === channel.integrationId && item.channelType === channel.channelType)
          .map((item) => ({ value: item.channelId, label: item.title || item.channelId, hint: item.channelId })) : [],
        projects: projects.status === "fulfilled" ? projects.value.map((item) => ({ value: item.id, label: item.name, hint: item.id })) : [],
        members: members.status === "fulfilled" ? members.value.map((item) => ({ value: item.id, label: item.label, hint: item.id })) : [],
        failed: results.some((result) => result.status === "rejected"),
      });
    };
    void load();
    return () => { cancelled = true; };
  }, [editorSession, editorIdentity, identity, canManage, workspaceId, channel.integrationId, channel.channelType]);
  const destinations = new Map(options.destinations.map((item) => [item.value, item]));
  for (const chat of channel.config?.seenChats ?? []) {
    destinations.set(chat.chatId, { value: chat.chatId, label: chat.chatTitle || chat.chatId, hint: chat.chatId });
    if (channel.channelType === "telegram") for (const topic of chat.topics ?? []) {
      const value = `${chat.chatId}:topic:${topic.topicId}`;
      destinations.set(value, { value, label: `${chat.chatTitle || chat.chatId} / ${topic.name || topic.topicId}`, hint: value });
    }
  }
  // Recheck after confirmation, including role revocation and live refreshes.
  const latest = useRef({ fingerprint, canManage, identity });
  latest.current = { fingerprint, canManage, identity };

  function open(index: number | null, channelId = "") {
    const binding = index === null ? null : bindings[index];
    setDraft({ identity, session: ++session.current, index, baseline: fingerprint, channelId: binding?.channelId ?? channelId,
      audienceType: binding?.audienceType ?? "group", clearance: binding?.clearance ?? "public",
      // Only department keys are honoured since the v2 cutover; any other
      // label on an older approval is dropped when it is next saved.
      compartments: (binding?.compartments ?? []).filter((value) => value.startsWith("team:")), projects: binding?.projectIds.join(", ") ?? "",
      companyWide: binding?.companyWide === true && binding.audienceType === "group",
      recipient: binding?.recipientUserId ?? "", expires: binding?.expiresAt ?? "" });
    setError(null);
    setInvalidFields([]);
    setSaved(false);
  }

  async function persist(next: DeliveryAudienceBindingInput[], baseline: string, removing: boolean) {
    if (!canManage || locked.current) return;
    if ((baseline !== latest.current.fingerprint || identity !== latest.current.identity)) { setError("changed"); return; }
    locked.current = true;
    setBusy(true);
    setError(null);
    setInvalidFields([]);
    setSaved(false);
    try {
      const confirmed = await confirmDialog({
        title: removing ? copy.removeTitle : copy.confirmTitle,
        description: removing ? copy.removeDescription : copy.confirmDescription,
        confirmLabel: removing ? copy.removeAction : copy.confirmAction,
        cancelLabel: copy.cancel,
      });
      if (!confirmed) return;
      if (!latest.current.canManage || (baseline !== latest.current.fingerprint || identity !== latest.current.identity)) {
        setError("changed");
        return;
      }
      const updated = await updateChannelConfig(workspaceId, channel.id, { deliveryAudienceBindings: next });
      onUpdated(updated);
      setDraft(null);
      setSaved(true);
    } catch (failure) {
      if (failure instanceof ChannelConfigUpdateError) {
        setError(failure.status === 401 ? "signInError" : failure.status === 403 ? "permissionError"
          : failure.status === 404 ? "missingIntegration" : failure.status === 400 ? "invalid" : "saveError");
        const labels: Record<string, string> = { channelId: copy.destination, audienceType: copy.audienceType,
          clearance: copy.clearance, compartments: copy.compartments, projectIds: copy.projects,
          recipientUserId: copy.recipient, expiresAt: copy.expires };
        setInvalidFields(failure.fields.flatMap((key) => labels[key] ? [labels[key]] : []));
      } else setError("saveError");
    } finally {
      locked.current = false;
      setBusy(false);
    }
  }

  function save() {
    if (!draft) return;
    const channelId = draft.channelId.trim();
    const companyWide = draft.companyWide && draft.audienceType === "group";
    const compartments = companyWide ? [] : [...new Set(draft.compartments)];
    const projectIds = companyWide ? [] : list(draft.projects);
    const recipientUserId = draft.audienceType === "individual" ? draft.recipient.trim() || null : null;
    const expires = draft.expires.trim();
    const expiry = expires ? Date.parse(expires) : null;
    const telegramId = channelId.match(/^(-?\d+)(?::(?:topic:\d+|discussion:[1-9]\d*))?$/);
    const bareTelegramId = telegramId?.[1] ?? channelId;
    // Match the delivery authorizer's known provider audience types. Do not
    // turn a private broadcast channel into an individual recipient.
    const inferredType = channel.channelType === "telegram" ? (bareTelegramId.startsWith("-") ? "group" : "individual")
      : channel.channelType === "slack" ? (channelId.startsWith("D") ? "individual" : /^[CG]/.test(channelId) ? "group" : null)
        : channel.channelType === "whatsapp" ? (channelId.endsWith("@g.us") ? "group"
          : channelId.endsWith("@s.whatsapp.net") || /^\+?\d{8,15}$/.test(channelId) ? "individual" : null) : null;
    // The backend currently uses first-match exact-or-bare resolution. Do not
    // advertise an independent topic restriction that a bare approval shadows.
    const overlaps = channel.channelType === "telegram" && bindings.some((binding, index) => {
      if (index === draft.index) return false;
      const otherBare = binding.channelId.split(":")[0];
      return bareTelegramId === otherBare && (channelId === bareTelegramId || binding.channelId === otherBare);
    });
    if (!channelId || channelId.length > 256
      || bindings.some((binding, index) => index !== draft.index && binding.channelId === channelId)
      || (draft.index === null && bindings.length >= 500)
      || compartments.length > 100 || compartments.some((key) => key.length > 128 || !key.startsWith("team:"))
      || projectIds.length > 100 || projectIds.some((value) => !uuid.test(value))
      || (recipientUserId !== null && !uuid.test(recipientUserId))
      || (expires && (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(expires)
        || !/(Z|[+-]\d{2}:\d{2})$/i.test(expires) || !Number.isFinite(expiry) || expiry! <= Date.now()))
      || (channel.channelType === "telegram" && !telegramId)
      || overlaps || (inferredType !== null && inferredType !== draft.audienceType)) {
      setError("invalid");
      return;
    }
    const binding: DeliveryAudienceBindingInput = { channelId, audienceType: draft.audienceType,
      clearance: draft.clearance, compartments, projectIds, recipientUserId,
      expiresAt: expiry === null ? null : new Date(expiry).toISOString(),
      ...(companyWide ? { companyWide: true } : {}) };
    const next = bindings.map(toInput);
    if (draft.index === null) next.push(binding);
    else next[draft.index] = binding;
    void persist(next, draft.baseline, false);
  }

  const stale = draft !== null && (draft.baseline !== fingerprint || draft.identity !== identity);
  function field(key: "channelId" | "projects" | "recipient" | "expires", label: string, hint: string) {
    return <div className="space-y-1">
      <label htmlFor={`${id}-${key}`} className="text-sm font-medium">{label}</label>
      <input id={`${id}-${key}`} aria-describedby={`${id}-${key}-hint`} className={inputClass}
        value={draft?.[key] ?? ""} disabled={busy || stale}
        onChange={(event) => setDraft((current) => current && ({ ...current, [key]: event.target.value }))} />
      <p id={`${id}-${key}-hint`} className="text-xs text-muted-foreground">{hint}</p>
    </div>;
  }

  function picker(label: string, value: string, items: SearchableSelectItem[], onValueChange: (value: string) => void) {
    return <SearchableSelect aria-label={label} placeholder={label} searchPlaceholder={copy.search}
      emptyMessage={copy.noOptions} value={value} items={items} onValueChange={onValueChange} disabled={busy || stale} />;
  }

  const unapproved = channel.channelType === "telegram" ? (channel.config?.seenChats ?? []).filter((chat) =>
    (chat.chatType === "group" || chat.chatId.startsWith("-")) && !bindings.some((binding) => binding.channelId.split(":")[0] === chat.chatId)) : [];
  const names = [...bindings.map((binding) => destinations.get(binding.channelId)?.label ?? binding.channelId), ...unapproved.map((chat) => chat.chatTitle || chat.chatId)];
  const duplicateNames = new Set(names.filter((name, index) => names.indexOf(name) !== index));
  const dateLabel = (value: string) => Number.isFinite(Date.parse(value))
    ? new Intl.DateTimeFormat(locale, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value)) : value;
  const editor = canManage && draft ? <form className="space-y-4 rounded-lg bg-muted/30 p-4" onSubmit={(event) => { event.preventDefault(); save(); }}>
      {options.failed && <p role="status" className="text-sm text-muted-foreground">{copy.optionsError}</p>}
      {picker(copy.chooseDestination, draft.channelId, [...destinations.values()], (value) => {
        if (!value) return;
        const bare = value.split(":")[0];
        const audienceType = channel.channelType === "telegram" ? (bare.startsWith("-") ? "group" : "individual")
          : channel.channelType === "slack" ? (value.startsWith("D") ? "individual" : "group")
          : channel.channelType === "whatsapp" ? (value.endsWith("@g.us") ? "group" : "individual") : draft.audienceType;
        setDraft({ ...draft, channelId: value, audienceType, recipient: audienceType === "group" ? "" : draft.recipient, companyWide: audienceType === "group" && draft.companyWide });
      })}
      <details className="text-sm"><summary className="min-h-8 max-sm:min-h-11 cursor-pointer py-2 text-muted-foreground">{copy.advanced}</summary>
        {field("channelId", copy.destination, copy.destinationHint)}
      </details>
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1">
          <label id={`${id}-type`} className="text-sm font-medium">{copy.audienceType}</label>
          <Select value={draft.audienceType} disabled={busy || stale} onValueChange={(value) => {
            if (value === "group" || value === "individual") setDraft({ ...draft, audienceType: value, recipient: value === "group" ? "" : draft.recipient, companyWide: value === "group" && draft.companyWide });
          }}>
            <SelectTrigger aria-labelledby={`${id}-type`} className="max-sm:min-h-11 w-full"><SelectValue>{draft.audienceType === "group" ? copy.group : copy.individual}</SelectValue></SelectTrigger>
            <SelectContent><SelectItem value="group">{copy.group}</SelectItem><SelectItem value="individual">{copy.individual}</SelectItem></SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <label id={`${id}-clearance`} className="text-sm font-medium">{copy.clearance}</label>
          <Select value={draft.clearance} disabled={busy || stale} onValueChange={(value) => {
            if (value === "public" || value === "internal" || value === "confidential") setDraft({ ...draft, clearance: value });
          }}>
            <SelectTrigger aria-labelledby={`${id}-clearance`} className="max-sm:min-h-11 w-full"><SelectValue>{t.studioPage.channels.clearance[draft.clearance]}</SelectValue></SelectTrigger>
            <SelectContent>{(["public", "internal", "confidential"] as const).map((value) => <SelectItem key={value} value={value}>{t.studioPage.channels.clearance[value]}</SelectItem>)}</SelectContent>
          </Select>
        </div>
      </div>
      <p className="text-sm text-muted-foreground">{copy.sensitivityHelp}</p>
      {draft.audienceType === "group" && <div className="flex items-start gap-3">
        <Switch id={`${id}-company-wide`} aria-describedby={`${id}-company-wide-hint`} checked={draft.companyWide}
          disabled={busy || stale} className="mt-0.5"
          onCheckedChange={(checked) => setDraft({ ...draft, companyWide: checked })} />
        <div className="space-y-1">
          <label htmlFor={`${id}-company-wide`} className="text-sm font-medium">{copy.wholeCompany}</label>
          <p id={`${id}-company-wide-hint`} className="text-xs text-muted-foreground">{copy.wholeCompanyHint}</p>
        </div>
      </div>}
      {!(draft.companyWide && draft.audienceType === "group") && <details open={draft.compartments.length > 0 || Boolean(draft.projects)} className="space-y-3 text-sm">
      <summary className="min-h-8 max-sm:min-h-11 cursor-pointer py-2">{copy.scopedLimits}</summary>
      <div className="space-y-2">
        <p id={`${id}-departments`} className="text-sm font-medium">{copy.compartments}</p>
        {draft.compartments.length > 0 ? <ul aria-labelledby={`${id}-departments`} className="flex flex-wrap gap-2">
          {draft.compartments.map((departmentKey) => {
            const name = departmentName(departmentKey);
            return <li key={departmentKey} className="inline-flex min-h-8 max-sm:min-h-11 items-center gap-1 rounded-full border border-border bg-muted/40 pl-3 pr-1 text-sm">
              {name}
              <button type="button" aria-label={format(copy.removeDepartment, { name })} disabled={busy || stale}
                className="inline-flex size-9 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
                onClick={() => setDraft({ ...draft, compartments: draft.compartments.filter((value) => value !== departmentKey) })}>
                <X className="size-3.5" aria-hidden />
              </button>
            </li>;
          })}
        </ul> : <p className="text-sm text-muted-foreground">{copy.generalOnly}</p>}
        {picker(copy.chooseDepartment, "", departments.filter((item) => !draft.compartments.includes(item.value)), (value) => {
          if (value) setDraft({ ...draft, compartments: [...new Set([...draft.compartments, value])] });
        })}
        <p className="text-xs text-muted-foreground">{copy.compartmentsHint}</p>
      </div>
      {picker(copy.chooseProject, "", options.projects, (value) => {
        if (value) setDraft({ ...draft, projects: [...new Set([...list(draft.projects), value])].join(", ") });
      })}
      {field("projects", copy.projects, copy.projectsHint)}
      </details>}
      {draft.audienceType === "individual" && picker(copy.chooseMember, draft.recipient, options.members, (value) => {
        if (value) setDraft({ ...draft, recipient: value });
      })}
      {draft.audienceType === "individual" && field("recipient", copy.recipient, copy.recipientHint)}
      <details className="text-sm"><summary className="min-h-8 max-sm:min-h-11 cursor-pointer py-2 text-muted-foreground">{copy.expirySettings}</summary>
        {field("expires", copy.expires, copy.expiresHint)}
      </details>
      <div className="flex flex-wrap gap-2">
        <button type="submit" className={buttonClass} disabled={busy || stale}>{busy ? copy.saving : copy.save}</button>
        <button type="button" className={buttonClass} disabled={busy} onClick={() => { setDraft(null); setError(null); }}>{copy.cancel}</button>
      </div>
    </form> : null;

  return <section aria-labelledby={`${id}-title`} className="space-y-4">
    <div className="space-y-2">
      <h3 id={`${id}-title`} className="text-sm font-medium">{copy.title}</h3>
      <p className="text-sm text-muted-foreground">{copy.description}</p>
      <p className="text-xs text-muted-foreground">{copy.privateWarning}</p>
      {!canManage && <p className="text-sm text-muted-foreground">{copy.adminOnly}</p>}
    </div>
    {bindings.length === 0 && unapproved.length === 0 && <p className="text-sm text-muted-foreground">{copy.empty}</p>}
    <ul className="grid gap-3">
      {bindings.map((binding, index) => {
        const expired = Boolean(binding.expiresAt && Date.parse(binding.expiresAt) <= Date.now());
        const name = destinations.get(binding.channelId)?.label ?? binding.channelId;
        return <li key={`${binding.channelId}-${index}`} className="min-w-0 space-y-3 rounded-lg border border-border p-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-semibold">{name}</p>
              {duplicateNames.has(name) && <p className="break-all text-xs text-muted-foreground">{binding.channelId}</p>}
              <p className="mt-1 text-xs text-muted-foreground">{binding.companyWide ? copy.wholeCompany : binding.compartments.some((value) => value.startsWith("team:")) ? binding.compartments.filter((value) => value.startsWith("team:")).map(departmentName).join(", ") : copy.generalOnly}</p>
            </div>
            <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${expired ? "bg-amber-500/10 text-amber-700 dark:text-amber-300" : "bg-muted text-foreground"}`}>
              {expired ? copy.expired : t.studioPage.channels.clearance[binding.clearance]}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">{expired ? copy.expiredHelp : binding.audienceType === "individual" ? copy.individualHelp : binding.companyWide ? copy.connectedAvailable : copy.searchAvailable}</p>
          {canManage && <div className="flex flex-wrap gap-2">
            <button type="button" className={buttonClass} disabled={busy || draft !== null} onClick={() => open(index)}>{copy.edit}</button>
            <button type="button" className={buttonClass} disabled={busy || draft !== null}
              onClick={() => void persist(bindings.filter((_, i) => i !== index).map(toInput), fingerprint, true)}>{copy.remove}</button>
          </div>}
          <details className="text-xs text-muted-foreground">
            <summary className="min-h-8 max-sm:min-h-11 cursor-pointer py-2">{copy.details}</summary>
            <dl className="grid gap-2 break-words sm:grid-cols-2">
              <div><dt>{copy.destination}</dt><dd className="break-all">{binding.channelId}</dd></div>
              <div><dt>{copy.audienceType}</dt><dd>{binding.audienceType === "group" ? copy.group : copy.individual}</dd></div>
              {binding.projectIds.length > 0 && <div><dt>{copy.projects}</dt><dd>{binding.projectIds.join(", ")}</dd></div>}
              {binding.recipientUserId && <div><dt>{copy.recipient}</dt><dd>{binding.recipientUserId}</dd></div>}
              <div><dt>{copy.expires}</dt><dd>{binding.expiresAt ? dateLabel(binding.expiresAt) : copy.noExpiry}</dd></div>
              <div><dt>{copy.approvedBy}</dt><dd>{options.members.find((member) => member.value === binding.approvedByUserId)?.label ?? binding.approvedByUserId}</dd></div>
              <div><dt>{copy.approvedAt}</dt><dd><time dateTime={binding.approvedAt}>{dateLabel(binding.approvedAt)}</time></dd></div>
            </dl>
          </details>
          {!stale && draft?.index === index && editor}
        </li>;
      })}
      {unapproved.map((chat) => <li key={chat.chatId} className="min-w-0 space-y-3 rounded-lg border border-dashed border-border p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1"><p className="break-words text-sm font-semibold">{chat.chatTitle || chat.chatId}</p>
            {duplicateNames.has(chat.chatTitle || chat.chatId) && <p className="break-all text-xs text-muted-foreground">{chat.chatId}</p>}
          </div>
          <span className="rounded-full bg-muted px-2.5 py-1 text-xs font-medium">{copy.conversationOnly}</span>
        </div>
        <p className="text-sm text-muted-foreground">{copy.unapprovedHelp}</p>
        {canManage && <button type="button" className={buttonClass} disabled={busy || draft !== null} onClick={() => open(null, chat.chatId)}>{copy.approve}</button>}
        {!stale && draft?.index === null && draft.channelId === chat.chatId && editor}
      </li>)}
    </ul>
    {canManage && <button type="button" className={buttonClass} disabled={busy || draft !== null || bindings.length >= 500} onClick={() => open(null)}>{copy.add}</button>}
    {(stale || (draft?.index === null && !unapproved.some((chat) => chat.chatId === draft.channelId))) && editor}
    {(error || stale) && <p role="alert" className="text-sm text-destructive">{copy[stale ? "changed" : error!]}{!stale && invalidFields.length > 0 ? ` (${invalidFields.join(", ")})` : ""}</p>}
    {saved && <p role="status" className="text-sm text-muted-foreground">{copy.saved}</p>}
  </section>;
}
