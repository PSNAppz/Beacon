import { create } from "zustand";
import { api, Category, Session } from "./ipc";
import { useWorkspace } from "./workspaceStore";

type VaultStatus = "unknown" | "uninitialized" | "locked" | "unlocked";

interface AppState {
  vaultStatus: VaultStatus;
  sessions: Session[];
  loadingSessions: boolean;
  categories: Category[];
  bootstrap: () => Promise<void>;
  setUnlocked: () => Promise<void>;
  lock: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshCategories: () => Promise<void>;
  upsertSessionLocal: (s: Session) => void;
  removeSessionLocal: (id: string) => void;
  upsertCategoryLocal: (c: Category) => void;
  removeCategoryLocal: (id: string) => void;
}

export const useApp = create<AppState>((set, get) => ({
  vaultStatus: "unknown",
  sessions: [],
  loadingSessions: false,
  categories: [],

  async bootstrap() {
    const init = await api.vaultIsInitialized();
    if (!init) { set({ vaultStatus: "uninitialized" }); return; }
    const unlocked = await api.vaultIsUnlocked();
    set({ vaultStatus: unlocked ? "unlocked" : "locked" });
    if (unlocked) {
      await get().refreshSessions();
      await get().refreshCategories();
    }
  },

  async setUnlocked() {
    set({ vaultStatus: "unlocked" });
    await Promise.all([get().refreshSessions(), get().refreshCategories()]);
  },

  async lock() {
    // Disconnect all active SSH sessions before locking the vault.
    await useWorkspace.getState().disconnectAll();
    await api.vaultLock();
    set({ vaultStatus: "locked", sessions: [], categories: [] });
  },

  async refreshSessions() {
    set({ loadingSessions: true });
    try {
      const sessions = await api.listSessions();
      set({ sessions });
    } finally {
      set({ loadingSessions: false });
    }
  },

  async refreshCategories() {
    const categories = await api.listCategories().catch(() => [] as Category[]);
    set({ categories });
  },

  upsertSessionLocal(s) {
    set((st) => {
      const idx = st.sessions.findIndex((x) => x.id === s.id);
      if (idx === -1) return { sessions: [s, ...st.sessions] };
      const copy = st.sessions.slice();
      copy[idx] = s;
      return { sessions: copy };
    });
  },

  removeSessionLocal(id) {
    set((st) => ({ sessions: st.sessions.filter((s) => s.id !== id) }));
  },

  upsertCategoryLocal(c) {
    set((st) => {
      const idx = st.categories.findIndex((x) => x.id === c.id);
      if (idx === -1) return { categories: [...st.categories, c].sort((a, b) => a.name.localeCompare(b.name)) };
      const copy = st.categories.slice();
      copy[idx] = c;
      return { categories: copy };
    });
  },

  removeCategoryLocal(id) {
    set((st) => ({ categories: st.categories.filter((c) => c.id !== id) }));
  },
}));
