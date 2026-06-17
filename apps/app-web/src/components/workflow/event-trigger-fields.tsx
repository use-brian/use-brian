"use client";

/**
 * Event trigger fields (app-web) — source picker (connector instance /
 * channel integration) plus a `match` form per source. A workflow can
 * subscribe to multiple sources in one trigger; each row is its own
 * collapsible `(source, match)` subscription.
 *
 * Ported from `apps/web/src/components/workflow/event-trigger-fields.tsx`
 * (app consolidation §5a). The dispatcher
 * (`createWorkflowEventDispatcher` in
 * `packages/core/src/workflow/event-trigger.ts`) drives a single fire
 * per workflow per event even when several subscriptions match — that's
 * a runtime invariant, not something this editor needs to model.
 *
 * Spec: docs/architecture/features/workflow.md → Event trigger UI.
 * [COMP:app-web/workflow]
 */

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { format as fmt } from "@/lib/i18n";
import type {
  EventMatch,
  EventSubscription,
  WorkflowTrigger,
  WorkspaceChannelOption,
  WorkspaceConnectorOption,
} from "@/lib/api/workflow";
import {
  listWorkspaceChannelOptions,
  listWorkspaceConnectorOptions,
} from "@/lib/api/workflow";
import {
  appendChip,
  MATCH_CAPS,
  type MatchField,
  removeChipAt,
} from "@/lib/workflow-match";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";

type Props = {
  workspaceId: string | null;
  trigger: Extract<WorkflowTrigger, { kind: "event" }>;
  onChange: (next: WorkflowTrigger) => void;
  disabled?: boolean;
};

