import { create } from "zustand"

export type HighlightColor = "danger" | "warn" | "ok" | "accent"

export interface FilterPreset {
  id: string
  name: string
  pattern: string
}

export interface HighlightRule {
  id: string
  pattern: string
  color: HighlightColor
  enabled: boolean
}

export interface AlertRule {
  id: string
  pattern: string
  label: string
  enabled: boolean
}

interface RulesStore {
  filters: FilterPreset[]
  highlights: HighlightRule[]
  alerts: AlertRule[]
  /** In-memory only — not persisted. */
  alertLastTriggered: Record<string, number>

  addFilter(name: string, pattern: string): void
  removeFilter(id: string): void

  addHighlight(pattern: string, color: HighlightColor): void
  toggleHighlight(id: string): void
  removeHighlight(id: string): void

  addAlert(pattern: string, label: string): void
  toggleAlert(id: string): void
  removeAlert(id: string): void
  markAlertTriggered(id: string): void
}

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key)
    return raw ? (JSON.parse(raw) as T) : fallback
  } catch {
    return fallback
  }
}

function save<T>(key: string, value: T): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* ignore */ }
}

const FK = "beacon:filters:v1"
const HK = "beacon:highlights:v1"
const AK = "beacon:alerts:v1"

export const useRules = create<RulesStore>((set) => ({
  filters: load<FilterPreset[]>(FK, []),
  highlights: load<HighlightRule[]>(HK, []),
  alerts: load<AlertRule[]>(AK, []),
  alertLastTriggered: {},

  addFilter(name, pattern) {
    set((s) => {
      const filters = [...s.filters, { id: crypto.randomUUID(), name, pattern }]
      save(FK, filters)
      return { filters }
    })
  },
  removeFilter(id) {
    set((s) => {
      const filters = s.filters.filter((f) => f.id !== id)
      save(FK, filters)
      return { filters }
    })
  },

  addHighlight(pattern, color) {
    set((s) => {
      const highlights = [...s.highlights, { id: crypto.randomUUID(), pattern, color, enabled: true }]
      save(HK, highlights)
      return { highlights }
    })
  },
  toggleHighlight(id) {
    set((s) => {
      const highlights = s.highlights.map((h) => h.id === id ? { ...h, enabled: !h.enabled } : h)
      save(HK, highlights)
      return { highlights }
    })
  },
  removeHighlight(id) {
    set((s) => {
      const highlights = s.highlights.filter((h) => h.id !== id)
      save(HK, highlights)
      return { highlights }
    })
  },

  addAlert(pattern, label) {
    set((s) => {
      const alerts = [...s.alerts, { id: crypto.randomUUID(), pattern, label, enabled: true }]
      save(AK, alerts)
      return { alerts }
    })
  },
  toggleAlert(id) {
    set((s) => {
      const alerts = s.alerts.map((a) => a.id === id ? { ...a, enabled: !a.enabled } : a)
      save(AK, alerts)
      return { alerts }
    })
  },
  removeAlert(id) {
    set((s) => {
      const alerts = s.alerts.filter((a) => a.id !== id)
      save(AK, alerts)
      return { alerts }
    })
  },
  markAlertTriggered(id) {
    set((s) => ({ alertLastTriggered: { ...s.alertLastTriggered, [id]: Date.now() } }))
  },
}))

export const HIGHLIGHT_COLOR_CLASSES: Record<HighlightColor, string> = {
  danger: "bg-danger/15 text-danger",
  warn: "bg-warn/15 text-warn",
  ok: "bg-ok/15 text-ok",
  accent: "bg-accent/15 text-accent",
}

export const HIGHLIGHT_COLOR_LABELS: Record<HighlightColor, string> = {
  danger: "Red",
  warn: "Yellow",
  ok: "Green",
  accent: "Blue",
}

export const HIGHLIGHT_COLOR_DOT: Record<HighlightColor, string> = {
  danger: "bg-danger",
  warn: "bg-warn",
  ok: "bg-ok",
  accent: "bg-accent",
}

/** Rate-limit constant: 30 seconds between notifications per rule. */
export const ALERT_COOLDOWN_MS = 30_000
