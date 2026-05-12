import { create } from "zustand";
import { api, Session } from "./ipc";

type VaultStatus = "unknown" | "uninitialized" | "locked" | "unlocked";

interface AppState {
  vaultStatus: VaultStatus;
  sessions: Session[];
  loadingSessions: boolean;
  bootstrap: () => Promise<void>;
  setUnlocked: () => Promise<void>;
  lock: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  upsertSessionLocal: (s: Session) => void;
  removeSessionLocal: (id: string) => void;
}

export const useApp = create<AppState>((set, get) => ({
  vaultStatus: "unknown",
  sessions: [],
  loadingSessions: false,

  async bootstrap() {
    const init = await api.vaultIsInitialized();
    if (!init) { set({ vaultStatus: "uninitialized" }); return; }
    const unlocked = await api.vaultIsUnlocked();
    set({ vaultStatus: unlocked ? "unlocked" : "locked" });
    if (unlocked) await get().refreshSessions();
  },

  async setUnlocked() {
    set({ vaultStatus: "unlocked" });
    await get().refreshSessions();
  },

  async lock() {
    await api.vaultLock();
    set({ vaultStatus: "locked", sessions: [] });
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
}));