export function EventTriggerFields({
  workspaceId,
  trigger,
  onChange,
  disabled,
}: Props) {
  const t = useT();
  const [connectors, setConnectors] = useState<WorkspaceConnectorOption[]>([]);
  const [channels, setChannels] = useState<WorkspaceChannelOption[]>([]);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void (async () => {
      const [cList, chList] = await Promise.all([
        listWorkspaceConnectorOptions(workspaceId),
        listWorkspaceChannelOptions(workspaceId),
      ]);
      if (cancelled) return;
      setConnectors(cList);
      setChannels(chList);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const setSources = (sources: EventSubscription[]) =>
    onChange({ ...trigger, event: { sources } });

  const addSource = () => {
    // Default to a connector source if any are connected; otherwise
    // channel; otherwise a placeholder connector that's invalid until
    // the user wires one up.
    const first = connectors.find((c) => c.connected);
    const fallbackChannel = channels[0];
    const newSub: EventSubscription = first
      ? {
          source: {
            type: "connector",
            connectorInstanceId: first.id,
            provider: first.provider,
          },
        }
      : fallbackChannel
        ? {
            source: {
              type: "channel",
              channelIntegrationId: fallbackChannel.id,
              channel: fallbackChannel.channelType,
            },
          }
        : {
            source: {
              type: "connector",
              connectorInstanceId: "",
              provider: "",
            },
          };
    setSources([...trigger.event.sources, newSub]);
  };

  const removeSource = (idx: number) => {
    setSources(trigger.event.sources.filter((_, i) => i !== idx));
  };

  const updateSource = (idx: number, next: EventSubscription) => {
    const list = trigger.event.sources.slice();
    list[idx] = next;
    setSources(list);
  };

  return (
    <div className="ml-6 pl-3 border-l border-border flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <label className="text-xs font-medium text-muted-foreground">
          {t.workflowPage.builder.eventSourcesHeading}
        </label>
        <button
          type="button"
          onClick={addSource}
          disabled={disabled}
          className="text-xs px-2 py-1 rounded border border-border hover:bg-muted disabled:opacity-50"
        >
          {t.workflowPage.builder.eventSourceAddBtn}
        </button>
      </div>

      {trigger.event.sources.length === 0 ? (
        <div className="text-xs text-muted-foreground italic">
          {t.workflowPage.builder.eventSourceEmpty}
        </div>
      ) : (
        <ul className="flex flex-col gap-3">
          {trigger.event.sources.map((sub, idx) => (
            <li
              key={idx}
              className="border border-border rounded-md p-3 bg-muted/30 flex flex-col gap-3"
            >
              <SourceRow
                sub={sub}
                connectors={connectors}
                channels={channels}
                onChange={(next) => updateSource(idx, next)}
                onRemove={() => removeSource(idx)}
                disabled={disabled}
              />
              <MatchEditor
                match={sub.match ?? {}}
                onChange={(next) =>
                  updateSource(idx, {
                    ...sub,
                    match: anyMatchSet(next) ? next : undefined,
                  })
                }
                disabled={disabled}
              />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function anyMatchSet(m: EventMatch): boolean {
  return (
    !!m.keywords?.length ||
    !!m.fromActors?.length ||
    !!m.inChannels?.length ||
    !!m.mentions?.length ||
    m.fromBots === true
  );
}

// ── Source row ────────────────────────────────────────────────────────────

function SourceRow({
  sub,
  connectors,
  channels,
  onChange,
  onRemove,
  disabled,
}: {
  sub: EventSubscription;
  connectors: WorkspaceConnectorOption[];
  channels: WorkspaceChannelOption[];
  onChange: (next: EventSubscription) => void;
  onRemove: () => void;
  disabled?: boolean;
}) {
  const t = useT();
  const kind = sub.source.type;

  const setKind = (next: "connector" | "channel") => {
    if (next === kind) return;
    if (next === "connector") {
      const first = connectors.find((c) => c.connected) ?? connectors[0];
      onChange({
        source: first
          ? {
              type: "connector",
              connectorInstanceId: first.id,
              provider: first.provider,
            }
          : { type: "connector", connectorInstanceId: "", provider: "" },
        match: sub.match,
      });
    } else {
      const first = channels[0];
      onChange({
        source: first
          ? {
              type: "channel",
              channelIntegrationId: first.id,
              channel: first.channelType,
            }
          : { type: "channel", channelIntegrationId: "", channel: "" },
        match: sub.match,
      });
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-medium text-muted-foreground">
          {t.workflowPage.builder.eventSourceKindLabel}
        </span>
        <KindPill
          label={t.workflowPage.builder.eventSourceKindConnector}
          active={kind === "connector"}
          disabled={disabled}
          onClick={() => setKind("connector")}
        />
        <KindPill
          label={t.workflowPage.builder.eventSourceKindChannel}
          active={kind === "channel"}
          disabled={disabled}
          onClick={() => setKind("channel")}
        />
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          className="ml-auto text-xs text-red-600 dark:text-red-400 hover:underline disabled:opacity-50"
        >
          {t.workflowPage.builder.eventSourceRemove}
        </button>
      </div>
      {kind === "connector" ? (
        <ConnectorPicker
          value={
            sub.source.type === "connector"
              ? sub.source.connectorInstanceId
              : ""
          }
          options={connectors}
          onChange={(id, provider) =>
            onChange({
              source: {
                type: "connector",
                connectorInstanceId: id,
                provider,
              },
              match: sub.match,
            })
          }
          disabled={disabled}
        />
      ) : (
        <ChannelPicker
          value={
            sub.source.type === "channel" ? sub.source.channelIntegrationId : ""
          }
          options={channels}
          onChange={(id, channel) =>
            onChange({
              source: {
                type: "channel",
                channelIntegrationId: id,
                channel,
              },
              match: sub.match,
            })
          }
          disabled={disabled}
        />
      )}
    </div>
  );
}

function KindPill({
  label,
  active,
  disabled,
  onClick,
}: {
  label: string;
  active: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "text-xs px-2 py-0.5 rounded border",
        active
          ? "border-primary bg-primary/10 text-primary"
          : "border-border hover:bg-muted text-muted-foreground",
        disabled && "opacity-50",
      )}
    >
      {label}
    </button>
  );
}

function ConnectorPicker({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: WorkspaceConnectorOption[];
  onChange: (id: string, provider: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  if (options.length === 0) {
    return (
      <div className="text-xs text-amber-700 dark:text-amber-400">
        {t.workflowPage.builder.eventSourceNoConnectors}
      </div>
    );
  }
  return (
    <Select
      value={value || undefined}
      onValueChange={(v) => {
        if (!v) return;
        const opt = options.find((o) => o.id === v);
        if (opt) onChange(opt.id, opt.provider);
      }}
      disabled={disabled}
    >
      <SelectTrigger className="w-full max-w-md text-sm">
        <SelectValue placeholder={t.workflowPage.builder.eventSourcePickConnector} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id} disabled={!o.connected}>
            {o.label} ({o.provider})
            {o.connected ? "" : ` ${t.workflowPage.builder.eventSourceNotConnected}`}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function ChannelPicker({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: WorkspaceChannelOption[];
  onChange: (id: string, channel: string) => void;
  disabled?: boolean;
}) {
  const t = useT();
  if (options.length === 0) {
    return (
      <div className="text-xs text-amber-700 dark:text-amber-400">
        {t.workflowPage.builder.eventSourceNoChannels}
      </div>
    );
  }
  return (
    <Select
      value={value || undefined}
      onValueChange={(v) => {
        if (!v) return;
        const opt = options.find((o) => o.id === v);
        if (opt) onChange(opt.id, opt.channelType);
      }}
      disabled={disabled}
    >
      <SelectTrigger className="w-full max-w-md text-sm">
        <SelectValue placeholder={t.workflowPage.builder.eventSourcePickChannel} />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem key={o.id} value={o.id}>
            {o.displayName} ({o.channelType})
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

// ── Match editor ──────────────────────────────────────────────────────────

function MatchEditor({
  match,
  onChange,
  disabled,
}: {
  match: EventMatch;
  onChange: (next: EventMatch) => void;
  disabled?: boolean;
}) {
  const t = useT();
  return (
    <div className="flex flex-col gap-3 pt-1 border-t border-border/60">
      <div>
        <div className="text-xs font-medium text-muted-foreground">
          {t.workflowPage.builder.eventMatchHeading}
        </div>
        <p className="text-[11px] text-muted-foreground/80">
          {t.workflowPage.builder.eventMatchAllHint}
        </p>
      </div>
      <ChipInput
        field="keywords"
        label={t.workflowPage.builder.eventMatchKeywordsLabel}
        hint={t.workflowPage.builder.eventMatchKeywordsHint}
        values={match.keywords ?? []}
        onChange={(next) =>
          onChange({ ...match, keywords: next.length ? next : undefined })
        }
        disabled={disabled}
      />
      <ChipInput
        field="fromActors"
        label={t.workflowPage.builder.eventMatchFromActorsLabel}
        hint={t.workflowPage.builder.eventMatchFromActorsHint}
        values={match.fromActors ?? []}
        onChange={(next) =>
          onChange({ ...match, fromActors: next.length ? next : undefined })
        }
        disabled={disabled}
      />
      <ChipInput
        field="inChannels"
        label={t.workflowPage.builder.eventMatchInChannelsLabel}
        hint={t.workflowPage.builder.eventMatchInChannelsHint}
        values={match.inChannels ?? []}
        onChange={(next) =>
          onChange({ ...match, inChannels: next.length ? next : undefined })
        }
        disabled={disabled}
      />
      <ChipInput
        field="mentions"
        label={t.workflowPage.builder.eventMatchMentionsLabel}
        hint={t.workflowPage.builder.eventMatchMentionsHint}
        values={match.mentions ?? []}
        onChange={(next) =>
          onChange({ ...match, mentions: next.length ? next : undefined })
        }
        disabled={disabled}
      />
      <label className="flex items-start gap-2 text-xs cursor-pointer">
        <input
          type="checkbox"
          checked={match.fromBots === true}
          onChange={(e) =>
            onChange({ ...match, fromBots: e.target.checked || undefined })
          }
          disabled={disabled}
          className="mt-0.5 accent-primary"
        />
        <span>
          <span className="font-medium">
            {t.workflowPage.builder.eventMatchFromBotsLabel}
          </span>
          <br />
          <span className="text-muted-foreground">
            {t.workflowPage.builder.eventMatchFromBotsHint}
          </span>
        </span>
      </label>
    </div>
  );
}

function ChipInput({
  field,
  label,
  hint,
  values,
  onChange,
  disabled,
}: {
  field: MatchField;
  label: string;
  hint: string;
  values: string[];
  onChange: (next: string[]) => void;
  disabled?: boolean;
}) {
  const t = useT();
  const [draft, setDraft] = useState("");
  const cap = MATCH_CAPS[field];
  const atCap = values.length >= cap;

  const commit = () => {
    const next = appendChip(values, draft, field);
    if (next !== values) onChange(next);
    setDraft("");
  };

  return (
    <div className="flex flex-col gap-1">
      <label className="text-xs font-medium text-muted-foreground">
        {label}
      </label>
      <p className="text-[11px] text-muted-foreground/80">{hint}</p>
      {values.length > 0 && (
        <ul className="flex flex-wrap gap-1">
          {values.map((v, idx) => (
            <li
              key={`${v}-${idx}`}
              className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-primary/10 text-primary border border-primary/20"
            >
              <span className="font-mono">{v}</span>
              <button
                type="button"
                onClick={() => onChange(removeChipAt(values, idx))}
                disabled={disabled}
                aria-label={t.workflowPage.builder.eventMatchChipRemove}
                className="text-primary/70 hover:text-primary disabled:opacity-50"
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
      <input
        type="text"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (
            e.key === "Backspace" &&
            draft === "" &&
            values.length > 0
          ) {
            onChange(values.slice(0, -1));
          }
        }}
        onBlur={() => {
          if (draft.trim()) commit();
        }}
        placeholder={
          atCap
            ? fmt(t.workflowPage.builder.eventMatchCapReached, { cap })
            : t.workflowPage.builder.eventMatchChipPlaceholder
        }
        disabled={disabled || atCap}
        className="px-3 py-1.5 bg-background border border-border rounded-md text-sm outline-none focus:ring-2 focus:ring-ring max-w-md disabled:opacity-60"
      />
    </div>
  );
}
