import { create } from "zustand";
import { api, errorMessage, type Container } from "./ipc";
import { toast } from "./toastStore";

export type ConnState = "idle" | "connecting" | "connected" | "error";

export interface Tab {
  id: string;
  sessionId: string;
  containerId: string;
  containerName: string;
  containerImage: string;
}

const TABS_KEY = "beacon:tabs:v1";
const MAX_BACKOFF_MS = 60_000;

function saveTabs(tabs: Tab[]) {
  try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch {}
}

export function loadSavedTabs(): Tab[] {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    return raw ? (JSON.parse(raw) as Tab[]) : [];
  } catch { return []; }
}

// Reconnect timers live outside the store — timers aren't serialisable state.
const reconnectTimers = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleReconnect(sessionId: string, attempt: number) {
  clearTimeout(reconnectTimers.get(sessionId));
  const delay = Math.min(2_000 * Math.pow(2, attempt), MAX_BACKOFF_MS);
  reconnectTimers.set(
    sessionId,
    setTimeout(() => {
      reconnectTimers.delete(sessionId);
      const { connect, tabs } = useWorkspace.getState();
      // Only retry if there are still open tabs for this session.
      if (tabs.some((t) => t.sessionId === sessionId)) {
        connect(sessionId);
      }
    }, delay),
  );
}

function cancelReconnect(sessionId: string) {
  clearTimeout(reconnectTimers.get(sessionId));
  reconnectTimers.delete(sessionId);
}

export type S3UploadStatus = "idle" | "uploading" | "done" | "error";

export interface S3UploadState {
  status: S3UploadStatus;
  /** S3 key returned on success */
  s3Key?: string;
  error?: string;
}

export interface WorkspaceStore {
  connState: Record<string, ConnState>;
  connError: Record<string, string>;
  reconnectAttempts: Record<string, number>;
  containers: Record<string, Container[]>;
  containersLoading: Record<string, boolean>;
  containersError: Record<string, string | null>;

  /** Keyed by `${sessionId}:${containerId}` */
  s3UploadState: Record<string, S3UploadState>;

  tabs: Tab[];
  activeTabId: string | null;
  splitTabId: string | null;

  /** True once the saved-tabs restore has run. Persists across remounts so the
   *  restore logic doesn't fire again when the user navigates back to Workspace. */
  storageRestored: boolean;

