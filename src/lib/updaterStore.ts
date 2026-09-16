import { create } from "zustand";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { errorMessage } from "./ipc";

const AUTO_CHECK_KEY = "beacon:settings:autoCheckUpdates";
const AUTO_INSTALL_KEY = "beacon:settings:autoInstallUpdates";

/** How often a long-running window re-checks GitHub. */
export const CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;

export type UpdateStatus =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "ready"
  | "uptodate"
  | "error";

interface UpdaterState {
  status: UpdateStatus;
  version: string | null;
  notes: string | null;
  error: string | null;
  /** 0–100, or null when the release has no content-length. */
  progress: number | null;
  lastChecked: number | null;
  autoCheck: boolean;
  autoInstall: boolean;

  setAutoCheck: (v: boolean) => void;
  setAutoInstall: (v: boolean) => void;
  /** `silent` suppresses the "you're up to date" state used by the manual button. */
  checkNow: (silent?: boolean) => Promise<void>;
  downloadAndInstall: () => Promise<void>;
  restart: () => Promise<void>;
  dismiss: () => void;
}

// The Update handle carries the download/install methods and is not serialisable,
// so it lives outside the store.
let pending: Update | null = null;

export const useUpdater = create<UpdaterState>((set, get) => ({
  status: "idle",
  version: null,
  notes: null,
  error: null,
  progress: null,
  lastChecked: null,
  autoCheck: localStorage.getItem(AUTO_CHECK_KEY) !== "false",
  autoInstall: localStorage.getItem(AUTO_INSTALL_KEY) === "true",

  setAutoCheck(v) {
    try { localStorage.setItem(AUTO_CHECK_KEY, String(v)); } catch {}
    set({ autoCheck: v });
  },

  setAutoInstall(v) {
    try { localStorage.setItem(AUTO_INSTALL_KEY, String(v)); } catch {}
    set({ autoInstall: v });
  },

  async checkNow(silent = false) {
    if (get().status === "checking" || get().status === "downloading") return;
    set({ status: "checking", error: null });
    try {
      const update = await check();
      set({ lastChecked: Date.now() });
      if (!update) {
        pending = null;
        set({ status: silent ? "idle" : "uptodate", version: null, notes: null });
        return;
      }
      pending = update;
      set({ status: "available", version: update.version, notes: update.body ?? null });
      if (get().autoInstall) await get().downloadAndInstall();
    } catch (e) {
      // A failed check is not worth interrupting anyone over when it was automatic.
      set({ status: silent ? "idle" : "error", error: errorMessage(e) });
    }
  },

  async downloadAndInstall() {
    if (!pending) return;
    set({ status: "downloading", progress: null, error: null });
    let total = 0;
    let received = 0;
    try {
      await pending.downloadAndInstall((event) => {
        if (event.event === "Started") {
          total = event.data.contentLength ?? 0;
          set({ progress: total > 0 ? 0 : null });
        } else if (event.event === "Progress") {
          received += event.data.chunkLength;
          if (total > 0) set({ progress: Math.min(99, Math.round((received / total) * 100)) });
        } else if (event.event === "Finished") {
          set({ progress: 100 });
        }
      });
      set({ status: "ready" });
    } catch (e) {
      set({ status: "error", error: errorMessage(e) });
    }
  },

  async restart() {
    await relaunch();
  },

  dismiss() {
    if (get().status === "uptodate" || get().status === "error") {
      set({ status: pending ? "available" : "idle", error: null });
    }
  },
}));

/**
 * Start the background check loop. Safe to call more than once — the interval is
 * module-scoped and only ever installed once.
 */
let timer: ReturnType<typeof setInterval> | null = null;
export function startUpdateChecks() {
  if (timer) return;
  const run = () => {
    const { autoCheck, checkNow } = useUpdater.getState();
    if (autoCheck) checkNow(true);
  };
  run();
  timer = setInterval(run, CHECK_INTERVAL_MS);
}
