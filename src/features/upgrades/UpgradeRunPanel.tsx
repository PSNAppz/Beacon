import { useState, useEffect, useRef } from "react";
import {
  onUpgradeStepStart,
  onUpgradeStepOutput,
  onUpgradeStepDone,
  onUpgradeComplete,
  UpgradeStepOutput,
} from "../../lib/ipc";

type StepStatus = "pending" | "running" | "done" | "failed";

interface StepState {
  command: string;
  status: StepStatus;
  lines: UpgradeStepOutput[];
  exitCode?: number;
}

interface Props {
  sessionId: string;
  runId: string;
  steps: string[];
  onClose: () => void;
  onComplete?: (success: boolean) => void;
}

const STATUS_ICON: Record<StepStatus, string> = {
  pending: "○",
  running: "◌",
  done: "✓",
  failed: "✗",
};

const STATUS_COLOR: Record<StepStatus, string> = {
  pending: "text-white/25",
  running: "text-indigo-400",
  done: "text-emerald-400",
  failed: "text-red-400",
};

export function UpgradeRunPanel({ sessionId, runId, steps, onClose, onComplete }: Props) {
  const [stepStates, setStepStates] = useState<StepState[]>(
    steps.map((cmd) => ({ command: cmd, status: "pending", lines: [] }))
  );
  const [done, setDone] = useState(false);
  const [success, setSuccess] = useState(false);
  const [inputText, setInputText] = useState("");
  const [inputMasked, setInputMasked] = useState(false);
  const [activeStep, setActiveStep] = useState<number | null>(null);
  const logEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [stepStates]);

  useEffect(() => {
    const unsubs: Array<() => void> = [];

    onUpgradeStepStart((e) => {
      if (e.run_id !== runId) return;
      setActiveStep(e.step_index);
      setStepStates((prev) =>
        prev.map((s, i) =>
          i === e.step_index ? { ...s, status: "running", command: e.command } : s
        )
      );
    }).then((u) => unsubs.push(u));

    onUpgradeStepOutput((e) => {
      if (e.run_id !== runId) return;
      setStepStates((prev) =>
        prev.map((s, i) => (i === e.step_index ? { ...s, lines: [...s.lines, e] } : s))
      );
      if (e.is_prompt) {
        setInputMasked(true);
        inputRef.current?.focus();
      }
    }).then((u) => unsubs.push(u));

    onUpgradeStepDone((e) => {
      if (e.run_id !== runId) return;
      setStepStates((prev) =>
        prev.map((s, i) =>
          i === e.step_index
            ? { ...s, status: e.exit_code === 0 ? "done" : "failed", exitCode: e.exit_code }
            : s
        )
      );
      setInputMasked(false);
    }).then((u) => unsubs.push(u));

    onUpgradeComplete((e) => {
      if (e.run_id !== runId) return;
      setDone(true);
      setSuccess(e.success);
      setActiveStep(null);
      onComplete?.(e.success);
    }).then((u) => unsubs.push(u));

    return () => unsubs.forEach((u) => u());
  }, [runId]);

  async function sendInput() {
    if (!inputText.trim() && !inputMasked) return;
    const text = inputText;
    setInputText("");
    try {
      await upgradeApi.sendInput(runId, text);
    } catch (_) {}
  }

  function handleInputKey(e: React.KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      sendInput();
    }
  }

  return (
    <div className="flex shrink-0 flex-col border-t border-border bg-surface h-72">
      {/* Header */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-1.5 text-[11px] shrink-0">
        <span className="text-sm">🚀</span>
        <span className="font-medium text-fg">Upgrade</span>
        <span className="text-muted">· {sessionId.slice(0, 8)}…</span>
        {done && (
          <span
            className={`ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium ${
              success
                ? "bg-emerald-500/15 text-emerald-400"
                : "bg-red-500/15 text-red-400"
            }`}
          >
            {success ? "✓ Complete" : "✗ Failed"}
          </span>
        )}
        <div className="ml-auto">
          {done ? (
            <button
              onClick={onClose}
              className="px-2.5 py-1 rounded text-[11px] font-medium bg-white/8 hover:bg-white/12 text-fg/70 hover:text-fg transition-colors"
            >
              Back to Console
            </button>
          ) : (
            <button
              onClick={onClose}
              className="text-muted hover:text-fg transition-colors px-1.5 py-0.5 rounded hover:bg-white/5 text-[11px]"
            >
              ✕
            </button>
          )}
        </div>
      </div>

      {/* Step list + output */}
      <div className="flex-1 overflow-y-auto px-3 py-2 space-y-3 font-mono text-xs">
        {stepStates.map((step, i) => (
          <div key={i} className="space-y-1">
            <div className="flex items-center gap-2">
              <span
                className={`${STATUS_COLOR[step.status]} ${
                  step.status === "running" ? "animate-pulse" : ""
                }`}
              >
                {STATUS_ICON[step.status]}
              </span>
              <span className="text-white/70">{step.command}</span>
              {step.exitCode !== undefined && step.exitCode !== 0 && (
                <span className="text-red-400/60 text-[10px]">exit {step.exitCode}</span>
              )}
            </div>

            {step.lines.length > 0 && (
              <div className="ml-4 space-y-0.5">
                {step.lines.map((line, j) => (
                  <div
                    key={j}
                    className={`leading-relaxed ${
                      line.is_prompt
                        ? "text-amber-300/90 font-semibold"
                        : line.is_stderr
                        ? "text-red-300/70"
                        : "text-white/50"
                    }`}
                  >
                    {line.line}
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
        <div ref={logEndRef} />
      </div>

      {/* Stdin bar */}
      <div className="shrink-0 border-t border-border px-3 py-2">
        <div className="flex items-center gap-2 bg-white/4 border border-border rounded px-2 py-1.5">
          <span className="text-muted text-xs shrink-0">
            {inputMasked ? "🔒" : "›"}
          </span>
          <input
            ref={inputRef}
            type={inputMasked ? "password" : "text"}
            placeholder={
              done
                ? "Upgrade finished"
                : activeStep !== null
                ? inputMasked
                  ? "Enter credential…"
                  : "Send input to remote process…"
                : "Waiting…"
            }
            value={inputText}
            onChange={(e) => setInputText(e.target.value)}
            onKeyDown={handleInputKey}
            disabled={done || activeStep === null}
            className="flex-1 bg-transparent text-xs text-fg placeholder-muted focus:outline-none font-mono disabled:opacity-30"
            autoComplete="off"
            autoCorrect="off"
            spellCheck={false}
          />
          <button
            onClick={sendInput}
            disabled={done || activeStep === null}
            className="shrink-0 text-muted hover:text-indigo-400 disabled:opacity-20 transition-colors text-xs"
            title="Send (Enter)"
          >
            ↵
          </button>
          {inputMasked && (
            <button
              onClick={() => setInputMasked(false)}
              className="shrink-0 text-muted hover:text-fg/50 transition-colors text-[10px]"
              title="Switch to plain text"
            >
              show
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