  connect: (sessionId: string) => Promise<void>;
  disconnect: (sessionId: string) => Promise<void>;
  disconnectAll: () => Promise<void>;
  refreshContainers: (sessionId: string) => Promise<void>;
  openTab: (sessionId: string, container: Container) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setSplitTab: (tabId: string | null) => void;
  markStorageRestored: () => void;
  setS3UploadState: (sessionId: string, containerId: string, state: S3UploadState) => void;
}

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  connState: {},
  connError: {},
  reconnectAttempts: {},
  containers: {},
  containersLoading: {},
  containersError: {},
  s3UploadState: {},

  tabs: [],
  activeTabId: null,
  splitTabId: null,

  storageRestored: false,

  markStorageRestored() {
    set({ storageRestored: true });
  },

  setS3UploadState(sessionId, containerId, state) {
    const key = `${sessionId}:${containerId}`;
    set((s) => ({ s3UploadState: { ...s.s3UploadState, [key]: state } }));
  },

  async connect(sessionId) {
    const cur = get().connState[sessionId];
    if (cur === "connected" || cur === "connecting") return;
    set((s) => ({ connState: { ...s.connState, [sessionId]: "connecting" } }));
    try {
      await api.connectSession(sessionId);
      set((s) => ({
        connState: { ...s.connState, [sessionId]: "connected" },
        reconnectAttempts: { ...s.reconnectAttempts, [sessionId]: 0 },
      }));
      await get().refreshContainers(sessionId);
    } catch (e) {
      const attempt = get().reconnectAttempts[sessionId] ?? 0;
      const msg = errorMessage(e);
      set((s) => ({
        connState: { ...s.connState, [sessionId]: "error" },
        connError: { ...s.connError, [sessionId]: msg },
        reconnectAttempts: { ...s.reconnectAttempts, [sessionId]: attempt + 1 },
      }));
      // Show a toast only on the first failure so the user knows something went wrong.
      if (attempt === 0) toast("error", `Connection failed: ${msg}`);
      scheduleReconnect(sessionId, attempt);
    }
  },

  async disconnect(sessionId) {
    cancelReconnect(sessionId);
    await api.disconnectSession(sessionId).catch(() => {});
    set((s) => {
      const tabs = s.tabs.filter((t) => t.sessionId !== sessionId);
      const activeTabId = tabs.find((t) => t.id === s.activeTabId)
        ? s.activeTabId
        : tabs[tabs.length - 1]?.id ?? null;
      const splitTabId =
        s.splitTabId &&
        s.tabs.find((t) => t.id === s.splitTabId)?.sessionId === sessionId
          ? null
          : s.splitTabId;
      saveTabs(tabs);
      return {
        connState: { ...s.connState, [sessionId]: "idle" },
        reconnectAttempts: { ...s.reconnectAttempts, [sessionId]: 0 },
        containers: { ...s.containers, [sessionId]: [] },
        tabs,
        activeTabId,
        splitTabId,
      };
    });
  },

  async disconnectAll() {
    const { connState } = get();
    const ids = Object.keys(connState).filter(
      (id) => connState[id] === "connected" || connState[id] === "connecting",
    );
    ids.forEach((id) => cancelReconnect(id));
    await Promise.all(ids.map((id) => api.disconnectSession(id).catch(() => {})));
    set((s) => {
      const next: Record<string, ConnState> = {};
      Object.keys(s.connState).forEach((id) => { next[id] = "idle"; });
      return { connState: next, containers: {}, reconnectAttempts: {} };
    });
  },

  async refreshContainers(sessionId) {
    set((s) => ({
      containersLoading: { ...s.containersLoading, [sessionId]: true },
      containersError: { ...s.containersError, [sessionId]: null },
    }));
    try {
      const cs = await api.listContainers(sessionId);
      set((s) => ({
        containers: { ...s.containers, [sessionId]: cs },
        containersLoading: { ...s.containersLoading, [sessionId]: false },
      }));
    } catch (e) {
      set((s) => ({
        containersError: { ...s.containersError, [sessionId]: errorMessage(e) },
        containersLoading: { ...s.containersLoading, [sessionId]: false },
      }));
    }
  },

  openTab(sessionId, container) {
    const existing = get().tabs.find(
      (t) => t.sessionId === sessionId && t.containerId === container.id,
    );
    if (existing) {
      const { splitTabId, activeTabId } = get();
      if (existing.id === splitTabId) {
        set({ activeTabId: existing.id, splitTabId: activeTabId });
      } else {
        set({ activeTabId: existing.id });
      }
      return;
    }
    const tab: Tab = {
      id: `${sessionId}:${container.id}:${Date.now()}`,
      sessionId,
      containerId: container.id,
      containerName: container.name,
      containerImage: container.image,
    };
    set((s) => {
      const tabs = [...s.tabs, tab];
      saveTabs(tabs);
      return { tabs, activeTabId: tab.id };
    });
  },

  closeTab(tabId) {
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.id === tabId);
      const tabs = s.tabs.filter((t) => t.id !== tabId);
      let splitTabId = s.splitTabId === tabId ? null : s.splitTabId;
      let activeTabId = s.activeTabId;
      if (activeTabId === tabId) {
        activeTabId =
          tabs[Math.max(0, idx - 1)]?.id ??
          splitTabId ??
          null;
        if (activeTabId === splitTabId) splitTabId = null;
      }
      saveTabs(tabs);
      return { tabs, activeTabId, splitTabId };
    });
  },

  setActiveTab(tabId) {
    const { splitTabId, activeTabId } = get();
    if (tabId === splitTabId) {
      set({ activeTabId: tabId, splitTabId: activeTabId });
    } else {
      set({ activeTabId: tabId });
    }
  },

  setSplitTab(tabId) {
    const { activeTabId } = get();
    if (tabId === activeTabId) return;
    set({ splitTabId: tabId });
  },
}));
