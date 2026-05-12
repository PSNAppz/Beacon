import { useState } from "react"
import { Modal, Button, Input, Field } from "../../components/ui"
import {
  useRules,
  HIGHLIGHT_COLOR_CLASSES,
  HIGHLIGHT_COLOR_LABELS,
  HIGHLIGHT_COLOR_DOT,
  type HighlightColor,
} from "../../lib/rulesStore"

type Tab = "filters" | "highlights" | "alerts"

export function RulesModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("filters")

  return (
    <Modal open={open} onClose={onClose} title="Rules" width="max-w-lg">
      <div className="flex gap-1 border-b border-border pb-3 mb-4">
        {(["filters", "highlights", "alerts"] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`rounded px-3 py-1 text-[12px] font-medium capitalize transition-colors ${
              tab === t ? "bg-accent/15 text-accent" : "text-muted hover:bg-surface-2 hover:text-fg"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {tab === "filters" && <FiltersTab />}
      {tab === "highlights" && <HighlightsTab />}
      {tab === "alerts" && <AlertsTab />}
    </Modal>
  )
}

// ─── Filters tab ──────────────────────────────────────────────────────────────

function FiltersTab() {
  const filters = useRules((s) => s.filters)
  const addFilter = useRules((s) => s.addFilter)
  const removeFilter = useRules((s) => s.removeFilter)
  const [name, setName] = useState("")
  const [pattern, setPattern] = useState("")
  const [patternError, setPatternError] = useState("")

  function validatePattern(p: string) {
    try { new RegExp(p); setPatternError("") } catch (e) { setPatternError(String(e)) }
  }

  function handleAdd() {
    if (!name.trim() || !pattern.trim() || patternError) return
    addFilter(name.trim(), pattern.trim())
    setName("")
    setPattern("")
  }

  return (
    <div className="space-y-4">
      {filters.length === 0 ? (
        <p className="text-[12px] text-muted">No saved filters yet. Add one below.</p>
      ) : (
        <div className="space-y-1">
          {filters.map((f) => (
            <div key={f.id} className="flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2">
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium">{f.name}</div>
                <div className="truncate font-mono text-[11px] text-muted">{f.pattern}</div>
              </div>
              <button
                onClick={() => removeFilter(f.id)}
                className="shrink-0 rounded p-1 text-muted hover:bg-surface hover:text-danger"
                title="Delete"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-border pt-4 space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Add Filter</p>
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Errors only"
            className="py-1.5 text-[12px]"
          />
        </Field>
        <Field label="Regex Pattern" hint={patternError ? <span className="text-danger">{patternError}</span> : undefined}>
          <Input
            value={pattern}
            onChange={(e) => { setPattern(e.target.value); validatePattern(e.target.value) }}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="e.g. error|warn"
            className="py-1.5 font-mono text-[12px]"
          />
        </Field>
        <Button
          variant="primary"
          onClick={handleAdd}
          disabled={!name.trim() || !pattern.trim() || !!patternError}
          className="py-1.5 text-[12px]"
        >
          Save Filter
        </Button>
      </div>
    </div>
  )
}

// ─── Highlights tab ───────────────────────────────────────────────────────────

function HighlightsTab() {
  const highlights = useRules((s) => s.highlights)
  const addHighlight = useRules((s) => s.addHighlight)
  const toggleHighlight = useRules((s) => s.toggleHighlight)
  const removeHighlight = useRules((s) => s.removeHighlight)
  const [pattern, setPattern] = useState("")
  const [color, setColor] = useState<HighlightColor>("warn")
  const [patternError, setPatternError] = useState("")

  function validatePattern(p: string) {
    try { new RegExp(p); setPatternError("") } catch (e) { setPatternError(String(e)) }
  }

  function handleAdd() {
    if (!pattern.trim() || patternError) return
    addHighlight(pattern.trim(), color)
    setPattern("")
  }

  return (
    <div className="space-y-4">
      {highlights.length === 0 ? (
        <p className="text-[12px] text-muted">No highlight rules yet. Add one below.</p>
      ) : (
        <div className="space-y-1">
          {highlights.map((h) => (
            <div key={h.id} className={`flex items-center gap-2 rounded-lg border border-border px-3 py-2 ${h.enabled ? HIGHLIGHT_COLOR_CLASSES[h.color] : "bg-surface-2 text-muted opacity-60"}`}>
              <button
                onClick={() => toggleHighlight(h.id)}
                className="shrink-0"
                title={h.enabled ? "Disable" : "Enable"}
              >
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${h.enabled ? HIGHLIGHT_COLOR_DOT[h.color] : "bg-muted"}`} />
              </button>
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">{h.pattern}</span>
              <span className="shrink-0 text-[10px] opacity-70">{HIGHLIGHT_COLOR_LABELS[h.color]}</span>
              <button
                onClick={() => removeHighlight(h.id)}
                className="shrink-0 rounded p-1 opacity-60 hover:opacity-100"
                title="Delete"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-border pt-4 space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Add Rule</p>
        <Field label="Regex Pattern" hint={patternError ? <span className="text-danger text-[11px]">{patternError}</span> : undefined}>
          <Input
            value={pattern}
            onChange={(e) => { setPattern(e.target.value); validatePattern(e.target.value) }}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="e.g. ERROR|WARN"
            className="py-1.5 font-mono text-[12px]"
          />
        </Field>
        <Field label="Color">
          <div className="flex gap-2">
            {(["danger", "warn", "ok", "accent"] as HighlightColor[]).map((c) => (
              <button
                key={c}
                onClick={() => setColor(c)}
                title={HIGHLIGHT_COLOR_LABELS[c]}
                className={`flex items-center gap-1.5 rounded-lg border px-3 py-1.5 text-[11px] transition-colors ${
                  color === c
                    ? `border-transparent ${HIGHLIGHT_COLOR_CLASSES[c]}`
                    : "border-border text-muted hover:border-muted"
                }`}
              >
                <span className={`h-2 w-2 rounded-full ${HIGHLIGHT_COLOR_DOT[c]}`} />
                {HIGHLIGHT_COLOR_LABELS[c]}
              </button>
            ))}
          </div>
        </Field>
        <Button
          variant="primary"
          onClick={handleAdd}
          disabled={!pattern.trim() || !!patternError}
          className="py-1.5 text-[12px]"
        >
          Add Rule
        </Button>
      </div>
    </div>
  )
}

