import { useEffect } from "react";
import { NavLink, Outlet } from "react-router-dom";
import { useApp } from "../lib/store";
import { useToasts } from "../lib/toastStore";
import { Toast } from "../components/ui";
import { LockScreen } from "./LockScreen";

export function App() {
  const status = useApp((s) => s.vaultStatus);
  const bootstrap = useApp((s) => s.bootstrap);
  const lock = useApp((s) => s.lock);

  useEffect(() => { bootstrap(); }, [bootstrap]);

  if (status === "unknown") {
    return <div className="grid h-full place-items-center text-sm text-muted">Loading…</div>;
  }
  if (status === "uninitialized") return <LockScreen mode="create" />;
  if (status === "locked") return <LockScreen mode="unlock" />;

  return (
    <div className="flex h-full flex-col bg-bg text-fg">
      <header className="flex items-center justify-between border-b border-border bg-surface px-5 py-3">
        <div className="flex items-center gap-2.5">
          <BeaconMark />
          <span className="text-[15px] font-semibold tracking-tight">Beacon</span>
          <span className="ml-2 rounded-md bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">
            preview
          </span>
        </div>
        <nav className="flex items-center gap-1 text-sm">
          <NavTab to="/">Sessions</NavTab>
          <NavTab to="/workspace" end={false}>Workspace</NavTab>
          <NavTab to="/settings">Settings</NavTab>
          <button onClick={() => lock()} className="ml-2 rounded-md px-3 py-1.5 text-muted hover:bg-surface-2 hover:text-fg">
            Lock
          </button>
        </nav>
      </header>
      <main className="min-h-0 flex-1 overflow-hidden">
        <Outlet />
      </main>
      <ToastStack />
    </div>
  );
}

function ToastStack() {
  const { toasts, dismiss } = useToasts();
  if (toasts.length === 0) return null;
  return (
    <div className="fixed bottom-5 right-5 z-50 flex flex-col gap-2">
      {toasts.map((t) => (
        <Toast key={t.id} kind={t.kind} message={t.message} onDismiss={() => dismiss(t.id)} />
      ))}
    </div>
  );
}

function NavTab({ to, end = true, children }: { to: string; end?: boolean; children: React.ReactNode }) {
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `rounded-md px-3 py-1.5 transition-colors ${
          isActive ? "bg-surface-2 text-fg" : "text-muted hover:bg-surface-2 hover:text-fg"
        }`
      }
    >
      {children}
    </NavLink>
  );
}

function BeaconMark() {
  return (
    <div className="grid h-7 w-7 place-items-center rounded-lg bg-accent/15 text-accent">
      <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 2v3" />
        <path d="M5 9a7 7 0 0 1 14 0c0 5-7 13-7 13S5 14 5 9z" />
        <circle cx="12" cy="9" r="2.5" />
      </svg>
    </div>
  );
}
