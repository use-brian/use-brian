"use client";

/**
 * Office artifact editor shell. Paints from the surface cache first
 * (instant-navigation contract N1 / N2): the artifact row and the live
 * snapshot are two cache keys fetched in PARALLEL (N7), the chrome paints
 * from the home's list row while both are in flight, and the encrypted
 * offline package is the cold seed for the snapshot when one is present.
 * [COMP:app-web/office-editor-shell] [COMP:app-web/office-surface-cache]
 */
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { APP_LEVEL_ASSISTANT_ID } from "@use-brian/shared";
import { FileCheck2, FileSignature, FileSpreadsheet, FileText, History, ListChecks, MessageSquare, MoreHorizontal, PanelRightClose, PanelRightOpen, Presentation, Redo2, Route, Share2, Sparkles, Undo2 } from "lucide-react";
import type { OfficeCommand } from "@use-brian/office-model";
import { PresenceAvatars } from "@/components/doc/presence-avatars";
import { Skeleton } from "@/components/skeleton";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { OfficeJobActivity } from "./job-activity";
import { DocumentEditor } from "./document-editor";
import { PresentationEditor } from "./presentation-editor";
import { SpreadsheetEditor } from "./spreadsheet-editor";
import { PdfEditor } from "./pdf-editor";
import { PresentationPresenter } from "./presentation-presenter";
import { OfficeComments } from "./comments/office-comments";
import { OfficeSuggestions } from "./suggestions/office-suggestions";
import type { DocumentCommentAnchor, DocumentSuggestionRange } from "./document/comment-anchor";
import { OfficeReview } from "./office-review";
import { OfficeStartRecovery } from "./office-start-recovery";
import { useT } from "@/lib/i18n/client";
import { compileOfficeTemplateDraft, createOfficeComment, detachMissingOfficeComments, getOfficeArtifact, getOfficeSnapshot, initializeOfficeTemplateDraft, isOfficeStartFailed, listOfficeComments, listOfficeSuggestions, OfficeApiError, submitOfficeCommand, syncOfficeOfflineCommands, transitionOfficeLifecycle, waitForOfficeJob, type OfficeArtifact, type OfficeCommentThread, type OfficeFamily, type OfficeLiveSnapshot, type OfficeSuggestion } from "@/lib/office/api";
import { useCollabProvider } from "@/lib/collab/use-collab-provider";
import { usePresence, usePublishPresenceActivity, usePublishPresenceIdentity } from "@/lib/collab/use-presence";
import { getUserInfo } from "@/lib/user";
import { appendOfficeCommand, applyOfficeUpdate, createOfficeUndoManager, officeCommandIds, yDocToSnapshot } from "@use-brian/office-model";
import { useOptionalWorkspaceContext } from "@/lib/workspace-context";
import { appendOfflineCommand, classifyOfficeReconnect, listOfflineJournal, loadOfflinePackage, materializeOfflineRecoverySnapshot, officeOfflineDeviceId, quarantineOfflineWork, removeOfflineJournalEntry, type OfficeOfflineOwner, type LoadedOfficeOfflinePackage, type OfficeOfflineStatus, type OfflineJournalEntry } from "@/lib/office/offline";
import { handleOfficeHistoryShortcut, observeOfficeHistory, observeOfficeHistoryReadiness } from "@/lib/office/editor-history";
import { OfficeTopbar } from "./office-topbar";
import { cn } from "@/lib/utils";
import { TemplateRoutingInspector, type TemplateRoutingInspectorState } from "./template-routing-inspector";
import { chatDockSuppression } from "@/lib/chat-dock-suppress";
import { DockRecorderFallback } from "@/components/chrome/dock-recorder";
import { claimFloatingRecorder } from "@/lib/recorder/floating-recorder-slot";
import { OfficeHistoryControls } from "./office-history-controls";
import { OfficeHistory } from "./history/office-history";
import { OfficeSharing } from "./sharing/office-sharing";
import { ReclassifyContextButton } from "@/components/context/reclassify-context-dialog";
import { invalidateSurfaceCache, readSurfaceCache } from "@/lib/surface-cache";
import { invalidateOfficeList, officeArtifactCacheKey, officeSnapshotCacheKey, officePanelCacheKey, officePanelCachePrefix } from "@/lib/surface-prefetch";
import { officeArtifactFromListCache, useOfficeMetadataResource } from "@/lib/office/surface-cache";
import { officeMetadataRemaining, inheritOfficeMetadata } from "@/lib/office/metadata";
import { isPhoneViewport } from "@/lib/viewport";

const EMPTY_COMMENTS: OfficeCommentThread[] = [];
const EMPTY_SUGGESTIONS: OfficeSuggestion[] = [];

type Panel = "activity" | "comments" | "suggestions" | "history" | "sharing" | "review" | "routing";

function packageLive(pkg: LoadedOfficeOfflinePackage): OfficeLiveSnapshot {
  return { snapshot: pkg.payload.snapshot, seq: pkg.payload.seq, baseVersion: pkg.payload.baseVersion };
}

export function OfficeEditorShell({ workspaceId, artifactId }: { workspaceId: string; artifactId: string }) {
  const workspace = useOptionalWorkspaceContext();
  const viewerId = workspace?.workspaceId === workspaceId ? workspace.me.id : "";
  const previous = useRef({workspaceId, artifactId, viewerId});
  useLayoutEffect(() => {
    const old = previous.current;
    if (old.workspaceId !== workspaceId || old.viewerId !== viewerId) {
      invalidateSurfaceCache(officeArtifactCacheKey(old.workspaceId, old.artifactId, old.viewerId));
      invalidateSurfaceCache(officeSnapshotCacheKey(old.workspaceId, old.artifactId, old.viewerId));
      invalidateSurfaceCache(officePanelCachePrefix(old.workspaceId, old.viewerId));
    }
    previous.current = {workspaceId, artifactId, viewerId};
  }, [workspaceId, artifactId, viewerId]);
  // All local state and callbacks belong to the viewer that opened this artifact.
  return <OfficeArtifactShell key={`${workspaceId}:${viewerId}:${artifactId}`} workspaceId={workspaceId} artifactId={artifactId} viewerId={viewerId} />;
}

