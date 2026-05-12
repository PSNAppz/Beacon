import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  api,
  errorMessage,
  onDiagCommand,
  onLogBatch,
  onLogEnd,
  type Container,
  type DiagCommand,
  type LogLine,
  type RemoteCmdResult,
  type Session,
} from "../lib/ipc";
import { useApp } from "../lib/store";
import {
  loadSavedTabs,
  useWorkspace,
  type Tab,
  type WorkspaceStore,
} from "../lib/workspaceStore";
import { Button, Input } from "../components/ui";
import { CommandPalette } from "./CommandPalette";

const MAX_LINES = 10_000;
const ROW_HEIGHT = 18;

// ─── Page ────────────────────────────────────────────────────────────────────

export function WorkspacePage() {
  const { sessionId: routeSessionId } = useParams<{ sessionId?: string }>();
  const sessions = useApp((s) => s.sessions);
  const ws = useWorkspace();

  const [paletteOpen, setPaletteOpen] = useState(false);
  const [consoleSessionId, setConsoleSessionId] = useState<string | null>(null);
  const [sidebarOpen, setSidebarOpen] = useState(true);

  // Restore persisted tabs on first mount.
  const restoredRef = useRef(false);
  useEffect(() => {
    if (restoredRef.current) return;
    restoredRef.current = true;
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

  // Disconnect everything on unmount (vault lock / navigate away).
  useEffect(() => {
    return () => {
      const { connState } = useWorkspace.getState();
      Object.entries(connState).forEach(([id, st]) => {
        if (st === "connected") api.disconnectSession(id).catch(() => {});
      });
      useWorkspace.setState({ connState: {} });
    };
  }, []);

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

  return (
    <div className="flex h-full">
      {/* ── Left: host tree ── */}
      {sidebarOpen && (
        <HostTree
          sessions={sessions}
          ws={ws}
          consoleSessionId={consoleSessionId}
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
          onSelect={ws.setActiveTab}
          onClose={ws.closeTab}
          onSplit={(tabId) =>
            ws.setSplitTab(ws.splitTabId === tabId ? null : tabId)
          }
          onOpenPalette={() => setPaletteOpen(true)}
          onExpandSidebar={() => setSidebarOpen(true)}
        />

        {/* Panes */}
        <div className={`flex min-h-0 flex-1 ${splitTab ? "divide-x divide-border" : "flex-col"}`}>
          <div className="flex min-h-0 flex-1 flex-col">
            {activeTab ? (
              <LogPane
                key={activeTab.id}
                sessionId={activeTab.sessionId}
                container={resolveContainer(activeTab)}
              />
            ) : (
              <EmptyPane onOpenPalette={() => setPaletteOpen(true)} />
            )}
          </div>
          {splitTab && (
            <div className="flex min-h-0 flex-1 flex-col">
              <LogPane
                key={splitTab.id}
                sessionId={splitTab.sessionId}
                container={resolveContainer(splitTab)}
              />
            </div>
          )}
        </div>

        {/* Console strip */}
        {consoleSessionId && consoleConn === "connected" && (
          <ConsolePane
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
    </div>
  );
}

// ─── Host tree ────────────────────────────────────────────────────────────────

function HostTree({
  sessions,
  ws,
  consoleSessionId,
  onToggleConsole,
  onCollapse,
}: {
  sessions: Session[];
  ws: WorkspaceStore;
  consoleSessionId: string | null;
  onToggleConsole: (id: string) => void;
  onCollapse: () => void;
}) {
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());

  // Auto-expand a session when it becomes connected.
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
          sessions.map((s) => (
            <SessionNode
              key={s.id}
              session={s}
              ws={ws}
              expanded={expanded.has(s.id)}
              onToggle={() => toggle(s.id)}
              consoleOpen={consoleSessionId === s.id}
              onToggleConsole={() => onToggleConsole(s.id)}
            />
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
}: {
  session: Session;
  ws: WorkspaceStore;
  expanded: boolean;
  onToggle: () => void;
  consoleOpen: boolean;
  onToggleConsole: () => void;
}) {
  const state = ws.connState[session.id] ?? "idle";
  const containers = ws.containers[session.id] ?? [];
  const loading = ws.containersLoading[session.id];
  const error = ws.connError[session.id];
  const containerErr = ws.containersError[session.id];

  const dotColor =
    state === "connected" ? "text-ok" :
    state === "connecting" ? "text-warn" :
    state === "error" ? "text-danger" : "text-muted";

  return (
    <div>
      {/* Session row */}
      <div className="flex items-center gap-1 px-2 py-1">
        <button
          onClick={onToggle}
          className="flex-none rounded p-0.5 text-[10px] text-muted hover:text-fg"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          {expanded ? "▾" : "▸"}
        </button>
        <span className={`shrink-0 text-[10px] ${dotColor}`}>●</span>
        <button
          onClick={onToggle}
          className="min-w-0 flex-1 truncate text-left text-[13px] font-medium hover:text-fg"
          title={`${session.username}@${session.host}:${session.port}`}
        >
          {session.name}
        </button>

        {state === "connected" && (
          <button
            onClick={onToggleConsole}
            className={`rounded p-0.5 text-[10px] ${consoleOpen ? "text-accent" : "text-muted hover:text-fg"}`}
            title="Toggle console"
          >
            {">_"}
          </button>
        )}
        {state === "connected" && (
          <button
            onClick={() => ws.refreshContainers(session.id)}
            disabled={!!loading}
            className="rounded p-0.5 text-[10px] text-muted hover:text-fg disabled:opacity-40"
            title="Refresh containers"
          >
            ↻
          </button>
        )}
        {(state === "idle" || state === "error") && (
          <button
            onClick={() => ws.connect(session.id)}
            className="rounded px-1.5 py-0.5 text-[10px] text-accent hover:bg-accent/10"
          >
            Connect
          </button>
        )}
        {state === "connecting" && (
          <span className="text-[10px] text-warn">…</span>
        )}
        {state === "connected" && (
          <button
            onClick={() => ws.disconnect(session.id)}
            className="rounded p-0.5 text-[10px] text-muted hover:text-danger"
            title="Disconnect"
          >
            ✕
          </button>
        )}
      </div>

      {/* Error */}
      {state === "error" && error && (
        <div className="ml-6 px-2 pb-1 text-[11px] text-danger">{error}</div>
      )}

      {/* Container list */}
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
              <button
                key={c.id}
                onClick={() => ws.openTab(session.id, c)}
                className={`w-full rounded px-2 py-1 text-left transition-colors ${
                  isActive
                    ? "bg-surface-2 text-fg"
                    : "text-muted hover:bg-surface-2 hover:text-fg"
                }`}
              >
                <div className="flex items-center gap-1.5">
                  <span className={`text-[9px] ${c.state === "running" ? "text-ok" : "text-muted"}`}>●</span>
                  <span className="min-w-0 flex-1 truncate text-[12px] font-medium">{c.name}</span>
                  {isSplit && <span className="text-[9px] text-accent">⊟</span>}
                </div>
                <div className="ml-3 truncate text-[10.5px] text-muted">{c.image}</div>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── Tab bar ─────────────────────────────────────────────────────────────────

function TabBar({
  tabs,
  sessions,
  activeTabId,
  splitTabId,
  sidebarOpen,
  onSelect,
  onClose,
  onSplit,
  onOpenPalette,
  onExpandSidebar,
}: {
  tabs: Tab[];
  sessions: Session[];
  activeTabId: string | null;
  splitTabId: string | null;
  sidebarOpen: boolean;
  onSelect: (id: string) => void;
  onClose: (id: string) => void;
  onSplit: (id: string) => void;
  onOpenPalette: () => void;
  onExpandSidebar: () => void;
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

      {/* Scrollable tab list */}
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
                {/* Split toggle — visible on hover or when already split */}
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

      {/* Ctrl+K button */}
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

// ─── Log pane ────────────────────────────────────────────────────────────────

function LogPane({ sessionId, container }: { sessionId: string; container: Container }) {
  const [streamId, setStreamId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [filter, setFilter] = useState("");
  const [tail, setTail] = useState(500);
  const [linesTick, setLinesTick] = useState(0);
  const [rateLines, setRateLines] = useState(0);
  const [streamEnded, setStreamEnded] = useState(false);

  const linesRef = useRef<LogLine[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const pendingRef = useRef<LogLine[]>([]);
  const rateBucketRef = useRef(0);

  useEffect(() => {
    const id = setInterval(() => {
      setRateLines(rateBucketRef.current);
      rateBucketRef.current = 0;
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    let unlistenBatch: (() => void) | null = null;
    let unlistenEnd: (() => void) | null = null;
    let active = true;
    let currentStream: string | null = null;

    setError(null);
    setStreamEnded(false);
    linesRef.current = [];
    pendingRef.current = [];
    setLinesTick((n) => n + 1);

    (async () => {
      try {
        unlistenBatch = await onLogBatch((b) => {
          if (b.stream_id !== currentStream) return;
          rateBucketRef.current += b.lines.length;
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
  }, [sessionId, container.id, tail]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!paused && pendingRef.current.length > 0) {
      appendLines(linesRef.current, pendingRef.current);
      pendingRef.current = [];
      setLinesTick((n) => n + 1);
    }
  }, [paused]);

  const filtered = useMemo(() => {
    if (!filter.trim()) return linesRef.current;
    try {
      const re = new RegExp(filter, "i");
      return linesRef.current.filter((l) => re.test(l.text));
    } catch {
      const needle = filter.toLowerCase();
      return linesRef.current.filter((l) => l.text.toLowerCase().includes(needle));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, linesTick]);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 24,
  });

  useEffect(() => {
    if (!autoScroll || filtered.length === 0) return;
    virtualizer.scrollToIndex(filtered.length - 1, { align: "end" });
  }, [linesTick, autoScroll, filtered.length, virtualizer]);

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b border-border bg-surface px-3 py-1.5 text-[12px]">
        <span className="font-medium">{container.name}</span>
        <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-muted">
          {container.id.slice(0, 12)}
        </span>
        {container.status && <span className="text-muted">{container.status}</span>}
        <div className="ml-auto flex items-center gap-1.5">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="filter (regex)"
            className="w-44 py-0.5 text-[12px]"
          />
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
            linesRef.current = []; pendingRef.current = []; setLinesTick((n) => n + 1);
          }}>
            Clear
          </Button>
        </div>
      </div>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto bg-bg font-mono text-[12px] leading-[18px]">
        {error ? (
          <div className="p-4 text-danger">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="p-4 text-muted">{streamId ? "Waiting for output…" : "Starting stream…"}</div>
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const line = filtered[vi.index];
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  style={{ position: "absolute", top: 0, left: 0, width: "100%", height: ROW_HEIGHT, transform: `translateY(${vi.start}px)` }}
                  className={`whitespace-pre px-3 ${line.stderr ? "text-danger" : "text-fg"}`}
                >
                  {line.ts && <span className="mr-2 text-muted">{line.ts.slice(11, 23)}</span>}
                  {line.text}
                </div>
              );
            })}
          </div>
        )}
      </div>
      <footer className="flex items-center gap-3 border-t border-border bg-surface px-3 py-1 font-mono text-[11px] text-muted">
        <span className={streamEnded ? "text-warn" : "text-ok"}>●</span>
        <span>{streamEnded ? "ended" : paused ? "paused" : "live"}</span>
        <span>· {rateLines} lines/s</span>
        <span>· {filtered.length}{filter ? `/${linesRef.current.length}` : ""} lines</span>
        {pendingRef.current.length > 0 && <span>· {pendingRef.current.length} buffered</span>}
      </footer>
    </>
  );
}

function appendLines(buf: LogLine[], add: LogLine[]) {
  buf.push(...add);
  if (buf.length > MAX_LINES) buf.splice(0, buf.length - MAX_LINES);
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
  const idRef = useRef(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);

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
    const id = ++idRef.current;
    setHistory((h) => [...h, { id, command, pending: true, source: "user" }]);
    setRunning(true);
    const t0 = performance.now();
    try {
      const result = await api.runRemoteCommand(sessionId, command);
      const ms = Math.round(performance.now() - t0);
      setHistory((h) => h.map((e) => e.id === id ? { ...e, pending: false, result, ms } : e));
    } catch (e) {
      const ms = Math.round(performance.now() - t0);
      setHistory((h) => h.map((e) => e.id === id ? { ...e, pending: false, error: errorMessage(e), ms } : e));
    } finally {
      setRunning(false);
    }
  }, [sessionId, running]);

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
        <span className="font-mono text-[12px] text-muted">$</span>
        <input value={input} onChange={(ev) => setInput(ev.target.value)} disabled={running}
          placeholder="docker ps -a" autoFocus
          className="flex-1 bg-transparent font-mono text-[12px] text-fg outline-none placeholder:text-muted" />
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
