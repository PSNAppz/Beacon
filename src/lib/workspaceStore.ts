import { create } from "zustand";
import { api, errorMessage, type Container } from "./ipc";

export type ConnState = "idle" | "connecting" | "connected" | "error";

export interface Tab {
  id: string;
  sessionId: string;
  containerId: string;
  containerName: string;
  containerImage: string;
}

const TABS_KEY = "beacon:tabs:v1";

function saveTabs(tabs: Tab[]) {
  try { localStorage.setItem(TABS_KEY, JSON.stringify(tabs)); } catch {}
}

export function loadSavedTabs(): Tab[] {
  try {
    const raw = localStorage.getItem(TABS_KEY);
    return raw ? (JSON.parse(raw) as Tab[]) : [];
  } catch { return []; }
}

export interface WorkspaceStore {
  connState: Record<string, ConnState>;
  connError: Record<string, string>;
  containers: Record<string, Container[]>;
  containersLoading: Record<string, boolean>;
  containersError: Record<string, string | null>;

  tabs: Tab[];
  activeTabId: string | null;
  splitTabId: string | null;

  connect: (sessionId: string) => Promise<void>;
  disconnect: (sessionId: string) => Promise<void>;
  refreshContainers: (sessionId: string) => Promise<void>;
  openTab: (sessionId: string, container: Container) => void;
  closeTab: (tabId: string) => void;
  setActiveTab: (tabId: string) => void;
  setSplitTab: (tabId: string | null) => void;
}

export const useWorkspace = create<WorkspaceStore>((set, get) => ({
  connState: {},
  connError: {},
  containers: {},
  containersLoading: {},
  containersError: {},

  tabs: [],
  activeTabId: null,
  splitTabId: null,

  async connect(sessionId) {
    const cur = get().connState[sessionId];
    if (cur === "connected" || cur === "connecting") return;
    set((s) => ({ connState: { ...s.connState, [sessionId]: "connecting" } }));
    try {
      await api.connectSession(sessionId);
      set((s) => ({ connState: { ...s.connState, [sessionId]: "connected" } }));
      await get().refreshContainers(sessionId);
    } catch (e) {
      set((s) => ({
        connState: { ...s.connState, [sessionId]: "error" },
        connError: { ...s.connError, [sessionId]: errorMessage(e) },
      }));
    }
  },

  async disconnect(sessionId) {
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
        containers: { ...s.containers, [sessionId]: [] },
        tabs,
        activeTabId,
        splitTabId,
      };
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
      // If it's in the split pane, swap it to primary.
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
        // Prefer the tab to the left, else right, else split, else null.
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
      // Clicking the split tab promotes it to primary and demotes current primary to split.
      set({ activeTabId: tabId, splitTabId: activeTabId });
    } else {
      set({ activeTabId: tabId });
    }
  },

  setSplitTab(tabId) {
    const { activeTabId } = get();
    if (tabId === activeTabId) return; // can't split to the same tab
    set({ splitTabId: tabId });
  },
}));
