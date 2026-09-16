import { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { NavLink, Outlet } from "react-router-dom";
import { useApp } from "../lib/store";
import { useToasts } from "../lib/toastStore";
import { Toast, TooltipProvider } from "../components/ui";
import { LockScreen } from "./LockScreen";
import { AppBackground } from "../components/AppBackground";
import { startUpdateChecks, useUpdater } from "../lib/updaterStore";

export function App() {
  const status = useApp((s) => s.vaultStatus);
  const bootstrap = useApp((s) => s.bootstrap);
  const lock = useApp((s) => s.lock);

  useEffect(() => { bootstrap(); }, [bootstrap]);

  // Only look for updates once the user is actually in the app.
  useEffect(() => {
    if (status === "unlocked") startUpdateChecks();
  }, [status]);

  return (
    <TooltipProvider>
      <AppBackground />
      <div className="relative z-10 h-full">{renderContent(status, lock)}</div>
    </TooltipProvider>
  );
}

function renderContent(status: ReturnType<typeof useApp.getState>["vaultStatus"], lock: () => Promise<void>) {
  if (status === "unknown") {
    return <div className="grid h-full place-items-center text-sm text-muted">Loading…</div>;
  }
  if (status === "uninitialized") return <LockScreen mode="create" />;
  if (status === "locked") return <LockScreen mode="unlock" />;

  return (
    <div className="flex h-full flex-col text-fg">
      <header className="flex items-center justify-between border-b border-border bg-surface/70 px-5 py-3 backdrop-blur-xl">
        <div className="flex items-center gap-2.5">
          <BeaconMark />
          <span className="text-[15px] font-semibold tracking-tight">Beacon</span>
          <VersionBadge />
          <UpdateChip />
        </div>
        <nav className="flex items-center gap-1 text-sm">
          <NavTab to="/">Sessions</NavTab>
          <NavTab to="/workspace" end={false}>Workspace</NavTab>
          <NavTab to="/settings">Settings</NavTab>
          <NavTab to="/help">Guide</NavTab>
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

function VersionBadge() {
  const [version, setVersion] = useState("");
  useEffect(() => { getVersion().then(setVersion).catch(() => {}); }, []);
  if (!version) return null;
  return (
    <span className="ml-2 rounded-md bg-surface-2 px-2 py-0.5 font-mono text-[10px] font-medium tracking-wider text-muted">
      v{version}
    </span>
  );
}

/** Header affordance — the only place an update announces itself unprompted. */
function UpdateChip() {
  const status = useUpdater((s) => s.status);
  const version = useUpdater((s) => s.version);
  const progress = useUpdater((s) => s.progress);
  const restart = useUpdater((s) => s.restart);

  if (status === "ready") {
    return (
      <button
        onClick={() => restart()}
        title="Restart to finish installing the update"
        className="ml-1 rounded-md bg-fg px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-bg hover:bg-fg/90"
      >
        Restart to update
      </button>
    );
  }
  if (status === "downloading") {
    return (
      <span className="ml-1 rounded-md bg-surface-2 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wider text-muted">
        Updating{progress !== null ? ` ${progress}%` : "…"}
      </span>
    );
  }
  if (status === "available") {
    return (
      <NavLink
        to="/settings"
        title={`Version ${version} is available`}
        className="ml-1 rounded-md border border-fg/30 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-fg hover:bg-surface-2"
      >
        Update {version}
      </NavLink>
    );
  }
  return null;
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
    <div className="grid h-7 w-7 place-items-center rounded-[9px] bg-fg text-bg">
      <svg viewBox="0 0 24 24" width="17" height="17" fill="currentColor" aria-hidden="true">
        <rect x="5.8" y="6.4" width="7.1" height="3" rx="1.5" />
        <circle cx="15.5" cy="7.9" r="1.45" />
        <rect x="7.1" y="10.5" width="10.9" height="3" rx="1.5" />
        <circle cx="20.5" cy="12" r="1.45" />
        <rect x="2" y="14.7" width="13.4" height="3" rx="1.5" />
        <circle cx="18" cy="16.1" r="1.45" />
      </svg>
    </div>
  );
}
