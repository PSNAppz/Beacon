import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  api,
  errorMessage,
  onDiagCommand,
  onLogBatch,
  onLogEnd,
  s3Api,
  upgradeApi,
  type Container,
  type ContainerStats,
  type DiagCommand,
  type LogLine,
  type RemoteCmdResult,
  type Session,
  type UpgradeFlow,
} from "../lib/ipc";
import { useApp } from "../lib/store";
import { toast } from "../lib/toastStore";
import {
  loadSavedTabs,
  useWorkspace,
  type Tab,
  type WorkspaceStore,
} from "../lib/workspaceStore";
import {
  useRules,
  HIGHLIGHT_COLOR_CLASSES,
  ALERT_COOLDOWN_MS,
} from "../lib/rulesStore";
import { Button, Input } from "../components/ui";
import { CommandPalette } from "./CommandPalette";
import { RulesModal } from "../features/rules/RulesModal";
import { UpgradeFlowWizard } from "../features/upgrades/UpgradeFlowWizard";
import { UpgradeConfirmDialog } from "../features/upgrades/UpgradeConfirmDialog";
import { UpgradeRunPanel } from "../features/upgrades/UpgradeRunPanel";

const MAX_LINES = 10_000;
const ROW_HEIGHT = 18;

// ─── Page ────────────────────────────────────────────────────────────────────

