import { useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, errorMessage, ImportPreview, ImportSessionPreview } from "../../lib/ipc";
import { useApp } from "../../lib/store";
import { Button, Field, Input, Modal } from "../../components/ui";

type Step = "pick" | "preview" | "done";
type ConflictStrategy = "skip" | "overwrite" | "rename";

export function ImportModal({ open: isOpen, onClose }: { open: boolean; onClose: () => void }) {
  const refresh = useApp((s) => s.refreshSessions);

  const [step, setStep] = useState<Step>("pick");
  const [filePath, setFilePath] = useState<string | null>(null);
  const [password, setPassword] = useState("");
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [strategy, setStrategy] = useState<ConflictStrategy>("skip");
  const [importedCount, setImportedCount] = useState(0);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function reset() {
    setStep("pick");
    setFilePath(null);
    setPassword("");
    setPreview(null);
    setSelected(new Set());
    setStrategy("skip");
    setImportedCount(0);
    setBusy(false);
    setErr(null);
  }

  function handleClose() {
    reset();
    onClose();
  }

  async function pickFile() {
    const path = await open({
      multiple: false,
      filters: [{ name: "Beacon Export", extensions: ["bcnx"] }],
    });
    if (typeof path === "string") {
      setFilePath(path);
      setErr(null);
    }
  }

  async function onPreview() {
    if (!filePath || !password) return;
    setBusy(true);
    setErr(null);
    try {
      const result = await api.previewImport(filePath, password);
      setPreview(result);
      setSelected(new Set(result.sessions.map((s) => s.id)));
      setStep("preview");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  async function onImport() {
    if (!filePath || !preview) return;
    setBusy(true);
    setErr(null);
    try {
      const imported = await api.importSessions(filePath, password, [...selected], strategy);
      setImportedCount(imported.length);
      await refresh();
      setStep("done");
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
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

  const conflictingIds = new Set(
    preview?.sessions.filter((s) => s.conflict !== null).map((s) => s.id) ?? [],
  );
  const selectedConflicts = [...selected].filter((id) => conflictingIds.has(id)).length;

  if (!isOpen) return null;

  // ── Step 1: pick file + password ─────────────────────────────────────────────
  if (step === "pick") {
    return (
      <Modal
        open={isOpen}
        onClose={handleClose}
        title="Import sessions"
        width="max-w-lg"
        footer={
          <>
            <Button variant="ghost" onClick={handleClose}>Cancel</Button>
            <Button
              variant="primary"
              onClick={onPreview}
              disabled={!filePath || !password || busy}
            >
              {busy ? "Checking…" : "Preview"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div>
            <p className="mb-3 text-sm text-muted">
              Select a <span className="font-mono text-fg">.bcnx</span> export file and enter the
              password it was encrypted with.
            </p>
            <button
              onClick={pickFile}
              className="flex w-full items-center gap-3 rounded-lg border border-dashed border-border px-4 py-3 text-sm hover:border-accent/60 hover:text-accent"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                <polyline points="17 8 12 3 7 8" />
                <line x1="12" y1="3" x2="12" y2="15" />
              </svg>
              {filePath ? (
                <span className="min-w-0 flex-1 truncate text-left font-mono text-xs text-fg">{filePath}</span>
              ) : (
                <span className="text-muted">Choose .bcnx file…</span>
              )}
            </button>
          </div>

          <Field label="Export password">
            <Input
              type="password"
              placeholder="Password used when exporting"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && filePath && password) onPreview(); }}
              autoFocus
            />
          </Field>

          {err && <p className="text-sm text-danger">{err}</p>}
        </div>
      </Modal>
    );
  }

  // ── Step 2: preview + strategy ───────────────────────────────────────────────
  if (step === "preview" && preview) {
    const allSelected = selected.size === preview.sessions.length;

    return (
      <Modal
        open={isOpen}
        onClose={handleClose}
        title="Choose sessions to import"
        width="max-w-lg"
        footer={
          <>
            <Button variant="ghost" onClick={() => { setStep("pick"); setErr(null); }}>Back</Button>
            <Button
              variant="primary"
              onClick={onImport}
              disabled={selected.size === 0 || busy}
            >
              {busy ? "Importing…" : `Import ${selected.size} session${selected.size !== 1 ? "s" : ""}`}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-sm text-muted">{selected.size} of {preview.sessions.length} selected</span>
            <button
              onClick={() => setSelected(allSelected ? new Set() : new Set(preview.sessions.map((s) => s.id)))}
              className="text-xs text-accent hover:underline"
            >
              {allSelected ? "Deselect all" : "Select all"}
            </button>
          </div>

          <div className="max-h-52 overflow-y-auto rounded-lg border border-border">
            {preview.sessions.map((s) => (
              <PreviewRow
                key={s.id}
                session={s}
                checked={selected.has(s.id)}
                onToggle={() => toggleOne(s.id)}
              />
            ))}
          </div>

          {selectedConflicts > 0 && (
            <div className="rounded-lg border border-warn/30 bg-warn/5 p-3">
              <p className="mb-2 text-xs font-semibold text-warn">
                {selectedConflicts} conflicting session{selectedConflicts !== 1 ? "s" : ""} selected — choose how to handle:
              </p>
              <div className="space-y-1.5">
                {(["skip", "overwrite", "rename"] as ConflictStrategy[]).map((opt) => (
                  <label key={opt} className="flex cursor-pointer items-center gap-2 text-sm">
                    <input
                      type="radio"
                      name="strategy"
                      value={opt}
                      checked={strategy === opt}
                      onChange={() => setStrategy(opt)}
                      className="accent-accent"
                    />
                    <span className="font-medium capitalize">{opt}</span>
                    <span className="text-xs text-muted">
                      {opt === "skip" && "— skip sessions that already exist"}
                      {opt === "overwrite" && "— replace existing sessions with the same ID or name"}
                      {opt === "rename" && '— import with a new ID and "(imported)" suffix'}
                    </span>
                  </label>
                ))}
              </div>
            </div>
          )}

          {err && <p className="text-sm text-danger">{err}</p>}
        </div>
      </Modal>
    );
  }

  // ── Step 3: success ───────────────────────────────────────────────────────────
  return (
    <Modal
      open={isOpen}
      onClose={handleClose}
      title="Import complete"
      width="max-w-lg"
      footer={<Button variant="primary" onClick={handleClose}>Done</Button>}
    >
      <p className="py-4 text-center text-sm text-fg">
        Successfully imported <span className="font-semibold text-ok">{importedCount}</span>{" "}
        session{importedCount !== 1 ? "s" : ""}.
      </p>
    </Modal>
  );
}

function PreviewRow({
  session,
  checked,
  onToggle,
}: {
  session: ImportSessionPreview;
  checked: boolean;
  onToggle: () => void;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-3 border-b border-border/50 px-3 py-2.5 last:border-0 hover:bg-surface-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={onToggle}
        className="accent-accent"
      />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{session.name}</span>
          {session.conflict === "same_id" && (
            <span className="shrink-0 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-warn">
              ID conflict
            </span>
          )}
          {session.conflict === "same_name" && (
            <span className="shrink-0 rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-warn">
              Name conflict
            </span>
          )}
        </div>
        <div className="flex items-center gap-2 text-xs text-muted">
          <span className="truncate font-mono">{session.username}@{session.host}</span>
          {session.category_name && (
            <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px]">{session.category_name}</span>
          )}
        </div>
      </div>
    </label>
  );
}