// ─── Alerts tab ───────────────────────────────────────────────────────────────

function AlertsTab() {
  const alerts = useRules((s) => s.alerts)
  const addAlert = useRules((s) => s.addAlert)
  const toggleAlert = useRules((s) => s.toggleAlert)
  const removeAlert = useRules((s) => s.removeAlert)
  const [pattern, setPattern] = useState("")
  const [label, setLabel] = useState("")
  const [patternError, setPatternError] = useState("")

  function validatePattern(p: string) {
    try { new RegExp(p); setPatternError("") } catch (e) { setPatternError(String(e)) }
  }

  function handleAdd() {
    if (!pattern.trim() || !label.trim() || patternError) return
    addAlert(pattern.trim(), label.trim())
    setPattern("")
    setLabel("")
  }

  return (
    <div className="space-y-4">
      <p className="text-[11px] text-muted">
        When a log line matches a pattern, a desktop notification fires. Rate-limited to once per rule per 30 s.
      </p>

      {alerts.length === 0 ? (
        <p className="text-[12px] text-muted">No alert rules yet. Add one below.</p>
      ) : (
        <div className="space-y-1">
          {alerts.map((a) => (
            <div key={a.id} className={`flex items-center gap-2 rounded-lg border border-border bg-surface-2 px-3 py-2 ${!a.enabled ? "opacity-50" : ""}`}>
              <button
                onClick={() => toggleAlert(a.id)}
                title={a.enabled ? "Disable" : "Enable"}
                className="shrink-0"
              >
                <span className={`inline-block h-2.5 w-2.5 rounded-full ${a.enabled ? "bg-warn" : "bg-muted"}`} />
              </button>
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-medium">{a.label}</div>
                <div className="truncate font-mono text-[11px] text-muted">{a.pattern}</div>
              </div>
              <button
                onClick={() => removeAlert(a.id)}
                className="shrink-0 rounded p-1 text-muted hover:bg-surface hover:text-danger"
                title="Delete"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6 6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}

      <div className="border-t border-border pt-4 space-y-3">
        <p className="text-[11px] font-semibold uppercase tracking-wider text-muted">Add Alert</p>
        <Field label="Regex Pattern" hint={patternError ? <span className="text-danger text-[11px]">{patternError}</span> : undefined}>
          <Input
            value={pattern}
            onChange={(e) => { setPattern(e.target.value); validatePattern(e.target.value) }}
            placeholder="e.g. FATAL|panic"
            className="py-1.5 font-mono text-[12px]"
          />
        </Field>
        <Field label="Notification Label">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
            placeholder="e.g. Fatal error detected"
            className="py-1.5 text-[12px]"
          />
        </Field>
        <Button
          variant="primary"
          onClick={handleAdd}
          disabled={!pattern.trim() || !label.trim() || !!patternError}
          className="py-1.5 text-[12px]"
        >
          Add Alert
        </Button>
      </div>
    </div>
  )
}
