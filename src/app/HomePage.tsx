import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { api, errorMessage, Session } from "../lib/ipc";
import { useApp } from "../lib/store";
import { SessionWizard } from "../features/sessions/SessionWizard";
import { ExportModal } from "../features/sessions/ExportModal";
import { ImportModal } from "../features/sessions/ImportModal";
import { Button, ConfirmDialog, Toast } from "../components/ui";

export function HomePage() {
  const sessions = useApp((s) => s.sessions);
  const categories = useApp((s) => s.categories);
  const loading = useApp((s) => s.loadingSessions);
  const removeLocal = useApp((s) => s.removeSessionLocal);
  const refresh = useApp((s) => s.refreshSessions);
  const navigate = useNavigate();

  // Group sessions by category. Uncategorised go last.
  const groups = useMemo(() => {
    const result: { label: string | null; sessions: Session[] }[] = [];
    const byCat = new Map<string | null, Session[]>();
    for (const s of sessions) {
      const key = s.category_id ?? null;
      if (!byCat.has(key)) byCat.set(key, []);
      byCat.get(key)!.push(s);
    }
    // Categorised groups first, sorted by category name
    for (const cat of categories) {
      const ss = byCat.get(cat.id);
      if (ss && ss.length > 0) result.push({ label: cat.name, sessions: ss });
    }
    // Uncategorised last
    const uncategorised = byCat.get(null) ?? [];
    if (uncategorised.length > 0) {
      result.push({ label: categories.length > 0 ? "Uncategorised" : null, sessions: uncategorised });
    }
    return result;
  }, [sessions, categories]);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [editing, setEditing] = useState<Session | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [toast, setToast] = useState<{ kind: "ok" | "error" | "info"; message: string } | null>(null);

  function flash(kind: "ok" | "error" | "info", message: string) {
    setToast({ kind, message });
    setTimeout(() => setToast(null), 4000);
  }

  function openNew() { setEditing(null); setWizardOpen(true); }
  function openEdit(s: Session) { setEditing(s); setWizardOpen(true); }

  const [pendingDelete, setPendingDelete] = useState<Session | null>(null);

  async function confirmDelete() {
    const s = pendingDelete;
    if (!s) return;
    setPendingDelete(null);
    try {
      await api.deleteSession(s.id);
      removeLocal(s.id);
    } catch (e) {
      flash("error", errorMessage(e));
    }
  }

  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="mx-auto max-w-6xl">
        <div className="mb-6 flex items-end justify-between">
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">Sessions</h1>
            <p className="mt-1 text-sm text-muted">
              Connect to a remote host to view Docker containers and stream logs.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" onClick={() => setImportOpen(true)}>Import</Button>
            <Button variant="ghost" onClick={() => setExportOpen(true)}>Export</Button>
            <Button variant="primary" onClick={openNew}>+ New session</Button>
          </div>
        </div>

        <section className="space-y-6">
          {loading && sessions.length === 0 ? (
            <div className="rounded-xl border border-border bg-surface/70 p-8 text-center text-sm text-muted backdrop-blur-sm">Loading…</div>
          ) : sessions.length === 0 ? (
            <div className="rounded-xl border border-dashed border-border bg-surface/40 p-10 text-center backdrop-blur-sm">
              <div className="text-sm text-muted">No sessions yet.</div>
              <Button variant="primary" onClick={openNew} className="mt-4">+ Add your first session</Button>
            </div>
          ) : (
            <>
              {groups.map((group, gi) => (
                <div key={group.label ?? "__none__"}>
                  {group.label && (
                    <div className="mb-3 flex items-center gap-3">
                      <h2 className="text-xs font-semibold uppercase tracking-wider text-muted">{group.label}</h2>
                      <hr className="flex-1 border-border" />
                    </div>
                  )}
                  {!group.label && gi === 0 && (
                    <h2 className="mb-3 text-xs font-semibold uppercase tracking-wider text-muted">Hosts</h2>
                  )}
                  <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
                    {group.sessions.map((s) => (
                      <SessionTile
                        key={s.id}
                        session={s}
                        onConnect={() => navigate(`/workspace/${s.id}`)}
                        onEdit={() => openEdit(s)}
                        onDelete={() => setPendingDelete(s)}
                      />
                    ))}
                  </div>
                </div>
              ))}
              <button
                onClick={openNew}
                className="flex min-h-[140px] w-full items-center justify-center rounded-xl border border-dashed border-border text-sm text-muted hover:border-accent/40 hover:text-accent"
              >
                + Add session
              </button>
            </>
          )}
        </section>
      </div>

      <SessionWizard open={wizardOpen} onClose={() => setWizardOpen(false)} editing={editing} />
      <ExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
      <ImportModal open={importOpen} onClose={() => { setImportOpen(false); refresh(); }} />
      {toast && <Toast kind={toast.kind} message={toast.message} />}

      <ConfirmDialog
        open={pendingDelete !== null}
        onOpenChange={(o) => { if (!o) setPendingDelete(null); }}
        title={`Delete "${pendingDelete?.name ?? ""}"?`}
        body="The saved session and its stored credentials are removed from the vault. This cannot be undone."
        confirmLabel="Delete session"
        destructive
        onConfirm={confirmDelete}
      />
    </div>
  );
}

function SessionTile({
  session, onConnect, onEdit, onDelete,
}: {
  session: Session;
  onConnect: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const last = session.last_connected
    ? new Date(session.last_connected * 1000).toLocaleString()
    : "never";
  return (
    <div className="group rounded-xl border border-border bg-surface/70 p-5 backdrop-blur-sm transition-colors hover:border-accent/40 hover:bg-surface/85">
      <div className="flex items-start justify-between gap-3">
        <button onClick={onConnect} className="min-w-0 flex-1 text-left">
          <div className="flex items-center gap-2">
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: session.color }} />
            <div className="truncate text-[15px] font-semibold">{session.name}</div>
            {session.read_only && (
              <span className="rounded bg-warn/15 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-warn">RO</span>
            )}
          </div>
          <div className="mt-1 truncate font-mono text-xs text-muted">
            {session.username}@{session.host}:{session.port}
          </div>
        </button>
      </div>
      <div className="mt-4 flex items-center justify-between text-xs text-muted">
        <span>Last seen {last}</span>
        <span className="uppercase tracking-wider">{session.auth_kind}</span>
      </div>
      <div className="mt-4 flex items-center gap-2">
        <Button variant="primary" onClick={onConnect} className="flex-1 text-xs">
          Connect
        </Button>
        <Button variant="ghost" onClick={onEdit} className="text-xs">Edit</Button>
        <Button variant="ghost" onClick={onDelete} className="text-xs text-muted hover:text-danger">Delete</Button>
      </div>
    </div>
  );
}