function OfficeArtifactShell({ workspaceId, artifactId, viewerId }: { workspaceId: string; artifactId: string; viewerId: string }) {
  const offlineOwner = useMemo<OfficeOfflineOwner>(() => ({workspaceId, userId: viewerId}), [workspaceId, viewerId]);
  const t = useT().office;
  const router = useRouter();
  const templateId = useSearchParams().get("templateId");
  const artifactKey = officeArtifactCacheKey(workspaceId, artifactId, viewerId);
  const snapshotKey = officeSnapshotCacheKey(workspaceId, artifactId, viewerId);
  // An authoritative 401 / 403 / 404 evicts and stops both hooks (key null);
  // it never falls back to a cached or offline copy (N2).
  const [denied, setDenied] = useState(false);
  const [rowHint] = useState(() => officeArtifactFromListCache(workspaceId, artifactId, viewerId) ?? undefined);
  const artifactEntry = useOfficeMetadataResource(denied || !viewerId ? null : artifactKey, viewerId, () => getOfficeArtifact(artifactId), rowHint, true);
  const snapshotEntry = useOfficeMetadataResource(denied || !viewerId ? null : snapshotKey, viewerId, () => getOfficeSnapshot(artifactId));
  const onlineSeen = useRef(false);
  const fullReadSeen = useRef(false);
  if (artifactEntry.data || snapshotEntry.data) onlineSeen.current = true;
  const onlineReady = Boolean(artifactEntry.data && snapshotEntry.data);
  if (onlineReady) fullReadSeen.current = true;
  const lifetime = useRef<symbol | null>(null);
  useLayoutEffect(() => {lifetime.current = Symbol();return () => {lifetime.current = null;};}, []);
  // Full offline mode: the network failed and a pinned package took over.
  const [offline, setOffline] = useState<LoadedOfficeOfflinePackage | null>(null);
  const [offlineLookup, setOfflineLookup] = useState<"idle" | "missing">("idle");
  // Cold seed: the package painted while the network is still in flight.
  const [seed, setSeed] = useState<LoadedOfficeOfflinePackage | null>(null);
  const [liveLocal, setLiveLocal] = useState<{value: OfficeLiveSnapshot; source: OfficeLiveSnapshot} | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [commentAnchor, setCommentAnchor] = useState<DocumentCommentAnchor | null>(null);
  const [suggestionRange, setSuggestionRange] = useState<DocumentSuggestionRange | null>(null);
  const [panel, setPanel] = useState<Panel>("activity");
  // Closed by default on a phone (report B row 13): open, the stacked panel
  // took the editor's height; the collapsed strip reopens it in one tap.
  const [panelOpen, setPanelOpen] = useState(() => !isPhoneViewport());
  const [presentOpen, setPresentOpen] = useState(false);
  const [suggestMode, setSuggestMode] = useState(false);
  const [templateCompileState, setTemplateCompileState] = useState<"idle" | "queued" | "failed">("idle");
  const [cachedUpdate, setCachedUpdate] = useState<Uint8Array | null>(null);
  const [cachedComments, setCachedComments] = useState<OfficeCommentThread[] | null>(null);
  const [queuedCommentThreads, setQueuedCommentThreads] = useState<OfficeCommentThread[]>(EMPTY_COMMENTS);
  const receiveQueuedComments = useCallback((threads: OfficeCommentThread[]) => setQueuedCommentThreads(threads), []);
  const [reconnectStatus, setReconnectStatus] = useState<OfficeOfflineStatus>("synced");
  const [recoveryArtifactId, setRecoveryArtifactId] = useState<string | null>(null);
  const [offlineRecoveryBusy, setOfflineRecoveryBusy] = useState(false);
  const [recoveryState, setRecoveryState] = useState<"idle" | "moving" | "failed">("idle");
  const [templateDraftFailed, setTemplateDraftFailed] = useState(false);
  const [templateRoutingState, setTemplateRoutingState] = useState<TemplateRoutingInspectorState>({ ready: false, dirty: false, saving: false });
  const [historyState, setHistoryState] = useState({ canUndo: false, canRedo: false });
  const editorRootRef = useRef<HTMLElement | null>(null);
  const historyRef = useRef<ReturnType<typeof createOfficeUndoManager> | null>(null);
  const currentHistoryRead = useRef<() => boolean>(() => false);
  const offlineUndoneCommands = useRef(new Map<string, Extract<OfflineJournalEntry, { kind: "command" }>>());
  const offlineHistoryQueue = useRef<Promise<void>>(Promise.resolve());
  const reconcileHistoryRef = useRef<(action: "undo" | "redo", before: Set<string>, after: Set<string>) => void>(() => undefined);
  const templateInitRef = useRef(false);

  const artifactRow = artifactEntry.data;
  const artifactFailed = !denied && artifactRow === undefined && artifactEntry.error !== undefined && !artifactEntry.revalidating && offlineLookup === "missing";
  const readDenied = [artifactEntry.error, snapshotEntry.error].some(error => error instanceof OfficeApiError && [401,403,404].includes(error.status));
  const allowDeviceSeed = !onlineSeen.current && !readDenied && !denied;
  const artifact: OfficeArtifact | null | undefined = denied || readDenied || artifactFailed ? null : artifactRow ?? (allowDeviceSeed ? offline?.payload.artifact ?? seed?.payload.artifact : undefined);
  const offlineLive = useMemo(() => allowDeviceSeed && offline ? packageLive(offline) : null, [allowDeviceSeed, offline]);
  const seedLive = useMemo(() => allowDeviceSeed && seed ? packageLive(seed) : null, [allowDeviceSeed, seed]);
  const workingSource = snapshotEntry.data ?? offlineLive ?? seedLive;
  const localCurrent = liveLocal?.source === workingSource && (allowDeviceSeed || officeMetadataRemaining(liveLocal?.value, viewerId) > 0);
  const live: OfficeLiveSnapshot | null = onlineReady || allowDeviceSeed ? localCurrent ? liveLocal!.value : workingSource ?? null : null;
  const liveRef = useRef<OfficeLiveSnapshot | null>(live);
  liveRef.current = live;
  const snapshotPending = !denied && !readDenied && snapshotEntry.data === undefined && snapshotEntry.error === undefined;
  const offlineCopyAt = allowDeviceSeed ? offline?.savedAt ?? null : null;
  const collab = useCollabProvider(artifact && live && artifact.lifecycleState === "active" && !isOfficeStartFailed(artifact) ? `office:${artifactId}` : null);
  const accessLost = (onlineSeen.current && !artifactEntry.data) || (fullReadSeen.current && !snapshotEntry.data) || readDenied;
  useLayoutEffect(() => {
    if (!accessLost) return;
    setLiveLocal(null);setSeed(null);setOffline(null);setCachedUpdate(null);setCachedComments(null);
    setTargets([]);setCommentAnchor(null);setSuggestionRange(null);setPresentOpen(false);setQueuedCommentThreads(EMPTY_COMMENTS);
    setHistoryState({canUndo:false,canRedo:false});offlineUndoneCommands.current.clear();
  }, [accessLost]);
  useEffect(() => {
    if (!collab.accessDenied) return;
    setDenied(true);
    invalidateSurfaceCache(artifactKey);invalidateSurfaceCache(snapshotKey);
    setLiveLocal(null);setSeed(null);setOffline(null);setCachedUpdate(null);setCachedComments(null);
    setTargets([]);setCommentAnchor(null);setSuggestionRange(null);setPresentOpen(false);setQueuedCommentThreads(EMPTY_COMMENTS);
    setHistoryState({canUndo:false,canRedo:false});offlineUndoneCommands.current.clear();
    void quarantineOfflineWork(artifactId, offlineOwner).catch(() => undefined);
  }, [collab.accessDenied, artifactId, artifactKey, snapshotKey, offlineOwner]);
  function currentRead(needSnapshot = true) {
    if (!lifetime.current || getUserInfo()?.id !== viewerId) return false;
    if (allowDeviceSeed && !onlineSeen.current) return Boolean(offlineLive || seedLive);
    return officeMetadataRemaining(readSurfaceCache(artifactKey).data, viewerId) > 0 && (!needSnapshot || officeMetadataRemaining(readSurfaceCache(snapshotKey).data, viewerId) > 0);
  }
  function captureRead(needSnapshot = true, write: false | "edit" | "comment" = false) {
    const owner = lifetime.current;
    const startingArtifact = artifactEntry.data, startingSnapshot = snapshotEntry.data;
    const legacyDevice = allowDeviceSeed && !onlineSeen.current;
    return () => {
      const currentArtifact = legacyDevice ? artifact : readSurfaceCache<OfficeArtifact>(artifactKey).data;
      const canWrite = !write || (currentArtifact?.lifecycleState === "active" && (write === "edit" ? currentArtifact.role === "edit" : ["edit", "comment"].includes(currentArtifact.role)));
      return canWrite && owner === lifetime.current && currentRead(needSnapshot) && (legacyDevice ? !onlineSeen.current : officeMetadataRemaining(startingArtifact, viewerId) > 0 && (!needSnapshot || officeMetadataRemaining(startingSnapshot, viewerId) > 0));
    };
  }
  currentHistoryRead.current = () => captureRead(true, "edit")();
  async function readback(current: () => boolean, includeArtifact = true) {
    if (!current()) return;
    const pendingReads = [];
    if (readSurfaceCache(snapshotKey).revalidating) pendingReads.push(snapshotEntry.refresh());
    if (includeArtifact && readSurfaceCache(artifactKey).revalidating) pendingReads.push(artifactEntry.refresh());
    if (pendingReads.length) {await Promise.all(pendingReads);if (!current()) return;}
    await Promise.all([snapshotEntry.refresh(), ...(includeArtifact ? [artifactEntry.refresh()] : [])]);
  }
  useLayoutEffect(() => {
    if (liveLocal && liveLocal.source !== workingSource) setLiveLocal(null);
  }, [liveLocal, workingSource]);
  useEffect(() => {
    if (!readDenied) return;
    setDenied(true);
    invalidateSurfaceCache(artifactKey);invalidateSurfaceCache(snapshotKey);
    void quarantineOfflineWork(artifactId, offlineOwner).catch(() => undefined);
  }, [readDenied, artifactKey, snapshotKey, artifactId, offlineOwner]);
  const offlineDiscussion = collab.status === "disconnected" || Boolean(offlineCopyAt);
  const discussionPrefix = viewerId && artifact?.family === "document" && !offlineCopyAt ? officePanelCachePrefix(workspaceId, viewerId) : null;
  const commentsKey = officePanelCacheKey(discussionPrefix, "comments", artifactId);
  const suggestionsKey = officePanelCacheKey(discussionPrefix, "suggestions", artifactId);
  const commentsEntry = useOfficeMetadataResource(commentsKey, viewerId, () => listOfficeComments(artifactId));
  const suggestionsEntry = useOfficeMetadataResource(suggestionsKey, viewerId, () => listOfficeSuggestions(artifactId));
  const serverComments = offlineCopyAt ? cachedComments ?? EMPTY_COMMENTS : commentsEntry.data ?? EMPTY_COMMENTS;
  const commentThreads = useMemo(() => offlineDiscussion ? [...serverComments, ...queuedCommentThreads] : serverComments, [offlineDiscussion, serverComments, queuedCommentThreads]);
  const suggestions = offlineCopyAt ? EMPTY_SUGGESTIONS : suggestionsEntry.data ?? EMPTY_SUGGESTIONS;
  const commentsReady = Boolean(commentsEntry.data);
  useEffect(() => {if (!offlineDiscussion) setQueuedCommentThreads(EMPTY_COMMENTS);}, [offlineDiscussion]);
  const currentUser = getUserInfo();
  useEffect(() => chatDockSuppression.suppress(), []);
  // Office mounts its own floating recorder (offset for the document
  // toolbar, hidden while presenting); the chrome-level host stands down.
  useEffect(() => claimFloatingRecorder(), []);
  usePublishPresenceIdentity(collab.provider, currentUser);
  usePublishPresenceActivity(collab.provider);
  const presence = usePresence(collab.provider);

  // Cold seed: when nothing is cached for this snapshot, the encrypted
  // package (if the user saved one) paints the editor while the network
  // answers. Paint only - it never enters offline mode by itself.
  useEffect(() => {
    if (onlineSeen.current || readSurfaceCache<OfficeLiveSnapshot>(snapshotKey).data !== undefined) return;
    let active = true;
    void loadOfflinePackage(artifactId, offlineOwner).then((pkg) => { if (active && pkg && !onlineSeen.current) setSeed(pkg); }).catch(() => undefined);
    return () => { active = false; };
  }, [artifactId, snapshotKey, offlineOwner]);

  // A fetched row is authoritative: leave offline mode and reset the per-load
  // flags. Lifecycle loss moves every local ciphertext out of replay paths.
  useEffect(() => {
    if (!artifactRow) return;
    setOffline(null);
    setOfflineLookup("idle");
    setCachedComments(null);
    setReconnectStatus("synced");
    setTemplateDraftFailed(false);
    if (artifactRow.lifecycleState !== "active") void quarantineOfflineWork(artifactId, offlineOwner).catch(() => undefined);
  }, [artifactId, artifactRow, offlineOwner]);

  useEffect(() => {
    if (artifact?.role) setSuggestMode(artifact.role === "comment");
  }, [artifact?.role]);

  // Row fetch failed with no value to show: denial evicts, anything else
  // tries the pinned package and enters offline mode when one exists.
  useEffect(() => {
    const error = artifactEntry.error;
    if (denied || artifactRow !== undefined || error === undefined || artifactEntry.revalidating) return;
    if (error instanceof OfficeApiError && [401, 403, 404].includes(error.status)) {
      setDenied(true);
      invalidateSurfaceCache(artifactKey);
      invalidateSurfaceCache(snapshotKey);
      return;
    }
    if (onlineSeen.current) {setOfflineLookup("missing");return;}
    let active = true;
    void loadOfflinePackage(artifactId, offlineOwner).catch(() => null).then((cached) => {
      if (!active || onlineSeen.current) return;
      if (!cached) { setOfflineLookup("missing"); return; }
      setOffline(cached);
      setCachedComments(cached.payload.comments);
      setCachedUpdate(Uint8Array.from(atob(cached.payload.yjsUpdate), (character) => character.charCodeAt(0)));
      setReconnectStatus("offline");
    });
    return () => { active = false; };
  }, [artifactEntry.error, artifactEntry.revalidating, artifactId, artifactKey, artifactRow, denied, snapshotKey, offlineOwner]);

  // Snapshot fetch failed: an uninitialized template draft is initialized
  // through a fresh bounded read; a still-running generation / import job polls
  // both keys until the snapshot exists.
  useEffect(() => {
    const error = snapshotEntry.error;
    if (denied || offline || !artifactRow || snapshotEntry.data !== undefined || error === undefined || snapshotEntry.revalidating) return;
    const uninitializedTemplate = artifactRow.mode === "template" && templateId && error instanceof OfficeApiError && error.status === 409 && error.message === "artifact_not_ready";
    if (uninitializedTemplate && !templateInitRef.current) {
      templateInitRef.current = true;
      const current = captureRead(false, "edit");
      if (!current()) return;
      void initializeOfficeTemplateDraft({templateId, workspaceId, draftArtifactId: artifactId}).then(async () => {
        await readback(current);
      }).catch(() => {if (current()) setTemplateDraftFailed(true);});
      return;
    }
    if (!artifactRow.job || ["failed", "cancelled"].includes(artifactRow.job.status)) return;
    const timer = setTimeout(() => { void Promise.all([artifactEntry.refresh(), snapshotEntry.refresh()]); }, 1500);
    return () => clearTimeout(timer);
  }, [artifactEntry.refresh, artifactId, artifactRow, denied, offline, snapshotEntry.data, snapshotEntry.error, snapshotEntry.refresh, snapshotEntry.revalidating, snapshotKey, templateId, workspaceId]);

  useEffect(() => {
    const reconnect = () => { void Promise.all([artifactEntry.refresh(), snapshotEntry.refresh()]); };
    window.addEventListener("online", reconnect);
    return () => window.removeEventListener("online", reconnect);
  }, [artifactEntry.refresh, snapshotEntry.refresh]);
  useEffect(() => {
    if (!cachedUpdate || !collab.doc || !allowDeviceSeed || !currentRead()) return;
    applyOfficeUpdate(collab.doc, cachedUpdate);
    setCachedUpdate(null);
  }, [cachedUpdate, collab.doc, allowDeviceSeed]);
  useEffect(() => {
    const doc = collab.doc;
    if (!doc || (!collab.synced && !offlineCopyAt) || !workingSource || !currentRead()) return;
    const refresh = () => {
      try {
        if (!currentRead()) return;
        const snapshot = yDocToSnapshot(doc);
        const value = {snapshot, seq: liveRef.current?.seq ?? 0, baseVersion: liveRef.current?.baseVersion ?? 1};
        setLiveLocal({source: workingSource, value: allowDeviceSeed ? value : inheritOfficeMetadata(value, workingSource, viewerId)});
      } catch {
        // A newly created artifact can connect before its first snapshot is
        // initialized. The generation/import poll above remains the fallback.
      }
    };
    refresh();
    doc.on("update", refresh);
    return () => doc.off("update", refresh);
  }, [collab.doc, collab.synced, offlineCopyAt, workingSource, onlineReady, allowDeviceSeed, viewerId]);
  useEffect(() => {
    if (!commentsKey || !commentsReady || !artifact || artifact.family !== "document" || artifact.role !== "edit" || artifact.lifecycleState !== "active" || offlineCopyAt || !live) return;
    let active = true;
    const startingRead = readSurfaceCache<OfficeCommentThread[]>(commentsKey).data;
    const ownsArtifact = captureRead(true, "edit");
    const current = () => active && ownsArtifact() && getUserInfo()?.id === viewerId && officeMetadataRemaining(startingRead, viewerId) > 0 && officeMetadataRemaining(readSurfaceCache(commentsKey).data, viewerId) > 0;
    const timeout = window.setTimeout(() => {
      if (!current()) return;
      void detachMissingOfficeComments(artifactId).then(async detached => {
        if (!current() || detached <= 0) return;
        // Drain a read already in flight so the mutation gets a fresh readback.
        if (readSurfaceCache(commentsKey).revalidating) {await commentsEntry.refresh();if (!current()) return;}
        await commentsEntry.refresh();
      }).catch(error => {
        if (current() && error instanceof OfficeApiError && [401,403,404].includes(error.status)) invalidateSurfaceCache(commentsKey);
      });
    }, 750);
    return () => {active = false;window.clearTimeout(timeout);};
  }, [artifact?.family, artifact?.role, artifact?.lifecycleState, artifactId, live?.snapshot, offlineCopyAt, commentsKey, commentsReady, commentsEntry.refresh, viewerId]);
  useEffect(() => {
    if (artifact?.mode === "template" && templateId) {
      setPanel("routing");
      setPanelOpen(true);
    }
  }, [artifact?.family, artifact?.mode, templateId]);
  useEffect(() => {
    if (collab.status !== "connected" || !collab.synced || !onlineReady) return;
    let active = true;
    const ownsRead = captureRead(true, "edit");
    const current = () => active && ownsRead();
    void listOfflineJournal(artifactId, offlineOwner).then(async (entries) => {
      if (!current()) return;
      const commands = entries.filter((entry): entry is Extract<(typeof entries)[number], { kind: "command" }> => entry.kind === "command");
      if (commands.length > 0) {
        const sourcePackage = await loadOfflinePackage(artifactId, offlineOwner);
        if (!sourcePackage || !artifact) { setReconnectStatus("sync_failed"); return; }
        const result = await syncOfficeOfflineCommands({
          artifactId,
          expectedSeq: commands[0].expectedSeq,
          commands: commands.map((entry) => entry.command),
          deviceId: await officeOfflineDeviceId(offlineOwner),
          recoveryTitle: t.offlineRecoveryTitle.replace("{title}", artifact.title),
          recoverySnapshot: materializeOfflineRecoverySnapshot(sourcePackage, commands),
        });
        if (!current()) return;
        const classified = classifyOfficeReconnect(result);
        setReconnectStatus(classified.status);
        if (result.status === "synced" || (classified.conflict && result.recoveryArtifactId)) {
          await Promise.all(commands.map(entry => removeOfflineJournalEntry(entry, offlineOwner)));
          setRecoveryArtifactId(result.recoveryArtifactId ?? null);
        }
        if (classified.quarantine) {
          await quarantineOfflineWork(artifactId, offlineOwner).catch(() => undefined);
          invalidateSurfaceCache(artifactKey);
          invalidateSurfaceCache(snapshotKey);
          setDenied(true);
          setOffline(null);
          setLiveLocal(null);
          return;
        }
        if (result.status !== "synced" && !(classified.conflict && result.recoveryArtifactId)) return;
      }
      const suggestions = entries.filter((entry): entry is Extract<(typeof entries)[number], { kind: "suggestion" }> => entry.kind === "suggestion");
      for (const entry of suggestions) {
        if (!current()) return;
        await submitOfficeCommand(artifactId, entry.expectedSeq, entry.command, "suggest");
        if (!current()) return;
        await removeOfflineJournalEntry(entry, offlineOwner);
      }
    }).catch(() => { if (active && ownsRead()) setReconnectStatus("sync_failed"); });
    return () => {active = false;};
  }, [artifact, artifactId, artifactKey, collab.status, collab.synced, snapshotKey, offlineOwner, viewerId, onlineReady, t.offlineRecoveryTitle]);
  useEffect(() => {
    const doc = collab.doc;
    if (!doc || !currentRead() || artifact?.lifecycleState !== "active" || artifact.role !== "edit" || suggestMode) return;
    let history: ReturnType<typeof createOfficeUndoManager> | null = null;
    let stopObserving: (() => void) | null = null;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!history || !currentHistoryRead.current()) return;
      const before = new Set(officeCommandIds(doc));
      const action = handleOfficeHistoryShortcut(event, history, editorRootRef.current);
      if (!action) return;
      const after = new Set(officeCommandIds(doc));
      reconcileHistoryRef.current(action, before, after);
    };
    const stopWaiting = observeOfficeHistoryReadiness(doc, () => {
      if (!currentHistoryRead.current()) return;
      history = createOfficeUndoManager(doc);
      historyRef.current = history;
      stopObserving = observeOfficeHistory(history, setHistoryState);
      window.addEventListener("keydown", onKeyDown);
    });
    return () => {
      stopWaiting();
      window.removeEventListener("keydown", onKeyDown);
      if (historyRef.current === history) historyRef.current = null;
      setHistoryState({ canUndo: false, canRedo: false });
      stopObserving?.();
      history?.destroy();
    };
  }, [artifact?.lifecycleState, artifact?.role, artifactId, collab.doc, suggestMode, onlineReady, allowDeviceSeed]);

  reconcileHistoryRef.current = (action, before, after) => {
    const changedIds = action === "undo" ? [...before].filter((id) => !after.has(id)) : [...after].filter((id) => !before.has(id));
    const current = captureRead(true, "edit");
    if (changedIds.length === 0 || !current()) return;
    offlineHistoryQueue.current = offlineHistoryQueue.current.then(async () => {
      if (!current()) return;
      if (action === "undo") {
        const changedSet = new Set(changedIds);
        const entries = await listOfflineJournal(artifactId, offlineOwner);
        for (const entry of entries) {
          if (!current()) return;
          if (entry.kind !== "command" || !changedSet.has(entry.command.commandId)) continue;
          offlineUndoneCommands.current.set(entry.command.commandId, entry);
          await removeOfflineJournalEntry(entry, offlineOwner);
        }
        return;
      }
      for (const commandId of changedIds) {
        if (!current()) return;
        const entry = offlineUndoneCommands.current.get(commandId);
        if (!entry) continue;
        await appendOfflineCommand(entry, offlineOwner);
        if (!current()) return;
        offlineUndoneCommands.current.delete(commandId);
      }
    }).catch(() => undefined);
  };

  function runHistory(action: "undo" | "redo") {
    const history = historyRef.current;
    const doc = collab.doc;
    if (!history || !doc || !captureRead(true, "edit")()) return;
    const before = new Set(officeCommandIds(doc));
    const changed = action === "undo" ? history.undo() : history.redo();
    if (!changed) return;
    const after = new Set(officeCommandIds(doc));
    reconcileHistoryRef.current(action, before, after);
  }
  // Nothing known yet (no cached row, no list row, no package): a
  // geometry-matched skeleton under the bare topbar, never a sentence (N4).
  if (artifact === undefined) return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-office-shell-state="loading" aria-busy="true"><OfficeTopbar workspaceId={workspaceId} breadcrumbs={[]} /><OfficeEditorSkeleton /></div>;
  if (artifact === null) return <div className="flex flex-1 flex-col" data-office-shell-state="failed"><OfficeTopbar workspaceId={workspaceId} breadcrumbs={[{ label: t.editorFailed }]} /><p className="m-auto text-sm text-destructive">{t.editorFailed}</p></div>;
  if (fullReadSeen.current && !onlineReady) return <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-office-shell-state="loading" aria-busy="true"><OfficeTopbar workspaceId={workspaceId} breadcrumbs={[{label: artifact.title}]} /><OfficeEditorSkeleton family={artifact.family}/></div>;
  const Icon = artifact.family === "document" ? FileText : artifact.family === "presentation" ? Presentation : artifact.family === "pdf" ? FileSignature : FileSpreadsheet;
  if (templateDraftFailed) return <div className="flex flex-1 flex-col" data-office-shell-state="failed"><OfficeTopbar workspaceId={workspaceId} breadcrumbs={[{ label: artifact.title }]} /><p className="m-auto text-sm text-destructive">{t.editorFailed}</p></div>;
  if (isOfficeStartFailed(artifact)) return <OfficeStartRecovery workspaceId={workspaceId} title={artifact.title} family={artifact.family} canTrash={artifact.role === "edit"} state={recoveryState} onTrash={() => {
    setRecoveryState("moving");
    const current = captureRead(false, "edit");
    if (!current()) return;
    void transitionOfficeLifecycle(artifactId, "trash", "Office creation did not start").then(() => {if (!current()) return; invalidateOfficeList(workspaceId); invalidateSurfaceCache(artifactKey); router.push(`/w/${workspaceId}/office`); }).catch(() => {if (current()) setRecoveryState("failed");});
  }} />;
  async function apply(command: OfficeCommand) {
    const current = captureRead(true, suggestMode || artifact?.role === "comment" ? "comment" : "edit");
    if (!live || !current()) return;
    if (artifact!.lifecycleState !== "active") return;
    if (!suggestMode && artifact!.role === "edit" && collab.doc && (collab.synced || offlineCopyAt)) {
      if (collab.status === "disconnected" || offlineCopyAt) {
        const offlineCommand = { ...command, origin: "offline" as const };
        await appendOfflineCommand({ artifactId, seq: Date.now() * 1_000 + Math.floor(Math.random() * 1_000), kind: "command", expectedSeq: live.seq, command: offlineCommand, createdAt: new Date().toISOString() }, offlineOwner);
        if (current()) appendOfficeCommand(collab.doc, offlineCommand);
      } else appendOfficeCommand(collab.doc, command);
      return;
    }
    await submitOfficeCommand(artifactId, live.seq, command, suggestMode || artifact!.role === "comment" ? "suggest" : "apply");
    await readback(current);
  }
  async function refreshArtifact() {
    const current = captureRead();
    await readback(current);
    if (current()) setLiveLocal(null);
  }
  function onLifecycle(_next: OfficeArtifact) {
    const current = captureRead(false);
    if (!current()) return;
    invalidateOfficeList(workspaceId);
    invalidateSurfaceCache(artifactKey);
    void artifactEntry.refresh();
  }
  async function requestBrianRevision(instruction: string, requestedTargetIds = targets, anchorOverride?: OfficeCommentThread["anchor"]) {
    const current = captureRead(true, "comment");
    if (!current() || !artifact || !live || artifact.lifecycleState !== "active" || artifact.role === "view" || offlineCopyAt || collab.status === "disconnected" || requestedTargetIds.length === 0) return null;
    const targetSet = new Set(requestedTargetIds);
    const anchor: OfficeCommentThread["anchor"] = anchorOverride ?? (artifact.family === "document" && commentAnchor
      ? commentAnchor
      : artifact.family === "presentation"
        ? { kind: live.snapshot.family === "presentation" && requestedTargetIds.every((id) => live.snapshot.family === "presentation" && live.snapshot.slides.some((slide) => slide.id === id)) ? "slide" : "object", targetIds: requestedTargetIds }
        : live.snapshot.family === "spreadsheet" && live.snapshot.worksheets.some((sheet) => sheet.images.some((image) => targetSet.has(image.id)))
          ? { kind: "object", targetIds: requestedTargetIds }
          : { kind: artifact.family === "spreadsheet" ? "table_cell" : "block", targetIds: requestedTargetIds });
    const created = await createOfficeComment({ artifactId, anchor, body: `@Brian ${instruction.trim()}`, invokeBrian: { assistantId: APP_LEVEL_ASSISTANT_ID, expectedVersion: artifact.version, idempotencyKey: crypto.randomUUID() } });
    return current() ? created.revision ?? null : null;
  }
  async function editSpreadsheetImageWithBrian(imageId: string, instruction: string) {
    const current = captureRead(true, "comment");
    if (!artifact || !live || !current()) return;
    const revision = await requestBrianRevision(instruction, [imageId], { kind: "object", targetIds: [imageId] });
    if (!current()) return;
    setPanel("activity");
    setPanelOpen(true);
    if (!revision || revision === "version_conflict") throw new Error("Worksheet image revision could not start");
    const job = await waitForOfficeJob(revision.jobId, 180_000, current);
    if (job.status !== "completed") throw new Error("Worksheet image revision did not complete");
    await refreshArtifact();
  }
  async function publishTemplate() {
    const current = captureRead(true, "edit");
    if (!templateId || !current()) return;
    setTemplateCompileState("queued");
    try {
      const queued = await compileOfficeTemplateDraft({ templateId, workspaceId, draftArtifactId: artifactId });
      if (!current()) return;
      const job = await waitForOfficeJob(queued.jobId, 180_000, current);
      if (!current()) return;
      setTemplateCompileState(job.status === "completed" ? "idle" : "failed");
    } catch {
      if (current()) setTemplateCompileState("failed");
    }
  }
  const editorRole = artifact.lifecycleState === "active" ? artifact.role : "view" as const;
  const editor = live?.snapshot.family === "document" ? <DocumentEditor snapshot={live.snapshot} baseVersion={live.baseVersion} role={editorRole} suggestMode={suggestMode} doc={collab.doc} provider={collab.provider} currentUser={currentUser} synced={collab.synced || Boolean(offlineCopyAt)} onCommand={(command) => void apply(command)} onSelectTargets={setTargets} onSelectCommentAnchor={setCommentAnchor} onSelectSuggestionRange={setSuggestionRange} commentThreads={commentThreads} suggestions={suggestions} /> : live?.snapshot.family === "presentation" ? <PresentationEditor snapshot={live.snapshot} baseVersion={live.baseVersion} role={editorRole} suggestMode={suggestMode} onCommand={(command) => void apply(command)} onSelectTargets={setTargets} /> : live?.snapshot.family === "spreadsheet" ? <SpreadsheetEditor snapshot={live.snapshot} baseVersion={live.baseVersion} role={editorRole} suggestMode={suggestMode} onCommand={(command) => void apply(command)} onSelectTargets={setTargets} onEditImageWithBrian={artifact.role !== "view" && artifact.lifecycleState === "active" && !offlineCopyAt && collab.status !== "disconnected" ? editSpreadsheetImageWithBrian : undefined} /> : live?.snapshot.family === "pdf" && artifact.mode === "session" && artifact.expiresAt ? <PdfEditor workspaceId={workspaceId} snapshot={live.snapshot} seq={live.seq} baseVersion={live.baseVersion} artifactVersion={artifact.version} expiresAt={artifact.expiresAt} role={editorRole} onCommand={apply} onReadback={refreshArtifact} onSelectTargets={setTargets} /> : snapshotPending ? <OfficeEditorSkeleton family={artifact.family} /> : <p className="m-auto text-sm text-muted-foreground">{t.running}</p>;
  const isPdfSession = artifact.family === "pdf" && artifact.mode === "session";
  const showTemplateRouting = artifact.mode === "template" && Boolean(live) && Boolean(templateId);
  const templateRoutingBlocked = showTemplateRouting && (!templateRoutingState.ready || templateRoutingState.dirty || templateRoutingState.saving);
  const brianRevisionDisabledReason = targets.length === 0 ? t.brianSelectionRequired
    : artifact.role === "view" ? t.brianViewUnavailable
    : artifact.lifecycleState !== "active" ? t.brianInactiveUnavailable
    : offlineCopyAt || collab.status === "disconnected" ? t.brianOfflineUnavailable
    : undefined;
  const canRequestBrianRevision = !brianRevisionDisabledReason && Boolean(live);
  const canSuggest = artifact.family === "document" && artifact.role === "edit" && artifact.lifecycleState === "active";
  const toggleSuggestMode = () => { const next = !suggestMode; setSuggestMode(next); if (next) { setPanel("suggestions"); setPanelOpen(true); } };
  const discardRecoveryCopy = async () => {
    if (!recoveryArtifactId || offlineRecoveryBusy) return;
    setOfflineRecoveryBusy(true);
    try {
      await transitionOfficeLifecycle(recoveryArtifactId, "trash", "Discarded recovered offline copy");
      invalidateOfficeList(workspaceId);
      setRecoveryArtifactId(null);
      setReconnectStatus("synced");
    } finally { setOfflineRecoveryBusy(false); }
  };
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" data-office-shell-state="ready">
      {/* Below `md` the right cluster folds Suggest + undo / redo into one
          menu (report B row 12): with Reclassify, the family icon and presence
          beside them the desktop cluster is wider than a 360px bar. */}
      <OfficeTopbar workspaceId={workspaceId} breadcrumbs={[{ label: artifact.title }]} right={<div className="flex items-center gap-2"><ReclassifyContextButton workspaceId={workspaceId} primitive="office" rowId={artifactId} /><div className="hidden items-center gap-2 md:flex">{canSuggest ? <button type="button" aria-pressed={suggestMode} onClick={toggleSuggestMode} className="rounded border px-2 py-1 text-xs aria-pressed:bg-amber-50 aria-pressed:text-amber-950">{suggestMode ? t.editMode : t.suggestMode}</button> : null}<OfficeHistoryControls canUndo={historyState.canUndo} canRedo={historyState.canRedo} onUndo={() => runHistory("undo")} onRedo={() => runHistory("redo")} /></div><div className="md:hidden"><DropdownMenu><DropdownMenuTrigger render={<button type="button" aria-label={t.editorActions} title={t.editorActions} className="inline-flex size-11 md:size-8 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground" data-office-editor-actions="true"><MoreHorizontal className="size-4" /></button>} /><DropdownMenuContent align="end"><DropdownMenuItem disabled={!historyState.canUndo} onClick={() => runHistory("undo")}><Undo2 />{t.undo}</DropdownMenuItem><DropdownMenuItem disabled={!historyState.canRedo} onClick={() => runHistory("redo")}><Redo2 />{t.redo}</DropdownMenuItem>{canSuggest ? <><DropdownMenuSeparator /><DropdownMenuItem onClick={toggleSuggestMode}><ListChecks />{suggestMode ? t.editMode : t.suggestMode}</DropdownMenuItem></> : null}</DropdownMenuContent></DropdownMenu></div><Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /><PresenceAvatars users={presence} /></div>} />
      {/* The topbar breadcrumb truncates to a few characters at 360px; the
          full title gets its own line on phones (report B row 50). */}
      <p className="line-clamp-2 border-b px-3 py-1.5 text-xs font-medium md:hidden" data-office-title-line="true">{artifact.title}</p>
      {offlineCopyAt || reconnectStatus === "needs_attention" || reconnectStatus === "sync_failed" ? <div className="flex flex-wrap items-center gap-2 border-b bg-amber-50 px-4 py-2 text-xs text-amber-950"><span>{reconnectStatus === "needs_attention" ? t.offlineNeedsAttention : reconnectStatus === "sync_failed" ? t.syncFailed : t.offlineCopy.replace("{time}", new Date(offlineCopyAt!).toLocaleString())}</span>{recoveryArtifactId ? <><button type="button" className="rounded border border-amber-800/40 px-2 py-1 font-medium" onClick={() => router.push(`/w/${workspaceId}/office/${recoveryArtifactId}`)}>{t.openRecoveryCopy}</button><button type="button" disabled={offlineRecoveryBusy} className="rounded border border-amber-800/40 px-2 py-1 font-medium disabled:opacity-50" onClick={() => void discardRecoveryCopy()}>{t.discardRecoveryCopy}</button></> : null}</div> : null}
      {artifact.mode === "template" ? <div className="flex items-center justify-between gap-3 border-b bg-amber-50 px-4 py-2 text-xs font-medium text-amber-950"><span>{t.templateMode}</span>{templateId ? <button type="button" title={templateRoutingBlocked ? t.routingSaveBeforePublish : t.templateAdmit} disabled={templateCompileState === "queued" || !live || templateRoutingBlocked} className="rounded bg-amber-950 px-3 py-1.5 text-amber-50 disabled:opacity-50" onClick={() => void publishTemplate()}>{templateRoutingBlocked ? t.routingSaveBeforePublish : templateCompileState === "queued" ? t.templateCompiling : templateCompileState === "failed" ? t.templateCompileFailed : t.templateAdmit}</button> : null}</div> : null}
      <div className="flex min-h-0 min-w-0 flex-1 flex-col lg:flex-row">
        <main ref={editorRootRef} className="flex min-h-0 min-w-0 flex-1 overflow-hidden bg-muted/30">{editor}</main>
        {/* Below `lg` the panel stacks LAST in this column, and below `sm` the
            document toolbar is a `fixed inset-x-2 bottom-2` bar over it - so
            without reserved space the collapsed 40px strip (the ONLY way to
            reopen Brian / Comments / History / Sharing / File actions) sat
            entirely under the toolbar (responsive contract M1 / M6). The
            bottom padding reserves the toolbar's height plus the home
            indicator; `sm+` uses the in-flow desktop toolbar and needs none.
            The stacked panel is also capped at 45dvh with its own scroll
            (report B row 13): open, its content used to take the whole
            column and `main` collapsed to nothing. */}
        <aside className={cn("shrink-0 overflow-y-auto border-t bg-background transition-[width] max-sm:pb-[calc(4rem+env(safe-area-inset-bottom))] max-lg:max-h-[45dvh] max-lg:min-h-0 lg:border-l lg:border-t-0", panelOpen ? showTemplateRouting && panel === "routing" ? "w-full lg:w-80" : "w-full lg:w-64" : "w-full lg:w-12")} data-office-panel={panelOpen ? "open" : "collapsed"}>
          {panelOpen ? <>
            <div className="flex items-center justify-between gap-2 border-b p-2">
              <div className="flex min-w-0 items-center gap-2"><span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-600"><Sparkles className="size-3.5" aria-hidden /></span><div className="min-w-0"><p className="truncate text-xs font-semibold">{t.brian}</p><p className="truncate text-[11px] text-muted-foreground">{t.workspaceAssistant}</p></div></div>
              <button type="button" onClick={() => setPanelOpen(false)} aria-label={t.collapseAssistantPanel} title={t.collapseAssistantPanel} className="flex size-11 md:size-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground sm:size-7"><PanelRightClose className="size-4" /></button>
            </div>
            <div className={cn("grid border-b p-1", isPdfSession ? "grid-cols-1" : showTemplateRouting ? "grid-cols-4" : "grid-cols-3")}>
              {showTemplateRouting ? <PanelButton active={panel === "routing"} label={t.routing} icon={<Route className="size-3" />} onClick={() => setPanel("routing")} /> : null}
              <PanelButton active={panel === "activity"} label={t.brian} icon={<Sparkles className="size-3" />} onClick={() => setPanel("activity")} />
              {!isPdfSession ? <><PanelButton active={panel === "comments"} label={t.comments} icon={<MessageSquare className="size-3" />} onClick={() => setPanel("comments")} /><PanelButton active={panel === "suggestions"} label={t.suggestions} icon={<ListChecks className="size-3" />} onClick={() => setPanel("suggestions")} /><PanelButton active={panel === "history"} label={t.history} icon={<History className="size-3" />} onClick={() => setPanel("history")} /><PanelButton active={panel === "sharing"} label={t.sharing} icon={<Share2 className="size-3" />} onClick={() => setPanel("sharing")} /><PanelButton active={panel === "review"} label={t.fileActions} icon={<FileCheck2 className="size-3" />} onClick={() => setPanel("review")} /></> : null}
            </div>
          </> : null}
          {/* Keep routing mounted when collapsed: pending edits and live binding
              reconciliation must survive hiding the panel. */}
          {showTemplateRouting && live && templateId ? <div className={panelOpen && panel === "routing" ? "block" : "hidden"}><TemplateRoutingInspector templateId={templateId} snapshot={live.snapshot} selectedTargetIds={targets} onStateChange={setTemplateRoutingState} /></div> : null}
          {panelOpen ? <>
            {panel === "activity" ? <OfficeJobActivity jobId={artifact.job?.id} snapshot={live?.snapshot} targetIds={targets} canRequestRevision={canRequestBrianRevision} requestDisabledReason={brianRevisionDisabledReason} onRequestRevision={requestBrianRevision} onRevisionCompleted={refreshArtifact} /> : null}
            {panel === "comments" ? <div className="p-3"><OfficeComments artifactId={artifactId} workspaceId={workspaceId} version={artifact.version} targetIds={targets} selectionAnchor={artifact.family === "document" ? commentAnchor : null} anchorKind={artifact.family === "document" ? "block" : artifact.family === "spreadsheet" ? "table_cell" : "object"} canComment={artifact.role !== "view"} offline={collab.status === "disconnected" || Boolean(offlineCopyAt)} initialThreads={serverComments} initialQueuedThreads={queuedCommentThreads} onQueuedThreadsChange={receiveQueuedComments} onRevisionCompleted={refreshArtifact} /></div> : null}
            {panel === "suggestions" ? <div className="p-3"><OfficeSuggestions workspaceId={workspaceId} artifactId={artifactId} canDecide={artifact.role === "edit" && artifact.lifecycleState === "active" && !offlineCopyAt} canSuggest={artifact.family === "document" && artifact.role !== "view" && artifact.lifecycleState === "active" && suggestMode} actorId={currentUser?.id} baseVersion={live?.baseVersion} expectedSeq={live?.seq} proposal={suggestionRange} offline={collab.status === "disconnected" || Boolean(offlineCopyAt)} onApplied={refreshArtifact} /></div> : null}
            {panel === "history" ? <div className="p-3"><OfficeHistory artifactId={artifactId} artifactTitle={artifact.title} currentVersion={artifact.version} canEdit={artifact.role === "edit" && artifact.lifecycleState === "active" && !offlineCopyAt} onRestored={refreshArtifact} onCopied={(copiedId) => { invalidateOfficeList(workspaceId); router.push(`/w/${workspaceId}/office/${copiedId}`); }} /></div> : null}
            {panel === "sharing" ? <div className="p-3"><OfficeSharing artifactId={artifactId} /></div> : null}
            {panel === "review" ? <OfficeReview artifact={artifact} artifactId={artifactId} workspaceId={workspaceId} snapshot={live?.snapshot ?? undefined} selectedObjectIds={targets} onLifecycle={onLifecycle} onPresent={() => setPresentOpen(true)} offlineCopy={Boolean(offlineCopyAt)} /> : null}
          </> : <div className="flex items-center gap-1 p-1 lg:flex-col">
            <button type="button" onClick={() => setPanelOpen(true)} aria-label={t.expandAssistantPanel} title={t.expandAssistantPanel} className="flex size-11 md:size-8 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground sm:size-8"><PanelRightOpen className="size-4" /></button>
            {showTemplateRouting ? <CompactPanelButton active={panel === "routing"} label={t.routing} icon={<Route className="size-4" />} onClick={() => { setPanel("routing"); setPanelOpen(true); }} /> : null}
            <CompactPanelButton active={panel === "activity"} label={t.brian} icon={<Sparkles className="size-4" />} onClick={() => { setPanel("activity"); setPanelOpen(true); }} />
            {!isPdfSession ? <><CompactPanelButton active={panel === "comments"} label={t.comments} icon={<MessageSquare className="size-4" />} onClick={() => { setPanel("comments"); setPanelOpen(true); }} /><CompactPanelButton active={panel === "suggestions"} label={t.suggestions} icon={<ListChecks className="size-4" />} onClick={() => { setPanel("suggestions"); setPanelOpen(true); }} /><CompactPanelButton active={panel === "history"} label={t.history} icon={<History className="size-4" />} onClick={() => { setPanel("history"); setPanelOpen(true); }} /><CompactPanelButton active={panel === "sharing"} label={t.sharing} icon={<Share2 className="size-4" />} onClick={() => { setPanel("sharing"); setPanelOpen(true); }} /><CompactPanelButton active={panel === "review"} label={t.fileActions} icon={<FileCheck2 className="size-4" />} onClick={() => { setPanel("review"); setPanelOpen(true); }} /></> : null}
          </div>}
        </aside>
      </div>
      {presentOpen && live?.snapshot.family === "presentation" ? <PresentationPresenter snapshot={live.snapshot} onClose={() => setPresentOpen(false)} /> : null}
      {/* This shell suppresses the chat dock and has no replacement chat, so the
          workspace recorder rides the sticky fallback cluster. Hidden while
          presenting - the presenter is a deliberately chrome-free surface.
          On a phone with a Document open it lifts above the fixed toolbar
          (56px + gap) so the toolbar's trailing `...` trigger stays
          reachable (report B row 15). */}
      {!presentOpen ? <DockRecorderFallback className={artifact.family === "document" ? "max-sm:bottom-20" : undefined} /> : null}
    </div>
  );
}

