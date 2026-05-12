import { create } from "zustand";

export interface ToastEntry {
  id: number;
  kind: "ok" | "error" | "info";
  message: string;
}

interface ToastStore {
  toasts: ToastEntry[];
  push: (kind: ToastEntry["kind"], message: string) => void;
  dismiss: (id: number) => void;
}

let counter = 0;

export const useToasts = create<ToastStore>((set) => ({
  toasts: [],
  push(kind, message) {
    const id = ++counter;
    set((s) => ({ toasts: [...s.toasts, { id, kind, message }] }));
    setTimeout(() => {
      set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
    }, 4000);
  },
  dismiss(id) {
    set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) }));
  },
}));

export function toast(kind: ToastEntry["kind"], message: string) {
  useToasts.getState().push(kind, message);
}