export function WorkspacePage() {
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const sessions = useApp((s) => s.sessions);
  const s3Config = useApp((s) => s.s3Config);
  const ws = useWorkspace();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [consoleSessionId, setConsoleSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // ── Upgrade flow state ────────────────────────────────────────────────────
  // upgradeFlows: session_id -> UpgradeFlow | null
  const [upgradeFlows, setUpgradeFlows] = useState<Record<string, UpgradeFlow | null>>({});

  // Wizard: configure / edit a flow
  const [wizardTarget, setWizardTarget] = useState<{
    sessionId: string;
    existing: UpgradeFlow | null;
  } | null>(null);

  // Confirm: pre-flight dialog before running
  const [confirmTarget, setConfirmTarget] = useState<{
    sessionId: string;
    sessionName: string;
    flow: UpgradeFlow;
  } | null>(null);

  // Run panel
  const [runTarget, setRunTarget] = useState<{
    sessionId: string;
    steps: string[];
    runId: string;
  } | null>(null);

  // Load flow when a session connects (one flow per server)
  useEffect(() => {
    const connected = Object.entries(ws.connState)
      .filter(([, s]) => s === "connected")
      .map(([id]) => id);
    connected.forEach((sid) => {
      if (!(sid in upgradeFlows)) {
        upgradeApi.getFlow(sid).then((flow) => {
          setUpgradeFlows((prev) => ({ ...prev, [sid]: flow }));
        }).catch(() => {});
      }
    });
  }, [ws.connState]); // eslint-disable-line react-hooks/exhaustive-deps

  // Trigger the upgrade run exactly once when a runTarget is set.
  // Keeping this in WorkspacePage (not inside UpgradeRunPanel) prevents
  // re-running when the console panel is toggled off and back on.
  useEffect(() => {
    if (!runTarget) return;
    upgradeApi
      .runFlow({ sessionId: runTarget.sessionId, steps: runTarget.steps, runId: runTarget.runId })
      .catch(() => {});
  }, [runTarget?.runId]); // eslint-disable-line react-hooks/exhaustive-deps

  function refreshFlow(sessionId: string) {
    upgradeApi.getFlow(sessionId).then((flow) => {
      setUpgradeFlows((prev) => ({ ...prev, [sessionId]: flow }));
    }).catch(() => {});
  }

  // Diff state: tracks whether side-by-side diff mode is on and provides a
  // shared registry for each pane to write/read its filtered lines.
  const [diffMode, setDiffMode] = useState(false);
  const [diffTick, setDiffTick] = useState(0);
  const diffLinesRef = useRef<Record<string, LogLine[]>>({});
  const diffTickTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Scroll sync registry: each pane registers a scroll-to-offset function here.
  // When diffMode is on, a pane's scroll handler calls the other pane's function.
  const scrollControllersRef = useRef<Record<string, (top: number) => void>>({});

  const notifyDiff = useCallback(() => {
    if (diffTickTimerRef.current !== null) return;
    diffTickTimerRef.current = setTimeout(() => {
      diffTickTimerRef.current = null;
      setDiffTick((t) => t + 1);
    }, 400);
  }, []);

  // Restore persisted tabs on first mount. storageRestored lives in the store so
  // it survives navigation away and back — the restore only runs once per app session.
  useEffect(() => {
    if (useWorkspace.getState().storageRestored) return;
    useWorkspace.getState().markStorageRestored();
    const saved = loadSavedTabs();
    if (saved.length > 0) {
      useWorkspace.setState({ tabs: saved, activeTabId: saved[0].id });
      const ids = [...new Set(saved.map((t) => t.sessionId))];
      ids.forEach((id) => ws.connect(id));
    }
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Connect the session from the route param (session card click).
  useEffect(() => {
    if (routeSessionId) ws.connect(routeSessionId);
  }, [routeSessionId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Global Ctrl+K / Cmd+K.
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  // Request notification permission once so alert rules can fire later.
  useEffect(() => {
    if ("Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }, []);

  // Sessions are kept alive across navigation — vault lock (via store.ts) disconnects them.

  const activeTab = ws.tabs.find((t) => t.id === ws.activeTabId);
  const splitTab = ws.splitTabId ? ws.tabs.find((t) => t.id === ws.splitTabId) : null;

  function resolveContainer(tab: Tab): Container {
    return (
      (ws.containers[tab.sessionId] ?? []).find((c) => c.id === tab.containerId) ?? {
        id: tab.containerId,
        name: tab.containerName,
        all_names: [tab.containerName],
        image: tab.containerImage,
        command: "",
        state: "",
        status: "",
        ports: "",
        created_at: "",
      }
    );
  }

  const consoleConn = consoleSessionId ? ws.connState[consoleSessionId] : undefined;
  const hasSplit = !!splitTab;

  return (
    <div className="flex h-full">
      {/* ── Left: host tree ── */}
      {sidebarOpen && (
        <HostTree
          sessions={sessions}
          ws={ws}
          consoleSessionId={consoleSessionId}
          upgradeFlows={upgradeFlows}
          onOpenWizard={(sessionId, existing) =>
            setWizardTarget({ sessionId, existing })
          }
          onOpenUpgrade={(sessionId, sessionName, flow) =>
            setConfirmTarget({ sessionId, sessionName, flow })
          }
          onToggleConsole={(id) =>
            setConsoleSessionId((cur) => (cur === id ? null : id))
          }
          onCollapse={() => setSidebarOpen(false)}
        />
      )}

      {/* ── Right: tab bar + content ── */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TabBar
          tabs={ws.tabs}
          sessions={sessions}
          activeTabId={ws.activeTabId}
          splitTabId={ws.splitTabId}
          sidebarOpen={sidebarOpen}
          hasSplit={hasSplit}
          diffMode={diffMode}
          onSelect={ws.setActiveTab}
          onClose={ws.closeTab}
          onSplit={(tabId) =>
            ws.setSplitTab(ws.splitTabId === tabId ? null : tabId)
          }
          onOpenPalette={() => setPaletteOpen(true)}
          onExpandSidebar={() => setSidebarOpen(true)}
          onToggleDiff={() => setDiffMode((d) => !d)}
        />

        {/* Panes */}
        <div className={`flex min-h-0 flex-1 ${hasSplit ? "divide-x divide-border" : "flex-col"}`}>
          <div className="flex min-h-0 flex-1 flex-col">
            {activeTab ? (
              <LogPane
                key={activeTab.id}
                paneId={activeTab.id}
                sessionId={activeTab.sessionId}
                container={resolveContainer(activeTab)}
                diffMode={diffMode && hasSplit}
                diffLinesRef={diffLinesRef}
                diffTick={diffTick}
                onDiffLines={notifyDiff}
                scrollControllersRef={scrollControllersRef}
              />
            ) : (
              <EmptyPane onOpenPalette={() => setPaletteOpen(true)} />
            )}
          </div>
          {splitTab && (
            <div className="flex min-h-0 flex-1 flex-col">
              <LogPane
                key={splitTab.id}
                paneId={splitTab.id}
                sessionId={splitTab.sessionId}
                container={resolveContainer(splitTab)}
                diffMode={diffMode && hasSplit}
                diffLinesRef={diffLinesRef}
                diffTick={diffTick}
                onDiffLines={notifyDiff}
                scrollControllersRef={scrollControllersRef}
              />
            </div>
          )}
        </div>

        {/* Console strip */}
        {consoleSessionId && consoleConn === "connected" && (
          runTarget && runTarget.sessionId === consoleSessionId
            ? <UpgradeRunPanel
                sessionId={runTarget.sessionId}
                runId={runTarget.runId}
                steps={runTarget.steps}
                onClose={() => setRunTarget(null)}
                onComplete={() => {}}
              />
            : <ConsolePane
                sessionId={consoleSessionId}
                compact={!!activeTab}
                onClose={() => setConsoleSessionId(null)}
              />
        )}
      </div>

      {paletteOpen && (
        <CommandPalette
          sessions={sessions}
          ws={ws}
          onClose={() => setPaletteOpen(false)}
        />
      )}

      {/* ── Upgrade modals ── */}
      {wizardTarget && (
        <UpgradeFlowWizard
          sessionId={wizardTarget.sessionId}
          sessionName={sessions.find((s) => s.id === wizardTarget.sessionId)?.name ?? ""}
          existing={wizardTarget.existing}
          onSave={(flow) => {
            refreshFlow(flow.session_id);
            setWizardTarget(null);
          }}
          onDelete={() => {
            refreshFlow(wizardTarget.sessionId);
            setWizardTarget(null);
          }}
          onClose={() => setWizardTarget(null)}
        />
      )}

      {confirmTarget && (
        <UpgradeConfirmDialog
          sessionName={confirmTarget.sessionName}
          flow={confirmTarget.flow}
          onConfirm={async (steps) => {
            const runId = crypto.randomUUID();
            const sid = confirmTarget.sessionId;
            setConfirmTarget(null);
            setConsoleSessionId(sid);

            // Back up logs to S3 before the upgrade wipes them
            if (s3Config) {
              const containers = ws.containers[sid] ?? [];
              const running = containers.filter((c) => c.state === "running");
              if (running.length > 0) {
                toast("ok", `Backing up ${running.length} container log(s) to S3…`);
                const results = await Promise.allSettled(
                  running.map((c) => s3Api.uploadLogs(sid, c.id, c.name))
                );
                results.forEach((r, i) => {
                  if (r.status === "fulfilled") {
                    toast("ok", `${running[i].name} → ${r.value}`);
                  } else {
                    toast("error", `S3 backup failed for ${running[i].name}: ${errorMessage(r.reason)}`);
                  }
                });
                const hadFailures = results.some((r) => r.status === "rejected");
                if (hadFailures) {
                  const proceed = confirm("Some S3 log backups failed. Continue with the upgrade anyway?");
                  if (!proceed) return;
                }
              }
            }

            setRunTarget({ sessionId: sid, steps, runId });
          }}
          onCancel={() => setConfirmTarget(null)}
        />
      )}
    </div>
  );
}

// ─── Host tree ────────────────────────────────────────────────────────────────

function HostTree({
  sessions,
  ws,
  consoleSessionId,
  upgradeFlows,
  onOpenWizard,
  onOpenUpgrade,
  onToggleConsole,
  onCollapse,
}: {
  sessions: Session[];
  ws: WorkspaceStore;
  consoleSessionId: string | null;
  upgradeFlows: Record<string, UpgradeFlow | null>;
  onOpenWizard: (sessionId: string, existing: UpgradeFlow | null) => void;
  onOpenUpgrade: (sessionId: string, sessionName: string, flow: UpgradeFlow) => void;
  onToggleConsole: (id: string) => void;
  onCollapse: () => void;
}) {
  const categories = useApp((s) => s.categories);
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Group sessions by category for the sidebar tree
  const groups = useMemo(() => {
    const result: { label: string | null; sessions: Session[] }[] = [];
    const byCat = new Map<string | null, Session[]>();
    for (const s of sessions) {
      const key = s.category_id ?? null;
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key)!.push(s);
    }
    for (const cat of categories) {
      const ss = byCat.get(cat.id);
      if (ss && ss.length > 0) result.push({ label: cat.name, sessions: ss });
    }
    const uncategorised = byCat.get(null) ?? [];
    if (uncategorised.length > 0) {
      result.push({ label: categories.length > 0 ? "Other" : null, sessions: uncategorised });
    }
    return result;
  }, [sessions, categories]);

  useEffect(() => {
    const connected = Object.entries(ws.connState)
      .filter(([, s]) => s === "connected")
      .map(([id]) => id);
    if (connected.length) {
      setExpanded((prev) => {
        const next = new Set(prev);
        connected.forEach((id) => next.add(id));
        return next;
      });
    }
  }, [ws.connState]);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }

  return (
    <aside className="flex w-64 shrink-0 flex-col border-r border-border bg-surface">
      <div className="flex items-center justify-between border-b border-border px-3 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wider text-muted">Hosts</span>
        <button
          onClick={onCollapse}
          className="rounded p-0.5 text-muted hover:bg-surface-2 hover:text-fg"
          title="Collapse sidebar"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {sessions.length === 0 ? (
          <div className="px-4 py-3 text-xs text-muted">
            No sessions.{" "}
            <Link to="/" className="text-accent hover:underline">Add one</Link>
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.label ?? "__none__"}>
              {group.label && (
                <div className="mx-2 mb-0.5 mt-2 flex items-center gap-2 first:mt-1">
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-muted/70">{group.label}</span>
                  <hr className="flex-1 border-border/50" />
                </div>
              )}
              {group.sessions.map((s) => (
                <SessionNode
                  key={s.id}
                  session={s}
                  ws={ws}
                  expanded={expanded.has(s.id)}
                  onToggle={() => toggle(s.id)}
                  consoleOpen={consoleSessionId === s.id}
                  onToggleConsole={() => onToggleConsole(s.id)}
                  upgradeFlow={upgradeFlows[s.id] ?? null}
                  onOpenWizard={onOpenWizard}
                  onOpenUpgrade={onOpenUpgrade}
                />
              ))}
            </div>
          ))
        )}
      </div>

      <div className="border-t border-border px-3 py-2 text-[11px] text-muted">
        <Link to="/" className="hover:text-fg">← Sessions</Link>
      </div>
    </aside>
  );
}

function SessionNode({
  session,
  ws,
  expanded,
  onToggle,
  consoleOpen,
  onToggleConsole,
  upgradeFlow,
  onOpenWizard,
  onOpenUpgrade,
}: {
  session: Session;
  ws: WorkspaceStore;
  expanded: boolean;
  onToggle: () => void;
  consoleOpen: boolean;
  onToggleConsole: () => void;
  upgradeFlow: UpgradeFlow | null;
  onOpenWizard: (sessionId: string, existing: UpgradeFlow | null) => void;
  onOpenUpgrade: (sessionId: string, sessionName: string, flow: UpgradeFlow) => void;
}) {
  const state = ws.connState[session.id] ?? "idle";
  const containers = ws.containers[session.id] ?? [];
  const loading = ws.containersLoading[session.id];
  const error = ws.connError[session.id];
  const containerErr = ws.containersError[session.id];
  const reconnectAttempts = ws.reconnectAttempts[session.id] ?? 0;
  const s3Config = useApp((s) => s.s3Config);
  const [serverUploading, setServerUploading] = useState(false);

  async function handleServerS3Upload() {
    if (!s3Config) return;
    const running = containers.filter((c) => c.state === "running");
    if (running.length === 0) {
      toast("ok", "No running containers to back up.");
      return;
    }
    setServerUploading(true);
    toast("ok", `Backing up ${running.length} container log(s) for ${session.name}…`);
    const results = await Promise.allSettled(
      running.map((c) => s3Api.uploadLogs(session.id, c.id, c.name))
    );
    results.forEach((r, i) => {
      if (r.status === "fulfilled") {
        toast("ok", `${running[i].name} → ${r.value}`);
      } else {
        toast("error", `S3 backup failed for ${running[i].name}: ${errorMessage(r.reason)}`);
      }
    });
    setServerUploading(false);
  }

  const statusRingColor =
    state === "connected" ? "bg-ok" :
    state === "connecting" ? "bg-warn animate-pulse" :
    state === "error" ? "bg-danger" : "bg-muted/40";

  const isConnected = state === "connected";
  const isConnecting = state === "connecting";
  const isIdle = state === "idle";
  const isError = state === "error";

  return (
    <div className="mx-1.5 my-0.5">
      <div
        className={`rounded-lg border transition-colors ${
          isConnected
            ? "border-border/70 bg-surface"
            : isError
            ? "border-danger/20 bg-danger/5"
            : "border-transparent hover:border-border/40 hover:bg-surface/60"
        }`}
      >
        {/* ── Row 1: expand + dot + name ── */}
        <div className="flex items-center gap-2 px-2 pt-2 pb-1.5">
          <button
            onClick={onToggle}
            className="flex-none rounded p-0.5 text-[10px] text-muted hover:text-fg transition-colors"
            aria-label={expanded ? "Collapse" : "Expand"}
          >
            {expanded ? "▾" : "▸"}
          </button>
          <span
            className={`shrink-0 h-2 w-2 rounded-full ${statusRingColor}`}
            style={session.color ? { boxShadow: `0 0 0 2px ${session.color}22` } : undefined}
          />
          <button
            onClick={onToggle}
            className="min-w-0 flex-1 truncate text-left text-[13px] font-semibold text-fg hover:text-fg"
            title={`${session.username}@${session.host}:${session.port}`}
          >
            {session.name}
          </button>
          {isConnected && (
            <span className="shrink-0 rounded-full bg-ok/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-ok">
              live
            </span>
          )}
          {isConnecting && (
            <span className="shrink-0 rounded-full bg-warn/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-warn">
              connecting
            </span>
          )}
        </div>

        {/* ── Row 2: host info + action buttons (connected) ── */}
        {isConnected && (
          <div className="flex items-center justify-between gap-1 px-2 pb-2">
            <span className="min-w-0 truncate text-[10px] text-muted">
              {session.username}@{session.host}
            </span>
            <div className="flex shrink-0 items-center gap-0.5">
              {upgradeFlow && (
                <button
                  onClick={() => onOpenUpgrade(session.id, session.name, upgradeFlow)}
                  title={`Run upgrade: ${upgradeFlow.label ?? session.name}`}
                  className="rounded p-1 text-indigo-400 hover:bg-indigo-500/15 transition-colors"
                >
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/>
                    <path d="m12 15-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/>
                    <path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/>
                    <path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/>
                  </svg>
                </button>
              )}
              {s3Config && (
                <button
                  onClick={handleServerS3Upload}
                  disabled={serverUploading}
                  title="Back up all container logs to S3"
                  className="rounded p-1 text-muted hover:text-accent hover:bg-accent/10 disabled:opacity-40 transition-colors"
                >
                  {serverUploading ? (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
                      <path d="M21 12a9 9 0 1 1-6.219-8.56"/>
                    </svg>
                  ) : (
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 14.899A7 7 0 1 1 15.71 8h1.79a4.5 4.5 0 0 1 2.5 8.242"/>
                      <path d="M12 12v9"/>
                      <path d="m16 16-4-4-4 4"/>
                    </svg>
                  )}
                </button>
              )}
              <button
                onClick={() => onOpenWizard(session.id, upgradeFlow)}
                title={upgradeFlow ? "Edit upgrade flow" : "Set up upgrade flow"}
                className="rounded p-1 text-muted hover:text-fg hover:bg-surface-2 transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/>
                  <circle cx="12" cy="12" r="3"/>
                </svg>
              </button>
              <button
                onClick={onToggleConsole}
                title="Toggle console"
                className={`rounded p-1 transition-colors ${consoleOpen ? "text-accent bg-accent/10" : "text-muted hover:text-fg hover:bg-surface-2"}`}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="4 17 10 11 4 5"/>
                  <line x1="12" x2="20" y1="19" y2="19"/>
                </svg>
              </button>
              <button
                onClick={() => ws.refreshContainers(session.id)}
                disabled={!!loading}
                title="Refresh containers"
                className="rounded p-1 text-muted hover:text-fg hover:bg-surface-2 disabled:opacity-40 transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/>
                  <path d="M21 3v5h-5"/>
                  <path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/>
                  <path d="M8 16H3v5"/>
                </svg>
              </button>
              <button
                onClick={() => ws.disconnect(session.id)}
                title="Disconnect"
                className="rounded p-1 text-muted hover:text-danger hover:bg-danger/10 transition-colors"
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="18" x2="6" y1="6" y2="18"/><line x1="6" x2="18" y1="6" y2="18"/>
                </svg>
              </button>
            </div>
          </div>
        )}

        {/* ── Row 2: connect button (idle) ── */}
        {isIdle && (
          <div className="px-2 pb-2">
            <button
              onClick={() => ws.connect(session.id)}
              className="w-full rounded-md bg-accent/10 px-3 py-1.5 text-[11px] font-semibold text-accent hover:bg-accent/20 transition-colors"
            >
              Connect
            </button>
          </div>
        )}

        {/* ── Row 2: error + retry (error) ── */}
        {isError && (
          <div className="px-2 pb-2 space-y-1.5">
            {error && (
              <div className="text-[10px] text-danger leading-tight">
                {error}
                {reconnectAttempts > 0 && (
                  <span className="ml-1 text-muted/70">(retry {reconnectAttempts})</span>
                )}
              </div>
            )}
            <button
              onClick={() => ws.connect(session.id)}
              className="w-full rounded-md border border-danger/30 bg-danger/5 px-3 py-1.5 text-[11px] font-semibold text-danger hover:bg-danger/15 transition-colors"
            >
              Retry connection
            </button>
          </div>
        )}
      </div>

      {expanded && state === "connected" && (
        <div className="ml-4">
          {loading && <div className="py-1 pl-4 text-[11px] text-muted">Loading…</div>}
          {containerErr && (
            <div className="py-1 pl-4 text-[11px] text-danger">{containerErr}</div>
          )}
          {!loading && !containerErr && containers.length === 0 && (
            <div className="py-1 pl-4 text-[11px] text-muted">No containers</div>
          )}
          {containers.map((c) => {
            const isActive = ws.tabs.some(
              (t) => t.containerId === c.id && t.sessionId === session.id && t.id === ws.activeTabId,
            );
            const isSplit = ws.tabs.some(
              (t) => t.containerId === c.id && t.sessionId === session.id && t.id === ws.splitTabId,
            );
            return (
              <div key={c.id} className="group/container relative">
                <button
                  onClick={() => ws.openTab(session.id, c)}
                  className={`w-full rounded px-2 py-1 text-left transition-colors ${
                    isActive ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
                  }`}
                >
                  <div className="flex items-center gap-1.5 pr-5">
                    <span className={`text-[9px] ${c.state === "running" ? "text-ok" : "text-muted"}`}>●</span>
                    <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{c.name}</span>
                    {isSplit && <span className="text-[9px] text-accent">⊟</span>}
                  </div>
                  <div className="ml-3 truncate text-[10.5px] text-muted">{c.image}</div>
                </button>
                <SnapshotButton sessionId={session.id} containerId={c.id} containerName={c.name} />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Snapshot button ─────────────────────────────────────────────────────────

function SnapshotButton({
  sessionId,
  containerId,
  containerName,
  inline = false,
}: {
  sessionId: string;
  containerId: string;
  containerName: string;
  /** When true, renders as a plain inline button instead of absolute-positioned */
  inline?: boolean;
}) {
  const [saving, setSaving] = useState(false);

  async function handleSnapshot() {
    setSaving(true);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const date = new Date().toISOString().slice(0, 10);
      const path = await save({
        defaultPath: `${containerName}_${date}.log`,
        filters: [{ name: "Log file", extensions: ["log", "txt"] }],
      });
      if (!path) return;
      await api.snapshotContainerLogs(sessionId, containerId, path);
      const filename = path.split(/[\\/]/).pop() ?? path;
      toast("ok", `Snapshot saved to ${filename}`);
    } catch (e) {
      toast("error", errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <button
      onClick={(e) => { e.stopPropagation(); handleSnapshot(); }}
      disabled={saving}
      title="Snapshot archived logs to file"
      className={
        inline
          ? "rounded px-1.5 py-0.5 text-[10px] text-white/20 hover:text-white/50 transition-colors disabled:opacity-40"
          : "absolute right-1 top-1 hidden rounded p-0.5 text-[10px] text-muted hover:text-accent group-hover/container:block disabled:opacity-40"
      }
    >
      {saving ? "…" : "⬇"}
    </button>
  );
}

// ─── Tab bar ─────────────────────────────────────────────────────────────────

function TabBar({
  tabs,
  sessions,
  activeTabId,
  splitTabId,
  sidebarOpen,
  hasSplit,
  diffMode,
  onSelect,
  onClose,
  onSplit,
  onOpenPalette,
  onExpandSidebar,
  onToggleDiff,
}: {
  tabs: Tab[];
  sessions: Session[];
  activeTabId: string | null;
  splitTabId: string | null;
  sidebarOpen: boolean;
  hasSplit: boolean;
  diffMode: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onSplit: (id: string) => void;
  onOpenPalette: () => void;
  onExpandSidebar: () => void;
  onToggleDiff: () => void;
}) {
  return (
    <div className="flex items-stretch border-b border-border bg-surface">
      {!sidebarOpen && (
        <button
          onClick={onExpandSidebar}
          className="shrink-0 border-r border-border px-2.5 text-muted hover:bg-surface-2 hover:text-fg"
          title="Expand sidebar"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M9 18l6-6-6-6" />
          </svg>
        </button>
      )}

      <div className="flex min-w-0 flex-1 overflow-x-auto">
        {tabs.length === 0 ? (
          <div className="flex items-center px-3 text-[12px] text-muted">No panes open</div>
        ) : (
          tabs.map((tab) => {
            const session = sessions.find((s) => s.id === tab.sessionId);
            const isActive = tab.id === activeTabId;
            const isSplit = tab.id === splitTabId;
            return (
              <div
                key={tab.id}
                className={`group flex shrink-0 cursor-pointer items-center gap-1.5 border-r border-border px-3 py-2 text-[12px] transition-colors ${
                  isActive
                    ? "bg-surface-2 text-fg"
                    : "text-muted hover:bg-surface-2/60 hover:text-fg"
                }`}
                onClick={() => onSelect(tab.id)}
              >
                {session && (
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: session.color }}
                  />
                )}
                <span className="max-w-[120px] truncate">{tab.containerName}</span>
                {isSplit && (
                  <span className="text-[9px] text-accent" title="Split pane">⊟</span>
                )}
                {!isSplit && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onSplit(tab.id); }}
                    className="hidden rounded p-0.5 text-[9px] text-muted hover:text-accent group-hover:inline-flex"
                    title="Open in split pane"
                  >
                    ⊟
                  </button>
                )}
                {isSplit && (
                  <button
                    onClick={(e) => { e.stopPropagation(); onSplit(tab.id); }}
                    className="rounded p-0.5 text-[9px] text-accent hover:text-muted"
                    title="Close split pane"
                  >
                    ⊟
                  </button>
                )}
                <button
                  onClick={(e) => { e.stopPropagation(); onClose(tab.id); }}
                  className="ml-0.5 rounded px-0.5 text-[11px] text-muted hover:bg-surface hover:text-danger"
                  title="Close tab"
                >
                  ×
                </button>
              </div>
            );
          })
        )}
      </div>

      {/* Diff toggle — only relevant when two panes are open */}
      {hasSplit && (
        <button
          onClick={onToggleDiff}
          className={`shrink-0 border-l border-border px-3 text-[11px] transition-colors ${
            diffMode
              ? "bg-accent/15 text-accent"
              : "text-muted hover:bg-surface-2 hover:text-fg"
          }`}
          title={diffMode ? "Disable diff mode" : "Enable diff mode (highlight line differences)"}
        >
          Diff
        </button>
      )}

      <button
        onClick={onOpenPalette}
        className="shrink-0 border-l border-border px-3 text-[11px] text-muted hover:bg-surface-2 hover:text-fg"
        title="Open command palette (Ctrl+K)"
      >
        ⌘K
      </button>
    </div>
  );
}

// ─── Empty pane ──────────────────────────────────────────────────────────────

function EmptyPane({ onOpenPalette }: { onOpenPalette: () => void }) {
  return (
    <div className="grid flex-1 place-items-center text-sm text-muted">
      <div className="text-center">
        <div>No pane open.</div>
        <div className="mt-2">
          Pick a container from the sidebar, or press{" "}
          <button
            onClick={onOpenPalette}
            className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-fg hover:bg-border"
          >
            Ctrl+K
          </button>{" "}
          to search.
        </div>
      </div>
    </div>
  );
}

// ─── Stats panel ─────────────────────────────────────────────────────────────

function StatsPanel({ stats, loading }: { stats: ContainerStats | null; loading: boolean }) {
  if (loading && !stats) {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-[11px] text-muted">
        Fetching stats… (docker needs ~1s to measure CPU)
      </div>
    );
  }
  if (!stats) {
    return (
      <div className="flex items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-[11px] text-muted">
        No stats available — container may have stopped.
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-4 border-b border-border bg-surface px-3 py-1.5 font-mono text-[11px]">
      <StatChip label="CPU" value={stats.cpu_perc} />
      <StatChip label="MEM" value={`${stats.mem_usage} (${stats.mem_perc})`} />
      <StatChip label="NET" value={stats.net_io} />
      <StatChip label="BLOCK" value={stats.block_io} />
      <StatChip label="PIDs" value={stats.pids} />
    </div>
  );
}

function StatChip({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex items-center gap-1">
      <span className="text-muted">{label}</span>
      <span className="text-fg">{value || "—"}</span>
    </span>
  );
}

// ─── Density scrubber ────────────────────────────────────────────────────────

const N_BUCKETS = 80;

function DensityScrubber({
  lines,
  onJump,
}: {
  lines: LogLine[];
  onJump: (idx: number) => void;
}) {
  const data = useMemo(() => {
    const ts: { i: number; t: number }[] = [];
    lines.forEach((l, i) => {
      if (l.ts) {
        const t = Date.parse(l.ts);
        if (!isNaN(t)) ts.push({ i, t });
      }
    });
    if (ts.length < 2) return null;
    const tMin = ts[0].t;
    const tMax = ts[ts.length - 1].t;
    if (tMin === tMax) return null;
    const range = tMax - tMin;
    const counts = new Array<number>(N_BUCKETS).fill(0);
    const firstIdx = new Array<number>(N_BUCKETS).fill(-1);
    for (const { i, t } of ts) {
      const b = Math.min(N_BUCKETS - 1, Math.floor(((t - tMin) / range) * N_BUCKETS));
      counts[b]++;
      if (firstIdx[b] === -1) firstIdx[b] = i;
    }
    const max = Math.max(...counts);
    const tMinLabel = new Date(tMin).toISOString().slice(11, 19);
    const tMaxLabel = new Date(tMax).toISOString().slice(11, 19);
    return { counts, firstIdx, max, tMinLabel, tMaxLabel };
  }, [lines]);

  if (!data) return null;

  return (
    <div
      className="flex h-4 shrink-0 cursor-crosshair border-t border-border/50 bg-surface"
      title={`Log density: ${data.tMinLabel} → ${data.tMaxLabel} — click to jump`}
    >
      {data.counts.map((count, i) => {
        const intensity = data.max > 0 ? count / data.max : 0;
        const idx = data.firstIdx[i];
        return (
          <div
            key={i}
            className="flex-1 transition-opacity hover:opacity-80"
            style={{
              backgroundColor:
                intensity > 0
                  ? `rgba(120, 200, 255, ${0.1 + intensity * 0.9})`
                  : "transparent",
            }}
            onClick={() => { if (idx !== -1) onJump(idx); }}
            title={count > 0 ? `${count} lines` : undefined}
          />
        );
      })}
    </div>
  );
}

// ─── Log pane ────────────────────────────────────────────────────────────────

interface JsonPanel {
  text: string;
  parsed: unknown;
}

function LogPane({
  sessionId,
  container,
  paneId,
  diffMode = false,
  diffLinesRef,
  diffTick,
  onDiffLines,
  scrollControllersRef,
}: {
  sessionId: string;
  container: Container;
  paneId?: string;
  diffMode?: boolean;
  diffLinesRef?: React.RefObject<Record<string, LogLine[]>>;
  diffTick?: number;
  onDiffLines?: () => void;
  scrollControllersRef?: React.RefObject<Record<string, (top: number) => void>>;
}) {
  // Track session connection state so the stream restarts when the session reconnects.
  const connState = useWorkspace((s) => s.connState[sessionId] ?? "idle");

  const [streamId, setStreamId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState("");
  const [tail, setTail] = useState(500);
  const [linesTick, setLinesTick] = useState(0);
  const [rateLines, setRateLines] = useState(0);
  const [streamEnded, setStreamEnded] = useState(false);

  // Phase 6: rules + JSON viewer
  const [rulesOpen, setRulesOpen] = useState(false);
  const [jsonPanel, setJsonPanel] = useState<JsonPanel | null>(null);
  const [savingFilter, setSavingFilter] = useState(false);
  const [saveFilterName, setSaveFilterName] = useState("");

  // Phase 7: stats
  const [statsOpen, setStatsOpen] = useState(false);
  const [stats, setStats] = useState<ContainerStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);

  // Phase 7: archive
  const archivePendingRef = useRef<LogLine[]>([]);
  const [archiveLoading, setArchiveLoading] = useState(false);
  const [showingArchive, setShowingArchive] = useState(false);

  // Phase 7: export dropdown
  const [exportOpen, setExportOpen] = useState(false);
  const exportRef = useRef<HTMLDivElement>(null);

  // S3 upload
  const s3Config = useApp((s) => s.s3Config);
  const s3UploadKey = `${sessionId}:${container.id}`;
  const s3UploadState = useWorkspace((s) => s.s3UploadState[s3UploadKey]);
  const setS3UploadState = useWorkspace((s) => s.setS3UploadState);

  async function handleS3Upload() {
    setS3UploadState(sessionId, container.id, { status: "uploading" });
    try {
      const key = await s3Api.uploadLogs(sessionId, container.id, container.name);
      setS3UploadState(sessionId, container.id, { status: "done", s3Key: key });
      toast("ok", `Logs uploaded → ${key}`);
    } catch (e) {
      const msg = errorMessage(e);
      setS3UploadState(sessionId, container.id, { status: "error", error: msg });
      toast("error", `S3 upload failed: ${msg}`);
    }
  }

  const filters = useRules((s) => s.filters);
  const highlights = useRules((s) => s.highlights);
  const addFilter = useRules((s) => s.addFilter);

  const linesRef = useRef<LogLine[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const pendingRef = useRef<LogLine[]>([]);
  const rateBucketRef = useRef(0);

  // Pre-compile highlight regexes.
  const compiledHighlights = useMemo(
    () =>
      highlights
        .filter((h) => h.enabled)
        .map((h) => {
          try { return { ...h, re: new RegExp(h.pattern, "i") }; } catch { return null; }
        })
        .filter(Boolean) as (typeof highlights[0] & { re: RegExp })[],
    [highlights],
  );

  // Lines/sec counter
  useEffect(() => {
    const id = setInterval(() => {
      setRateLines(rateBucketRef.current);
      rateBucketRef.current = 0;
    }, 1000);
    return () => clearInterval(id);
  }, []);

  // Archive flush — accumulate batches and flush every 5 seconds
  useEffect(() => {
    const id = setInterval(() => {
      const batch = archivePendingRef.current.splice(0);
      if (batch.length > 0) {
        api.archiveLogBatch(sessionId, container.id, batch).catch(() => {});
      }
    }, 5000);
    return () => {
      clearInterval(id);
      const remaining = archivePendingRef.current.splice(0);
      if (remaining.length > 0) {
        api.archiveLogBatch(sessionId, container.id, remaining).catch(() => {});
      }
    };
  }, [sessionId, container.id]);

  // Log stream lifecycle — restarts whenever sessionId, container, tail, or connState changes.
  // Guarded at the top: if the session isn't connected yet, we clear state and wait.
  useEffect(() => {
    setError(null);
    setStreamEnded(false);
    setShowingArchive(false);
    linesRef.current = [];
    pendingRef.current = [];
    archivePendingRef.current = [];
    setLinesTick((n) => n + 1);

    if (connState !== "connected") return;

    let unlistenBatch: (() => void) | null = null;
    let unlistenEnd: (() => void) | null = null;
    let active = true;
    let currentStream: string | null = null;

    (async () => {
      try {
        unlistenBatch = await onLogBatch((b) => {
          if (b.stream_id !== currentStream) return;
          rateBucketRef.current += b.lines.length;

          // Queue for archive
          archivePendingRef.current.push(...b.lines);

          // Check alert rules
          const { alerts, alertLastTriggered, markAlertTriggered } = useRules.getState();
          for (const rule of alerts) {
            if (!rule.enabled) continue;
            const last = alertLastTriggered[rule.id] ?? 0;
            if (Date.now() - last < ALERT_COOLDOWN_MS) continue;
            let re: RegExp;
            try { re = new RegExp(rule.pattern, "i"); } catch { continue; }
            const hit = b.lines.find((l) => re.test(l.text));
            if (hit) {
              markAlertTriggered(rule.id);
              fireNotification(rule.label, hit.text.slice(0, 120));
            }
          }

          if (pausedRef.current) {
            pendingRef.current.push(...b.lines);
            if (pendingRef.current.length > MAX_LINES)
              pendingRef.current.splice(0, pendingRef.current.length - MAX_LINES);
            return;
          }
          appendLines(linesRef.current, b.lines);
          setLinesTick((n) => n + 1);
        });
        unlistenEnd = await onLogEnd((e) => {
          if (e.stream_id !== currentStream) return;
          setStreamEnded(true);
        });
        const sid = await api.startLogStream(sessionId, container.id, tail);
        if (!active) { api.stopLogStream(sid).catch(() => {}); return; }
        currentStream = sid;
        setStreamId(sid);
      } catch (e) {
        if (active) setError(errorMessage(e));
      }
    })();

    return () => {
      active = false;
      if (unlistenBatch) unlistenBatch();
      if (unlistenEnd) unlistenEnd();
      if (currentStream) api.stopLogStream(currentStream).catch(() => {});
      setStreamId(null);
    };
  }, [sessionId, container.id, tail, connState]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!paused && pendingRef.current.length > 0) {
      appendLines(linesRef.current, pendingRef.current);
      pendingRef.current = [];
      setLinesTick((n) => n + 1);
    }
  }, [paused]);

  // Stats polling (only when stats panel is open)
  useEffect(() => {
    if (!statsOpen) return;
    let alive = true;
    const fetch = async () => {
      if (!alive) return;
      setStatsLoading(true);
      try {
        const all = await api.pollDockerStats(sessionId);
        if (!alive) return;
        // Match by short ID prefix (docker stats uses 12-char IDs)
        const mine = all.find(
          (s) =>
            container.id.slice(0, 12) === s.id.slice(0, 12) ||
            container.id === s.id,
        );
        setStats(mine ?? null);
      } catch { /* ignore */ } finally {
        if (alive) setStatsLoading(false);
      }
    };
    fetch();
    const id = setInterval(fetch, 10_000);
    return () => { alive = false; clearInterval(id); };
  }, [statsOpen, sessionId, container.id]);

  const filtered = useMemo(() => {
    void linesTick; // subscribe to tick
    if (!filter.trim()) return linesRef.current;
    try {
      const re = new RegExp(filter, "i");
      return linesRef.current.filter((l) => re.test(l.text));
    } catch {
      const needle = filter.toLowerCase();
      return linesRef.current.filter((l) => l.text.toLowerCase().includes(needle));
    }
  }, [filter, linesTick]);

  // Register our lines in the diff registry whenever they change
  useEffect(() => {
    if (!diffMode || !paneId || !diffLinesRef?.current) return;
    diffLinesRef.current[paneId] = linesRef.current.slice();
    onDiffLines?.();
  }, [linesTick, diffMode, paneId]); // eslint-disable-line react-hooks/exhaustive-deps

  // Cleanup diff registry on unmount
  useEffect(() => {
    return () => {
      if (paneId && diffLinesRef?.current) {
        delete diffLinesRef.current[paneId];
      }
    };
  }, [paneId, diffLinesRef]);

  // Get peer lines for diff rendering
  const peerLines = useMemo(() => {
    if (!diffMode || !paneId || !diffLinesRef?.current) return null;
    const peers = Object.entries(diffLinesRef.current).filter(([k]) => k !== paneId);
    return peers.length > 0 ? peers[0][1] : null;
  }, [diffMode, paneId, diffTick]); // eslint-disable-line react-hooks/exhaustive-deps

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 24,
  });

  // Auto-scroll to bottom
  useEffect(() => {
    if (!autoScroll || filtered.length === 0) return;
    virtualizer.scrollToIndex(filtered.length - 1, { align: "end" });
  }, [linesTick, autoScroll, filtered.length, virtualizer]);

  // Sync-scroll: register this pane's scroll controller and drive peer when scrolling
  useEffect(() => {
    if (!diffMode || !paneId || !scrollControllersRef?.current || !scrollRef.current) return;
    const el = scrollRef.current;

    scrollControllersRef.current[paneId] = (top: number) => {
      const e = el as HTMLDivElement & { _syncScrolling?: boolean };
      e._syncScrolling = true;
      e.scrollTop = top;
      setTimeout(() => { e._syncScrolling = false; }, 50);
    };

    const handleScroll = () => {
      const e = el as HTMLDivElement & { _syncScrolling?: boolean };
      if (e._syncScrolling) return;
      const top = e.scrollTop;
      Object.entries(scrollControllersRef.current!).forEach(([k, fn]) => {
        if (k !== paneId) fn(top);
      });
    };

    el.addEventListener("scroll", handleScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", handleScroll);
      delete scrollControllersRef.current![paneId];
    };
  }, [diffMode, paneId, scrollControllersRef]);

  // Close export dropdown on outside click
  useEffect(() => {
    if (!exportOpen) return;
    const h = (e: MouseEvent) => {
      if (exportRef.current && !exportRef.current.contains(e.target as Node)) {
        setExportOpen(false);
      }
    };
    document.addEventListener("mousedown", h);
    return () => document.removeEventListener("mousedown", h);
  }, [exportOpen]);

  function handleSaveFilter() {
    if (!saveFilterName.trim() || !filter.trim()) return;
    addFilter(saveFilterName.trim(), filter);
    setSavingFilter(false);
    setSaveFilterName("");
  }

  async function handleLoadArchive() {
    setArchiveLoading(true);
    try {
      const archived = await api.getArchivedLogs(sessionId, container.id, 5000);
      if (archived.length > 0) {
        linesRef.current = archived;
        pendingRef.current = [];
        setShowingArchive(true);
        setLinesTick((n) => n + 1);
      }
    } catch { /* ignore */ } finally {
      setArchiveLoading(false);
    }
  }

  async function handleExport(format: "txt" | "json") {
    setExportOpen(false);
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const path = await save({
        defaultPath: `${container.name}-logs.${format}`,
        filters: [
          format === "txt"
            ? { name: "Text file", extensions: ["txt"] }
            : { name: "JSON file", extensions: ["json"] },
        ],
      });
      if (!path) return;
      const lines = [...filtered];
      const content =
        format === "txt"
          ? lines.map((l) => `${l.ts ?? ""} ${l.text}`).join("\n")
          : JSON.stringify(lines, null, 2);
      await api.saveLogExport(path, content);
    } catch { /* ignore */ }
  }

  return (
    <>
      {/* ── Toolbar ── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-[12px]">
        <span className="font-medium">{container.name}</span>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-muted">
          {container.id.slice(0, 12)}
        </span>
        {container.status && <span className="text-muted">{container.status}</span>}

        {/* Container-level S3 upload — always visible, prominent badge */}
        <button
          onClick={s3Config ? handleS3Upload : undefined}
          disabled={s3UploadState?.status === "uploading"}
          title={
            !s3Config
              ? "S3 not configured — go to Settings → S3 Log Backup"
              : s3UploadState?.status === "done"
                ? `Uploaded → ${s3UploadState.s3Key}`
                : s3UploadState?.status === "error"
                  ? `Upload failed — click to retry`
                  : "Upload this container's logs to S3"
          }
          className={[
            "ml-auto flex items-center gap-1.5 rounded-md border px-2.5 py-1 text-[12px] font-medium transition-all select-none",
            s3UploadState?.status === "done"
              ? "border-ok/50 bg-ok/10 text-ok"
              : s3UploadState?.status === "error"
                ? "border-danger/50 bg-danger/10 text-danger cursor-pointer hover:bg-danger/20"
              : s3UploadState?.status === "uploading"
                ? "border-accent/40 bg-accent/10 text-accent cursor-wait"
              : s3Config
                ? "border-border text-muted cursor-pointer hover:border-accent/60 hover:bg-accent/10 hover:text-accent"
              : "border-dashed border-border/50 text-muted/40 cursor-default",
          ].join(" ")}
        >
          {s3UploadState?.status === "uploading" ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="animate-spin">
              <path d="M21 12a9 9 0 11-6.219-8.56"/>
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          )}
          <span>
            {s3UploadState?.status === "uploading"
              ? "Uploading…"
              : s3UploadState?.status === "done"
                ? "Uploaded"
                : s3UploadState?.status === "error"
                  ? "Retry S3"
                  : "S3 Backup"}
          </span>
        </button>

        <div className="flex flex-wrap items-center gap-1.5">
          {/* Filter input */}
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter (regex)"
            className="w-44 py-0.5 text-[12px]"
          />

          {/* Save current filter */}
          {!savingFilter && filter.trim() && (
            <button
              onClick={() => setSavingFilter(true)}
              title="Save filter as preset"
              className="rounded px-1.5 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-fg"
            >
              ★
            </button>
          )}
          {savingFilter && (
            <div className="flex items-center gap-1">
              <input
                autoFocus
                value={saveFilterName}
                onChange={(e) => setSaveFilterName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleSaveFilter();
                  else if (e.key === "Escape") { setSavingFilter(false); setSaveFilterName(""); }
                }}
                placeholder="preset name"
                className="w-28 rounded border border-border bg-surface-2 px-2 py-0.5 text-[11px] text-fg placeholder:text-muted focus:border-accent/60 focus:outline-none"
              />
              <button onClick={handleSaveFilter} disabled={!saveFilterName.trim()} className="rounded px-1.5 py-0.5 text-[11px] text-accent hover:bg-accent/10 disabled:opacity-40">Save</button>
              <button onClick={() => { setSavingFilter(false); setSaveFilterName(""); }} className="rounded px-1 py-0.5 text-[11px] text-muted hover:text-fg">✕</button>
            </div>
          )}

          {/* Filter presets */}
          {filters.length > 0 && (
            <select
              value=""
              onChange={(e) => { if (e.target.value) setFilter(e.target.value); }}
              className="rounded border border-border bg-surface-2 px-1 py-0.5 text-[11px] text-muted"
              title="Load saved filter"
            >
              <option value="">Presets…</option>
              {filters.map((f) => (
                <option key={f.id} value={f.pattern}>{f.name}</option>
              ))}
            </select>
          )}

          <select
            value={tail}
            onChange={(e) => setTail(Number(e.target.value))}
            className="rounded border border-border bg-surface-2 px-1 py-0.5 text-[11px] text-muted"
          >
            <option value={100}>tail 100</option>
            <option value={500}>tail 500</option>
            <option value={2000}>tail 2k</option>
            <option value={10000}>tail 10k</option>
          </select>

          <Button variant="ghost" className="px-2 py-0.5 text-[11px]" onClick={() => setPaused((p) => !p)}>
            {paused ? "Resume" : "Pause"}
          </Button>
          <Button variant="ghost" className="px-2 py-0.5 text-[11px]" onClick={() => setAutoScroll((a) => !a)}>
            {autoScroll ? "⇊ Auto" : "⇊ Manual"}
          </Button>
          <Button variant="ghost" className="px-2 py-0.5 text-[11px]" onClick={() => {
            linesRef.current = []; pendingRef.current = []; setShowingArchive(false); setLinesTick((n) => n + 1);
          }}>
            Clear
          </Button>

          {/* Stats toggle */}
          <button
            onClick={() => setStatsOpen((o) => !o)}
            title="Toggle stats panel"
            className={`rounded px-2 py-0.5 text-[11px] transition-colors ${
              statsOpen ? "bg-accent/15 text-accent" : "text-muted hover:bg-surface-2 hover:text-fg"
            }`}
          >
            Stats
          </button>

          {/* Archive load */}
          <button
            onClick={handleLoadArchive}
            disabled={archiveLoading}
            title="Load archived logs for this container"
            className="rounded px-2 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-40"
          >
            {archiveLoading ? "…" : "Archive"}
          </button>

          {/* Export dropdown */}
          <div ref={exportRef} className="relative">
            <button
              onClick={() => setExportOpen((o) => !o)}
              title="Export logs"
              className="rounded px-2 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-fg"
            >
              Export ▾
            </button>
            {exportOpen && (
              <div className="absolute right-0 top-full z-50 mt-1 flex flex-col rounded border border-border bg-surface shadow-lg">
                <button
                  onClick={() => handleExport("txt")}
                  className="px-4 py-1.5 text-left text-[11px] text-fg hover:bg-surface-2"
                >
                  Export as .txt
                </button>
                <button
                  onClick={() => handleExport("json")}
                  className="px-4 py-1.5 text-left text-[11px] text-fg hover:bg-surface-2"
                >
                  Export as .json
                </button>
              </div>
            )}
          </div>

          {/* Rules button */}
          <button
            onClick={() => setRulesOpen(true)}
            title="Manage filters, highlights and alerts"
            className="rounded px-2 py-0.5 text-[11px] text-muted hover:bg-surface-2 hover:text-fg"
          >
            Rules
          </button>
        </div>
      </div>

      {/* ── Stats panel ── */}
      {statsOpen && <StatsPanel stats={stats} loading={statsLoading} />}

      {/* ── Log scroll area ── */}
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-bg font-mono text-[12px] leading-[18px]">
        {connState !== "connected" ? (
          <div className="p-4 text-muted">
            {connState === "connecting" && "Connecting to host…"}
            {connState === "error" && "Connection failed — retrying in background…"}
            {connState === "idle" && "Not connected. Use the sidebar to connect."}
          </div>
        ) : error ? (
          <div className="p-4 text-danger">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-muted">{streamId ? "Waiting for output…" : "Starting stream…"}</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const line = filtered[vi.index];
              const highlight = compiledHighlights.find((h) => h.re.test(line.text));

              // Diff coloring: compare line text with peer's line at same index
              let diffBg = "";
              if (diffMode && peerLines) {
                const peer = peerLines[vi.index];
                if (peer === undefined) {
                  diffBg = "bg-surface-2/60";
                } else if (peer.text !== line.text) {
                  diffBg = "bg-warn/10";
                }
              }

              const baseColor = highlight
                ? HIGHLIGHT_COLOR_CLASSES[highlight.color]
                : line.stderr
                ? "text-danger"
                : "text-fg";

              // Detect JSON
              let parsedJson: unknown = undefined;
              const trimmed = line.text.trim();
              if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
                try { parsedJson = JSON.parse(trimmed); } catch { /* not JSON */ }
              }

              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", height: ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
                  className={`flex items-baseline whitespace-pre px-3 ${baseColor} ${diffBg}`}
                >
                  {line.ts && <span className="mr-2 shrink-0 text-muted">{line.ts.slice(11, 23)}</span>}
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">{line.text}</span>
                  {parsedJson !== undefined && (
                    <button
                      onClick={() => setJsonPanel(jsonPanel?.text === line.text ? null : { text: line.text, parsed: parsedJson })}
                      title="View formatted JSON"
                      className="ml-1.5 shrink-0 rounded px-1 text-[10px] text-muted opacity-60 hover:opacity-100"
                    >
                      {"{ }"}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* ── Density scrubber ── */}
      <DensityScrubber
        lines={filtered}
        onJump={(idx) => {
          setAutoScroll(false);
          virtualizer.scrollToIndex(idx, { align: "start" });
        }}
      />

      {/* ── JSON viewer panel ── */}
      {jsonPanel && (
        <div className="shrink-0 border-t border-border bg-surface-2" style={{ height: 192 }}>
          <div className="flex items-center border-b border-border px-3 py-1">
            <span className="flex-1 font-mono text-[11px] font-medium text-muted">JSON</span>
            <button
              onClick={() => setJsonPanel(null)}
              className="rounded p-0.5 text-muted hover:bg-surface hover:text-fg"
              title="Close JSON viewer"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M18 6 6 18M6 6l12 12" />
              </svg>
            </button>
          </div>
          <div className="h-[calc(100%-28px)] overflow-auto px-3 py-2">
            <pre className="font-mono text-[11px] leading-relaxed">
              {colorizeJson(JSON.stringify(jsonPanel.parsed, null, 2))}
            </pre>
          </div>
        </div>
      )}

      {/* ── Footer ── */}
      <footer className="flex items-center gap-3 border-t border-border bg-surface px-3 py-1 font-mono text-[11px] text-muted">
        <span className={
          connState !== "connected" ? "text-warn" :
          streamEnded ? "text-warn" : "text-ok"
        }>●</span>
        <span>
          {connState === "connecting" ? "connecting" :
           connState === "error" ? "disconnected" :
           connState === "idle" ? "idle" :
           streamEnded ? "ended" : paused ? "paused" : showingArchive ? "archive" : "live"}
        </span>
        <span>· {rateLines} lines/s</span>
        <span>· {filtered.length}{filter ? `/${linesRef.current.length}` : ""} lines</span>
        {pendingRef.current.length > 0 && <span>· {pendingRef.current.length} buffered</span>}
        {showingArchive && <span className="text-accent">· archived data</span>}
      </footer>

      <RulesModal open={rulesOpen} onClose={() => setRulesOpen(false)} />
    </>
  );
}

function appendLines(buf: LogLine[], add: LogLine[]) {
  buf.push(...add);
  if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES);
}

function fireNotification(title: string, body: string) {
  if (!("Notification" in window)) return;
  if (Notification.permission === "granted") {
    new Notification(title, { body });
  } else if (Notification.permission !== "denied") {
    Notification.requestPermission().then((p) => {
      if (p === "granted") new Notification(title, { body });
    }).catch(() => {});
  }
}

function colorizeJson(json: string): React.ReactNode {
  const re = /("(?:[^"\\]|\\.)*"(?=\s*:))|("(?:[^"\\]|\\.)*")|([-\d.eE+]+)|(true|false|null)|([{}[\],:])/g;
  const parts: React.ReactNode[] = [];
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(json)) !== null) {
    if (m.index > last) parts.push(<span key={`w${last}`} className="text-muted">{json.slice(last, m.index)}</span>);
    const [full, key, str, num, bool] = m;
    if (key)  parts.push(<span key={m.index} className="text-accent">{key}</span>);
    else if (str)  parts.push(<span key={m.index} className="text-ok">{str}</span>);
    else if (num)  parts.push(<span key={m.index} className="text-warn">{num}</span>);
    else if (bool) parts.push(<span key={m.index} className="text-warn">{bool}</span>);
    else           parts.push(<span key={m.index} className="text-muted">{full}</span>);
    last = m.index + full.length;
  }
  if (last < json.length) parts.push(<span key="tail" className="text-muted">{json.slice(last)}</span>);
  return <>{parts}</>;
}

// ─── Console pane ─────────────────────────────────────────────────────────────

interface ConsoleEntry {
  id: number;
  command: string;
  result?: RemoteCmdResult;
  error?: string;
  pending: boolean;
  ms?: number;
  source: "user" | string;
}

const QUICK_COMMANDS = [
  "docker ps -a",
  "docker ps -a --no-trunc --format '{{json .}}'",
  "which docker",
  "docker --version",
  "id",
  "echo $PATH",
];

function shellSq(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

function ConsolePane({
  sessionId,
  compact,
  onClose,
}: {
  sessionId: string;
  compact: boolean;
  onClose: () => void;
}) {
  const [input, setInput] = useState("");
  const [history, setHistory] = useState<ConsoleEntry[]>([]);
  const [running, setRunning] = useState(false);
  const [cwd, setCwd] = useState<string>("");
  const [cmdHistory, setCmdHistory] = useState<string[]>([]);
  const [historyIdx, setHistoryIdx] = useState(-1);
  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const focusInput = useCallback(() => {
    setTimeout(() => inputRef.current?.focus(), 0);
  }, []);

  useEffect(() => {
    if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [history]);

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let alive = true;
    (async () => {
      const off = await onDiagCommand((d: DiagCommand) => {
        const id = ++idRef.current;
        setHistory((h) => [
          ...h,
          {
            id,
            command: d.command,
            pending: false,
            source: d.source,
            result: { stdout: d.stdout, stderr: d.stderr, exit: d.exit, truncated: false },
          },
        ]);
      });
      if (alive) unlisten = off; else off();
    })();
    return () => { alive = false; if (unlisten) unlisten(); };
  }, []);

  const submit = useCallback(async (cmd: string) => {
    const command = cmd.trim();
    if (!command || running) return;
    setInput("");
    setHistoryIdx(-1);
    setCmdHistory((h) => [command, ...h.slice(0, 99)]);
    const isCd = /^cd(\s|$)/.test(command);
    const id = ++idRef.current;
    setHistory((h) => [...h, { id, command, pending: true, source: "user" }]);
    setRunning(true);
    const t0 = performance.now();
    try {
      const actualCommand = isCd
        ? (cwd ? `cd ${shellSq(cwd)} && ${command} && pwd` : `${command} && pwd`)
        : (cwd ? `cd ${shellSq(cwd)} && ${command}` : command);
      const result = await api.runRemoteCommand(sessionId, actualCommand);
      const ms = Math.round(performance.now() - t0);
      if (isCd && (result.exit === 0 || result.exit == null) && !result.stderr.trim()) {
        const lines = result.stdout.trimEnd().split("\n");
        const newCwd = lines[lines.length - 1]?.trim() ?? "";
        if (newCwd) setCwd(newCwd);
        const displayStdout = lines.slice(0, -1).join("\n");
        setHistory((h) => h.map((e) => e.id === id ? { ...e, pending: false, result: { ...result, stdout: displayStdout }, ms } : e));
      } else {
        setHistory((h) => h.map((e) => e.id === id ? { ...e, pending: false, result, ms } : e));
      }
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      setHistory((h) => h.map((e) => e.id === id ? { ...e, pending: false, error: errorMessage(e), ms } : e));
    } finally {
      setRunning(false);
      focusInput();
    }
  }, [sessionId, running, cwd, focusInput]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowUp") {
      e.preventDefault();
      const idx = Math.min(historyIdx + 1, cmdHistory.length - 1);
      setHistoryIdx(idx);
      setInput(cmdHistory[idx] ?? "");
    } else if (e.key === "ArrowDown") {
      e.preventDefault();
      const idx = Math.max(historyIdx - 1, -1);
      setHistoryIdx(idx);
      setInput(idx === -1 ? "" : (cmdHistory[idx] ?? ""));
    }
  }, [historyIdx, cmdHistory]);

  const displayCwd = cwd ? cwd.replace(/^\/(?:home|Users)\/[^/]+/, "~") : "";

  return (
    <div className={`flex shrink-0 flex-col border-t border-border bg-surface ${compact ? "h-64" : "h-72"}`}>
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px]">
        <span className="font-medium text-fg">Console</span>
        <span className="text-muted">· {sessionId.slice(0, 8)}…</span>
        <div className="ml-auto flex flex-wrap items-center gap-1">
          {QUICK_COMMANDS.map((c) => (
            <button key={c} onClick={() => submit(c)} disabled={running}
              className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-muted hover:text-fg disabled:opacity-50"
              title={c}>
              {c.length > 22 ? c.slice(0, 21) + "…" : c}
            </button>
          ))}
          <button onClick={() => setHistory([])} className="rounded px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-surface-2 hover:text-fg">Clear</button>
          <button onClick={onClose} className="rounded px-1.5 py-0.5 text-[10.5px] text-muted hover:bg-surface-2 hover:text-danger">✕</button>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-bg px-3 py-2 font-mono text-[12px]">
        {history.length === 0
          ? <div className="text-muted">Type a command below, or click a preset above.</div>
          : history.map((e) => <ConsoleEntryView key={e.id} entry={e} />)
        }
      </div>
      <form onSubmit={(ev) => { ev.preventDefault(); submit(input); }}
        className="flex items-center gap-2 border-t border-border px-3 py-2">
        <span className="shrink-0 font-mono text-[12px] text-muted">
          {displayCwd && <span className="text-accent/80">{displayCwd}</span>}
          {" $"}
        </span>
        <input
          ref={inputRef}
          value={input}
          onChange={(ev) => { setInput(ev.target.value); setHistoryIdx(-1); }}
          onKeyDown={handleKeyDown}
          disabled={running}
          placeholder="docker ps -a"
          autoFocus
          className="flex-1 bg-transparent font-mono text-[12px] text-fg outline-none placeholder:text-muted"
        />
        <Button variant="primary" type="submit" disabled={running || !input.trim()} className="px-3 py-1 text-xs">
          {running ? "…" : "Run"}
        </Button>
      </form>
    </div>
  );
}