/** Editor-shaped cold fallback: a toolbar row and one page / sheet / slide block. */
function OfficeEditorSkeleton({ family }: { family?: OfficeFamily }) {
  return <div className="flex min-h-0 w-full flex-1 flex-col animate-fade-in" data-office-editor-skeleton={family ?? "unknown"} aria-hidden>
    <div className="flex h-11 shrink-0 items-center gap-1.5 border-b bg-background px-3">{Array.from({ length: 8 }).map((_, index) => <Skeleton key={index} className="size-7 rounded" />)}</div>
    <div className="flex min-h-0 flex-1 justify-center overflow-hidden bg-muted/40 p-4 sm:p-6">
      {family === "spreadsheet" ? <Skeleton className="h-full w-full rounded-md" /> : family === "presentation" ? <Skeleton className="aspect-video w-full max-w-4xl self-start rounded-md" /> : <Skeleton className="h-full w-full max-w-[612pt] rounded-sm" />}
    </div>
  </div>;
}

function PanelButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick(): void }) { return <button type="button" onClick={onClick} className={`flex min-h-11 flex-1 items-center justify-center gap-1 rounded px-2 py-1.5 text-xs sm:min-h-0 ${active ? "bg-muted font-medium" : "text-muted-foreground"}`}>{icon}{label}</button>; }
function CompactPanelButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick(): void }) { return <button type="button" onClick={onClick} aria-label={label} title={label} className={cn("flex size-11 items-center justify-center rounded text-muted-foreground hover:bg-muted hover:text-foreground sm:size-8", active && "bg-muted text-foreground")}>{icon}</button>; }
