import { useEffect, useMemo, useRef, useState } from "react";
import { type Session } from "../lib/ipc";
import { type WorkspaceStore } from "../lib/workspaceStore";

type PaletteItem =
  | { kind: "session"; session: Session }
  | { kind: "container"; session: Session; containerId: string; containerName: string; containerImage: string };

interface Props {
  sessions: Session[];
  ws: WorkspaceStore;
  onClose: () => void;
}

export function CommandPalette({ sessions, ws, onClose }: Props) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const items = useMemo<PaletteItem[]>(() => {
    const all: PaletteItem[] = [];
    for (const session of sessions) {
      all.push({ kind: "session", session });
      for (const c of ws.containers[session.id] ?? []) {
        all.push({
          kind: "container",
          session,
          containerId: c.id,
          containerName: c.name,
          containerImage: c.image,
        });
      }
    }
    if (!query.trim()) return all;
    const q = query.toLowerCase();
    return all.filter((item) => {
      const label = item.kind === "session" ? item.session.name : item.containerName;
      const sub =
        item.kind === "session"
          ? `${item.session.username}@${item.session.host}`
          : `${item.session.name} ${item.containerImage}`;
      return label.toLowerCase().includes(q) || sub.toLowerCase().includes(q);
    });
  }, [query, sessions, ws.containers]);

  // Reset selection when results change.
  useEffect(() => { setSelected(0); }, [items.length]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowDown") { e.preventDefault(); setSelected((n) => Math.min(n + 1, items.length - 1)); }
      if (e.key === "ArrowUp") { e.preventDefault(); setSelected((n) => Math.max(n - 1, 0)); }
      if (e.key === "Enter") { e.preventDefault(); activate(items[selected]); }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [items, selected]); // eslint-disable-line react-hooks/exhaustive-deps

  function activate(item: PaletteItem | undefined) {
    if (!item) return;
    if (item.kind === "session") {
      ws.connect(item.session.id);
    } else {
      ws.connect(item.session.id).then(() => {
        const containers = ws.containers[item.session.id] ?? [];
        const c = containers.find((x) => x.id === item.containerId);
        if (c) {
          ws.openTab(item.session.id, c);
        } else {
          // Container not yet in store — open with stub; stream will still work.
          ws.openTab(item.session.id, {
            id: item.containerId,
            name: item.containerName,
            all_names: [item.containerName],
            image: item.containerImage,
            command: "",
            state: "",
            status: "",
            ports: "",
            created_at: "",
          });
        }
      });
    }
    onClose();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-24"
      onClick={onClose}
    >
      <div
        className="w-full max-w-lg overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Input */}
        <div className="flex items-center gap-2 border-b border-border px-4 py-3">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="shrink-0 text-muted">
            <circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search sessions and containers…"
            className="flex-1 bg-transparent text-sm text-fg outline-none placeholder:text-muted"
          />
          <kbd className="rounded border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-muted">
            Esc
          </kbd>
        </div>

        {/* Results */}
        <div className="max-h-80 overflow-y-auto py-1">
          {items.length === 0 ? (
            <div className="px-4 py-3 text-sm text-muted">No results</div>
          ) : (
            items.map((item, i) => {
              const isActive = i === selected;
              const connState = ws.connState[item.session.id] ?? "idle";
              if (item.kind === "session") {
                return (
                  <button
                    key={`session:${item.session.id}`}
                    className={`flex w-full items-center gap-3 px-4 py-2 text-left text-sm ${isActive ? "bg-surface-2" : "hover:bg-surface-2"}`}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => activate(item)}
                  >
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ background: item.session.color }}
                    />
                    <span className="flex-1 font-medium">{item.session.name}</span>
                    <span className="text-xs text-muted">
                      {item.session.username}@{item.session.host}
                    </span>
                    <span className={`text-xs ${connState === "connected" ? "text-ok" : connState === "connecting" ? "text-warn" : "text-muted"}`}>
                      {connState === "connected" ? "connected" : connState === "connecting" ? "connecting…" : "connect"}
                    </span>
                  </button>
                );
              } else {
                const running = (ws.containers[item.session.id] ?? []).find((c) => c.id === item.containerId)?.state === "running";
                return (
                  <button
                    key={`container:${item.session.id}:${item.containerId}`}
                    className={`flex w-full items-center gap-3 px-4 py-2 pl-9 text-left text-sm ${isActive ? "bg-surface-2" : "hover:bg-surface-2"}`}
                    onMouseEnter={() => setSelected(i)}
                    onClick={() => activate(item)}
                  >
                    <span className={`h-1.5 w-1.5 shrink-0 rounded-full ${running ? "bg-ok" : "bg-muted"}`} />
                    <span className="flex-1 font-medium">{item.containerName}</span>
                    <span className="max-w-[160px] truncate text-xs text-muted">{item.containerImage}</span>
                    <span className="text-xs text-muted">{item.session.name}</span>
                  </button>
                );
              }
            })
          )}
        </div>

        <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[11px] text-muted">
          <span><kbd className="font-mono">↑↓</kbd> navigate</span>
          <span><kbd className="font-mono">↵</kbd> open</span>
          <span><kbd className="font-mono">Esc</kbd> close</span>
          <span className="ml-auto">Sessions show in blue · containers are indented</span>
        </div>
      </div>
    </div>
  );
}
