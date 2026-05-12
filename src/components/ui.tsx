import { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";

type Variant = "primary" | "ghost" | "danger" | "subtle";

export function Button({
  variant = "subtle",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const styles: Record<Variant, string> = {
    primary: "bg-accent/15 text-accent hover:bg-accent/25 disabled:opacity-50",
    ghost: "text-muted hover:bg-surface-2 hover:text-fg",
    danger: "bg-danger/15 text-danger hover:bg-danger/25",
    subtle: "bg-surface-2 text-fg hover:bg-border",
  };
  return (
    <button
      className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3.5 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed ${styles[variant]} ${className}`}
      {...props}
    />
  );
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      className={`w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg placeholder:text-muted focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20 ${className}`}
      {...props}
    />
  );
}

export function Select({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select
      className={`w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20 ${className}`}
      {...props}
    >
      {children}
    </select>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="block space-y-1.5">
      <div className="flex items-baseline justify-between">
        <span className="text-xs font-medium uppercase tracking-wider text-muted">{label}</span>
        {hint ? <span className="text-[11px] text-muted">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

export function Modal({
  open,
  onClose,
  title,
  children,
  footer,
  width = "max-w-xl",
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
}) {
  if (!open) return null;
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/60 p-4" onClick={onClose}>
      <div
        className={`w-full ${width} rounded-2xl border border-border bg-surface shadow-2xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
          <h2 className="text-base font-semibold">{title}</h2>
          <button onClick={onClose} className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg" aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
              <path d="M18 6 6 18M6 6l12 12" />
            </svg>
          </button>
        </div>
        <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
        {footer ? <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div> : null}
      </div>
    </div>
  );
}

export function Toast({
  kind,
  message,
  onDismiss,
}: {
  kind: "ok" | "error" | "info";
  message: string;
  onDismiss?: () => void;
}) {
  const tone =
    kind === "ok"
      ? "border-ok/40 text-ok"
      : kind === "error"
      ? "border-danger/40 text-danger"
      : "border-border text-muted";
  return (
    <div className={`flex items-center gap-3 rounded-lg border ${tone} bg-surface px-4 py-2 text-sm shadow-lg`}>
      <span className="flex-1">{message}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 text-muted hover:text-fg" aria-label="Dismiss">
          ✕
        </button>
      )}
    </div>
  );
}
