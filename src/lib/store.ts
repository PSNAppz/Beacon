import { create } from "zustand";
import { api, Category, S3ConfigPublic, s3Api, Session } from "./ipc";
import { useWorkspace } from "./workspaceStore";

type VaultStatus = "unknown" | "uninitialized" | "locked" | "unlocked";

interface AppState {
  vaultStatus: VaultStatus;
  /** True when a master password is stored in the OS credential store. */
  passwordRemembered: boolean;
  sessions: Session[];
  loadingSessions: boolean;
  categories: Category[];
  s3Config: S3ConfigPublic | null;
  bootstrap: () => Promise<void>;
  setPasswordRemembered: (v: boolean) => void;
  setUnlocked: () => Promise<void>;
  lock: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  refreshCategories: () => Promise<void>;
  refreshS3Config: () => Promise<void>;
  setS3Config: (config: S3ConfigPublic | null) => void;
  upsertSessionLocal: (s: Session) => void;
  removeSessionLocal: (id: string) => void;
  upsertCategoryLocal: (c: Category) => void;
  removeCategoryLocal: (id: string) => void;
}

export const useApp = create<AppState>((set, get) => ({
  vaultStatus: "unknown",
  passwordRemembered: false,
  sessions: [],
  loadingSessions: false,
  categories: [],
  s3Config: null,

  async bootstrap() {
    const remembered = await api.vaultHasRememberedPassword().catch(() => false);
    set({ passwordRemembered: remembered });
    const init = await api.vaultIsInitialized();
    if (!init) { set({ vaultStatus: "uninitialized" }); return; }
    let unlocked = await api.vaultIsUnlocked();
    // A remembered password unlocks silently on launch. A stale one is dropped
    // by the backend, so we re-read the flag rather than trusting the old value.
    if (!unlocked && remembered) {
      unlocked = await api.vaultUnlockRemembered().catch(() => false);
      if (!unlocked) set({ passwordRemembered: false });
    }
    set({ vaultStatus: unlocked ? "unlocked" : "locked" });
    if (unlocked) {
      await Promise.all([
        get().refreshSessions(),
        get().refreshCategories(),
        get().refreshS3Config(),
      ]);
    }
  },

  async setUnlocked() {
    set({ vaultStatus: "unlocked" });
    await Promise.all([
      get().refreshSessions(),
      get().refreshCategories(),
      get().refreshS3Config(),
    ]);
  },

  async lock() {
    // Disconnect all active SSH sessions before locking the vault.
    await useWorkspace.getState().disconnectAll();
    await api.vaultLock();
    set({ vaultStatus: "locked", sessions: [], categories: [], s3Config: null });
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

  async refreshS3Config() {
    const s3Config = await s3Api.getConfig().catch(() => null);
    set({ s3Config });
  },

  setPasswordRemembered(v) {
    set({ passwordRemembered: v });
  },

  setS3Config(config) {
    set({ s3Config: config });
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
