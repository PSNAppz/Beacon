import { useEffect, useMemo, useState } from "react";
import { save } from "@tauri-apps/plugin-dialog";
import { api, errorMessage, Session } from "../../lib/ipc";
import { useApp } from "../../lib/store";
import { Button, Field, Input, Modal } from "../../components/ui";

export function ExportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const sessions = useApp((s) => s.sessions);
  const categories = useApp((s) => s.categories);

  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset state when modal opens
  useEffect(() => {
    if (open) {
      setSelected(new Set(sessions.map((s) => s.id)));
      setPassword("");
      setErr(null);
      setBusy(false);
    }
  }, [open, sessions]);

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
    if (uncategorised.length > 0) result.push({ label: null, sessions: uncategorised });
    return result;
  }, [sessions, categories]);

  const allSelected = selected.size === sessions.length && sessions.length > 0;

  function toggleAll() {
    if (allSelected) {
      setSelected(new Set());
    } else {
      setSelected(new Set(sessions.map((s) => s.id)));
    }
  }

  function toggleOne(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function onExport() {
    setErr(null);
    const path = await save({
      defaultPath: "beacon-export.bcnx",
      filters: [{ name: "Beacon Export", extensions: ["bcnx"] }],
    });
    if (!path) return; // user cancelled dialog
    setBusy(true);
    try {
      await api.exportSessions([...selected], password, path);
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  const canExport = selected.size > 0 && password.length > 0 && !busy;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Export sessions"
      width="max-w-lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>Cancel</Button>
          <Button variant="primary" onClick={onExport} disabled={!canExport}>
            {busy ? "Exporting…" : `Export ${selected.size > 0 ? selected.size : ""} session${selected.size !== 1 ? "s" : ""}`}
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        {sessions.length === 0 ? (
          <p className="text-sm text-muted">No sessions to export.</p>
        ) : (
          <>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted">{selected.size} of {sessions.length} selected</span>
              <button
                onClick={toggleAll}
                className="text-xs text-accent hover:underline"
              >
                {allSelected ? "Deselect all" : "Select all"}
              </button>
            </div>

            <div className="max-h-60 overflow-y-auto rounded-lg border border-border">
              {groups.map((group) => (
                <div key={group.label ?? "__none__"}>
                  {group.label && (
                    <div className="sticky top-0 border-b border-border bg-surface px-3 py-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted">
                      {group.label}
                    </div>
                  )}
                  {group.sessions.map((s) => (
                    <label
                      key={s.id}
                      className="flex cursor-pointer items-center gap-3 border-b border-border/50 px-3 py-2.5 last:border-0 hover:bg-surface-2"
                    >
                      <input
                        type="checkbox"
                        checked={selected.has(s.id)}
                        onChange={() => toggleOne(s.id)}
                        className="accent-accent"
                      />
                      <span
                        className="h-2 w-2 shrink-0 rounded-full"
                        style={{ background: s.color }}
                      />
                      <div className="min-w-0 flex-1">
                        <div className="truncate text-sm font-medium">{s.name}</div>
                        <div className="truncate text-xs text-muted">
                          {s.username}@{s.host}:{s.port}
                        </div>
                      </div>
                    </label>
                  ))}
                </div>
              ))}
            </div>
          </>
        )}

        <Field label="Export password" hint="Required to import this file">
          <Input
            type="password"
            placeholder="Choose a strong password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && canExport) onExport(); }}
            autoFocus
          />
        </Field>

        {err && <p className="text-sm text-danger">{err}</p>}
      </div>
    </Modal>
  );
}
