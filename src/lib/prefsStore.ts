import { create } from "zustand";

const DOT_GRID_KEY = "beacon:settings:dotGrid";

interface PrefsState {
  /** Animated dot-grid background. On by default; off costs nothing at all. */
  dotGrid: boolean;
  setDotGrid: (v: boolean) => void;
}

export const usePrefs = create<PrefsState>((set) => ({
  dotGrid: localStorage.getItem(DOT_GRID_KEY) !== "false",
  setDotGrid(v) {
    try { localStorage.setItem(DOT_GRID_KEY, String(v)); } catch {}
    set({ dotGrid: v });
  },
}));
