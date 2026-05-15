export interface S3BackupItem {
  containerName: string;
  status: "uploading" | "done" | "skipped" | "error";
  key?: string;
  error?: string;
}

export interface S3BackupPhase {
  sessionId: string;
  items: S3BackupItem[];
  awaitingConfirm: boolean;
  pendingSteps: string[];
  pendingRunId: string;
}

interface Props {
  phase: S3BackupPhase;
  onProceed: () => void;
  onCancel: () => void;
}

const allDone = (items: S3BackupItem[]) =>
  items.every((i) => i.status !== "uploading");

const failureCount = (items: S3BackupItem[]) =>
  items.filter((i) => i.status === "error").length;

export function S3BackupPhasePanel({ phase, onProceed, onCancel }: Props) {
  const done = allDone(phase.items);
  const failures = failureCount(phase.items);

  return (
    <div className="flex flex-col bg-[#0f1117] border-t border-white/8 text-[13px] font-mono" style={{ height: 220 }}>
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-2 border-b border-white/8 shrink-0">
        <div className="flex items-center gap-2">
          {done ? (
            failures > 0 ? (
              <span className="text-red-400">✗</span>
            ) : (
              <span className="text-emerald-400">✓</span>
            )
          ) : (
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="animate-spin text-indigo-400">
              <path d="M21 12a9 9 0 1 1-6.219-8.56" />
            </svg>
          )}
          <span className="text-white/70 text-[12px] font-sans font-medium">
            {done
              ? failures > 0
                ? `${failures} backup${failures > 1 ? "s" : ""} failed`
                : "Logs backed up — starting upgrade…"
              : "Backing up logs to S3…"}
          </span>
        </div>
        <button
          onClick={onCancel}
          className="text-white/30 hover:text-white/60 transition-colors text-[11px] font-sans"
        >
          Cancel
        </button>
      </div>

      {/* Item list */}
      <div className="flex-1 overflow-y-auto px-4 py-2 space-y-1.5">
        {phase.items.map((item, i) => (
          <div key={i} className="flex items-start gap-2.5">
            <span className="shrink-0 mt-0.5 w-4 text-center">
              {item.status === "uploading" ? (
                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="animate-spin text-indigo-400">
                  <path d="M21 12a9 9 0 1 1-6.219-8.56" />
                </svg>
              ) : item.status === "done" ? (
                <span className="text-emerald-400 text-[11px]">✓</span>
              ) : item.status === "skipped" ? (
                <span className="text-white/30 text-[11px]">–</span>
              ) : (
                <span className="text-red-400 text-[11px]">✗</span>
              )}
            </span>
            <div className="min-w-0">
              <span className="text-white/70 text-[12px]">{item.containerName}</span>
              {item.status === "done" && item.key && item.key !== "no-new-logs" && (
                <div className="text-white/30 text-[11px] truncate mt-0.5">{item.key}</div>
              )}
              {item.status === "skipped" && (
                <div className="text-white/25 text-[11px] mt-0.5">no new logs</div>
              )}
              {item.status === "error" && item.error && (
                <div className="text-red-400/70 text-[11px] mt-0.5">{item.error}</div>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* Footer — only shown when waiting for confirmation */}
      {phase.awaitingConfirm && (
        <div className="shrink-0 flex items-center justify-between gap-3 px-4 py-2 border-t border-white/8 bg-red-950/20">
          <span className="text-red-300/70 text-[12px] font-sans">
            {failures} backup{failures > 1 ? "s" : ""} failed. Proceed with upgrade anyway?
          </span>
          <div className="flex gap-2">
            <button
              onClick={onCancel}
              className="px-3 py-1 text-[12px] font-sans text-white/40 hover:text-white/70 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onProceed}
              className="px-3 py-1 text-[12px] font-sans bg-red-600/80 hover:bg-red-500/80 text-white rounded transition-colors"
            >
              Proceed Anyway
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
