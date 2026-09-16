import { useState } from "react";
import { upgradeApi, UpgradeFlow, UpgradeFlowInput, errorMessage } from "../../lib/ipc";

interface Props {
  sessionId: string;
  sessionName: string;
  existing: UpgradeFlow | null;
  onSave: (flow: UpgradeFlow) => void;
  onDelete: () => void;
  onClose: () => void;
}

const PLACEHOLDER_STEPS = [
  "git pull",
  "docker-compose down && docker-compose up --build -d",
];

export function UpgradeFlowWizard({ sessionId, sessionName, existing, onSave, onDelete, onClose }: Props) {
  const [label, setLabel] = useState(existing?.label ?? "");
  const [workingDirectory, setWorkingDirectory] = useState(existing?.working_directory ?? "");
  const [steps, setSteps] = useState<string[]>(
    existing?.steps.length ? existing.steps : [""]
  );
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function addStep() { setSteps((s) => [...s, ""]); }
  function removeStep(i: number) { setSteps((s) => s.filter((_, idx) => idx !== i)); }
  function updateStep(i: number, val: string) { setSteps((s) => s.map((v, idx) => idx === i ? val : v)); }
  function moveStep(i: number, dir: -1 | 1) {
    setSteps((s) => {
      const next = [...s];
      const j = i + dir;
      if (j < 0 || j >= next.length) return s;
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  }

  async function handleSave() {
    const cleanSteps = steps.filter((s) => s.trim());
    if (!cleanSteps.length) { setError("Add at least one command step"); return; }
    setSaving(true); setError(null);
    try {
      const input: UpgradeFlowInput = {
        id: existing?.id,
        session_id: sessionId,
        label: label.trim() || null,
        working_directory: workingDirectory.trim() || null,
        steps: cleanSteps,
      };
      const saved = await upgradeApi.saveFlow(input);
      onSave(saved);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!existing) return;
    setDeleting(true);
    try {
      await upgradeApi.deleteFlow(sessionId);
      onDelete();
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-sm">
      <div className="bg-[#1a1d27] border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl flex flex-col">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-5 border-b border-white/8">
          <div>
            <h2 className="text-base font-semibold text-white">
              {existing ? "Edit" : "Set Up"} Upgrade Flow
            </h2>
            <p className="text-xs text-white/40 mt-0.5">
              for server <span className="text-white/60 font-medium">{sessionName}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-white/40 hover:text-white/80 transition-colors text-lg leading-none">✕</button>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5 overflow-y-auto max-h-[65vh]">
          {/* Info */}
          <div className="bg-accent/8 border border-accent/20 rounded-lg px-3.5 py-3 text-xs text-accent/70 space-y-1">
            <p>Each step is a <strong>complete shell command</strong> run on the server.</p>
            <p>Set a <strong>working directory</strong> and it will be applied to every step automatically — no need to repeat <code className="bg-white/10 px-1 rounded">cd</code> in each command.</p>
          </div>

          {/* Label */}
          <div>
            <label className="block text-xs font-medium text-white/50 mb-1.5">
              Label <span className="text-white/25">(optional)</span>
            </label>
            <input
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white placeholder-white/25 focus:outline-none focus:border-accent/60"
              placeholder={`${sessionName} upgrade`}
              value={label}
              onChange={(e) => setLabel(e.target.value)}
            />
          </div>

          {/* Working directory */}
          <div>
            <label className="block text-xs font-medium text-white/50 mb-1.5">
              Working directory <span className="text-white/25">(optional)</span>
            </label>
            <input
              className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder-white/25 focus:outline-none focus:border-accent/60"
              placeholder="/home/ubuntu/my-app"
              value={workingDirectory}
              onChange={(e) => setWorkingDirectory(e.target.value)}
            />
            <p className="mt-1 text-[11px] text-white/30">
              Each step will run as <code className="text-white/40">cd &lt;dir&gt; &amp;&amp; &lt;command&gt;</code>
            </p>
          </div>

          {/* Steps */}
          <div>
            <label className="block text-xs font-medium text-white/50 mb-2">
              Steps <span className="text-white/25">(run in order, stops on first failure)</span>
            </label>
            <div className="space-y-2">
              {steps.map((step, i) => (
                <div key={i} className="flex items-start gap-2">
                  <div className="flex flex-col gap-0.5 mt-2.5 shrink-0">
                    <button onClick={() => moveStep(i, -1)} disabled={i === 0} className="text-white/20 hover:text-white/60 disabled:opacity-0 text-[10px] leading-none transition-colors" title="Move up">▲</button>
                    <button onClick={() => moveStep(i, 1)} disabled={i === steps.length - 1} className="text-white/20 hover:text-white/60 disabled:opacity-0 text-[10px] leading-none transition-colors" title="Move down">▼</button>
                  </div>
                  <span className="shrink-0 w-5 h-5 mt-2 rounded-full bg-white/8 text-white/30 text-[10px] flex items-center justify-center font-mono">{i + 1}</span>
                  <textarea
                    rows={step.length > 60 ? 2 : 1}
                    className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder-white/20 focus:outline-none focus:border-accent/60 resize-none"
                    placeholder={PLACEHOLDER_STEPS[i] ?? "command…"}
                    value={step}
                    onChange={(e) => updateStep(i, e.target.value)}
                  />
                  <button onClick={() => removeStep(i)} className="shrink-0 mt-2 text-white/20 hover:text-danger transition-colors text-sm" title="Remove step">✕</button>
                </div>
              ))}
            </div>
            <button onClick={addStep} className="mt-3 flex items-center gap-1.5 text-xs text-accent hover:text-accent transition-colors">
              <span className="text-base leading-none">+</span> Add step
            </button>
          </div>

          {error && (
            <p className="text-xs text-danger bg-danger/10 border border-danger/20 rounded-lg px-3 py-2">{error}</p>
          )}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/8 flex items-center justify-between">
          <div>
            {existing && (
              <button
                onClick={handleDelete}
                disabled={deleting}
                className="text-xs text-danger/60 hover:text-danger transition-colors disabled:opacity-50"
              >
                {deleting ? "Deleting…" : "Delete flow"}
              </button>
            )}
          </div>
          <div className="flex gap-3">
            <button onClick={onClose} className="px-4 py-2 text-sm text-white/50 hover:text-white/80 transition-colors">Cancel</button>
            <button
              onClick={handleSave}
              disabled={saving}
              className="px-5 py-2 bg-fg hover:bg-fg/90 disabled:opacity-50 text-bg text-sm font-medium rounded-lg transition-colors"
            >
              {saving ? "Saving…" : "Save Flow"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
