import { useState } from "react";
import { UpgradeFlow } from "../../lib/ipc";

interface Props {
  sessionName: string;
  flow: UpgradeFlow;
  onConfirm: (steps: string[]) => void;
  onCancel: () => void;
}

function resolveSteps(flow: UpgradeFlow): string[] {
  const dir = flow.working_directory?.trim();
  if (!dir) return [...flow.steps];
  return flow.steps.map((s) => `cd ${dir} && ${s}`);
}

export function UpgradeConfirmDialog({ sessionName, flow, onConfirm, onCancel }: Props) {
  const [steps, setSteps] = useState<string[]>(resolveSteps(flow));

  function updateStep(i: number, val: string) {
    setSteps((s) => s.map((v, idx) => idx === i ? val : v));
  }

  const label = flow.label || sessionName;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
      <div className="bg-[#1a1d27] border border-white/10 rounded-2xl w-full max-w-lg shadow-2xl flex flex-col">
        {/* Header */}
        <div className="px-6 py-5 border-b border-white/8">
          <div className="flex items-center gap-3 mb-1">
            <span className="text-xl">🚀</span>
            <h2 className="text-base font-semibold text-white">Confirm Server Upgrade</h2>
          </div>
          <p className="text-xs text-white/40 ml-8">
            <span className="text-white/70 font-medium">{label}</span>
          </p>
        </div>

        {/* Body */}
        <div className="px-6 py-5 space-y-5">
          <div className="flex items-start gap-2.5 bg-amber-500/8 border border-amber-500/20 rounded-lg px-3.5 py-3">
            <span className="text-amber-400 text-sm mt-0.5">⚠</span>
            <p className="text-xs text-amber-200/70">
              Review and edit commands before running. Changes here are <strong>not saved</strong> — they only affect this run.
            </p>
          </div>

          {flow.working_directory && (
            <div className="flex items-center gap-2 text-xs text-white/40">
              <span className="text-white/20">📁</span>
              Working directory:{" "}
              <code className="text-white/60 bg-white/5 px-1.5 py-0.5 rounded font-mono">
                {flow.working_directory}
              </code>
            </div>
          )}

          <div>
            <label className="block text-xs font-medium text-white/50 mb-2">
              Steps to execute on <span className="text-white/70">{sessionName}</span>
            </label>
            <div className="space-y-2">
              {steps.map((step, i) => (
                <div key={i} className="flex items-start gap-2.5">
                  <span className="shrink-0 w-5 h-5 mt-2 rounded-full bg-indigo-500/20 text-indigo-300 text-[10px] flex items-center justify-center font-mono">
                    {i + 1}
                  </span>
                  <textarea
                    rows={step.length > 60 ? 2 : 1}
                    className="flex-1 bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-white font-mono placeholder-white/25 focus:outline-none focus:border-indigo-500/60 resize-none"
                    value={step}
                    onChange={(e) => updateStep(i, e.target.value)}
                  />
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-white/8 flex justify-end gap-3">
          <button onClick={onCancel} className="px-4 py-2 text-sm text-white/50 hover:text-white/80 transition-colors">
            Cancel
          </button>
          <button
            onClick={() => onConfirm(steps.filter((s) => s.trim()))}
            disabled={steps.every((s) => !s.trim())}
            className="px-5 py-2 bg-indigo-600 hover:bg-indigo-500 disabled:opacity-40 text-white text-sm font-medium rounded-lg transition-colors flex items-center gap-2"
          >
            <span>🚀</span> Run Upgrade
          </button>
        </div>
      </div>
    </div>
  );
}