function ConsoleEntryView({ entry }: { entry: ConsoleEntry }) {
  const exit = entry.result?.exit;
  const exitColor = entry.error ? "text-danger" : exit == null ? "text-muted" : exit === 0 ? "text-ok" : "text-warn";
  return (
    <div className="mb-3">
      <div className="flex items-center gap-2 text-muted">
        {entry.source !== "user"
          ? <span className="shrink-0 rounded bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-accent" title={`beacon:${entry.source}`}>{entry.source}</span>
          : <span>$</span>
        }
        <span className="min-w-0 flex-1 break-all text-fg">{entry.command}</span>
        <span className="shrink-0 text-[10.5px]">
          {entry.pending ? "running…" : entry.ms != null ? `${entry.ms}ms` : ""}
          {!entry.pending && (entry.error || exit != null) && (
            <span className={`ml-2 ${exitColor}`}>{entry.error ? "error" : `exit ${exit}`}</span>
          )}
          {!entry.pending && !entry.error && exit == null && entry.source !== "user" && (
            <span className="ml-2 text-accent">(streaming)</span>
          )}
        </span>
      </div>
      {entry.error && <div className="mt-1 whitespace-pre-wrap text-danger">{entry.error}</div>}
      {entry.result?.stdout && <pre className="mt-1 whitespace-pre-wrap text-fg">{entry.result.stdout}</pre>}
      {entry.result?.stderr && <pre className="mt-1 whitespace-pre-wrap text-danger/90">{entry.result.stderr}</pre>}
      {entry.result?.truncated && <div className="mt-1 text-[10.5px] text-warn">(output truncated)</div>}
    </div>
  );
}
