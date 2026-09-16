import { ButtonHTMLAttributes, forwardRef, InputHTMLAttributes, ReactNode, SelectHTMLAttributes } from "react";
import * as Dialog from "@radix-ui/react-dialog";
import * as AlertDialog from "@radix-ui/react-alert-dialog";
import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { ChevronRight, X } from "lucide-react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "../lib/cn";

// ─── Button ──────────────────────────────────────────────────────────────────

const button = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors " +
    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 " +
    "focus-visible:ring-offset-bg disabled:cursor-not-allowed disabled:opacity-50",
  {
    variants: {
      variant: {
        primary: "bg-accent/15 text-accent hover:bg-accent/25",
        solid: "bg-fg text-bg hover:bg-fg/90",
        ghost: "text-muted hover:bg-surface-2 hover:text-fg",
        danger: "bg-danger/15 text-danger hover:bg-danger/25",
        subtle: "bg-surface-2 text-fg hover:bg-border",
        outline: "border border-border text-fg hover:bg-surface-2",
      },
      size: {
        sm: "px-2.5 py-1 text-[12px]",
        md: "px-3.5 py-2 text-sm",
        icon: "h-8 w-8 p-0",
      },
    },
    defaultVariants: { variant: "subtle", size: "md" },
  },
);

export type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof button>;

/** Forwards its ref so Radix `asChild` slots (AlertDialog.Cancel/Action, menu
 *  triggers) can focus and control the real button. */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant, size, className, ...props },
  ref,
) {
  return <button ref={ref} className={cn(button({ variant, size }), className)} {...props} />;
});

// ─── Form controls ───────────────────────────────────────────────────────────

const field =
  "w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-fg " +
  "placeholder:text-muted focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/20";

export function Input({ className, ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={cn(field, className)} {...props} />;
}

export function Select({ className, children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cn(field, className)} {...props}>
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

// ─── Modal ───────────────────────────────────────────────────────────────────

const overlay =
  "fixed inset-0 z-50 bg-black/60 backdrop-blur-sm " +
  "data-[state=open]:animate-in data-[state=closed]:animate-out " +
  "data-[state=open]:fade-in-0 data-[state=closed]:fade-out-0";

const panel =
  "fixed left-1/2 top-1/2 z-50 w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 " +
  "rounded-2xl border border-border bg-surface shadow-2xl focus:outline-none";

/**
 * Radix-backed dialog: focus trap, ESC to close, scroll lock and correct ARIA.
 *
 * `dismissable={false}` blocks backdrop-click and ESC — use it for forms with
 * unsaved input, where a stray click used to throw the whole thing away.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  width = "max-w-xl",
  dismissable = true,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: string;
  children: ReactNode;
  footer?: ReactNode;
  width?: string;
  dismissable?: boolean;
}) {
  return (
    <Dialog.Root open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <Dialog.Portal>
        <Dialog.Overlay className={overlay} />
        <Dialog.Content
          className={cn(panel, width)}
          onInteractOutside={(e) => { if (!dismissable) e.preventDefault(); }}
          onEscapeKeyDown={(e) => { if (!dismissable) e.preventDefault(); }}
        >
          <div className="flex items-center justify-between border-b border-border px-5 py-3.5">
            <div className="min-w-0">
              <Dialog.Title className="text-base font-semibold">{title}</Dialog.Title>
              {description ? (
                <Dialog.Description className="mt-0.5 text-[12px] text-muted">
                  {description}
                </Dialog.Description>
              ) : (
                <Dialog.Description className="sr-only">{title}</Dialog.Description>
              )}
            </div>
            <Dialog.Close
              className="rounded-md p-1 text-muted hover:bg-surface-2 hover:text-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              aria-label="Close"
            >
              <X size={16} />
            </Dialog.Close>
          </div>
          <div className="max-h-[70vh] overflow-y-auto px-5 py-4">{children}</div>
          {footer ? (
            <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
          ) : null}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ─── Confirm ─────────────────────────────────────────────────────────────────

/**
 * Replacement for `window.confirm`, which the app used for destructive actions.
 * Cancel is focused by default so Enter never deletes anything.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  body,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  destructive = false,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  body?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  destructive?: boolean;
  onConfirm: () => void;
}) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={overlay} />
        <AlertDialog.Content className={cn(panel, "max-w-md p-5")}>
          <AlertDialog.Title className="text-base font-semibold">{title}</AlertDialog.Title>
          {body ? (
            <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-muted">
              {body}
            </AlertDialog.Description>
          ) : null}
          <div className="mt-5 flex items-center justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button variant="ghost">{cancelLabel}</Button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <Button variant={destructive ? "danger" : "primary"} onClick={onConfirm}>
                {confirmLabel}
              </Button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

// ─── Toast ───────────────────────────────────────────────────────────────────

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
    <div className={cn("flex items-center gap-3 rounded-lg border bg-surface px-4 py-2 text-sm shadow-lg", tone)}>
      <span className="flex-1">{message}</span>
      {onDismiss && (
        <button onClick={onDismiss} className="shrink-0 text-muted hover:text-fg" aria-label="Dismiss">
          <X size={14} />
        </button>
      )}
    </div>
  );
}

// ─── Dropdown menu ───────────────────────────────────────────────────────────

const menuSurface =
  "z-50 min-w-[11rem] overflow-hidden rounded-lg border border-border bg-surface p-1 shadow-2xl " +
  "data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95";

const menuItem =
  "flex cursor-pointer select-none items-center gap-2 rounded px-2 py-1.5 text-[12px] text-fg outline-none " +
  "data-[highlighted]:bg-surface-2 data-[disabled]:pointer-events-none data-[disabled]:opacity-40";

export const Menu = DropdownMenu.Root;
export const MenuTrigger = DropdownMenu.Trigger;

export function MenuContent({ children, align = "end" }: { children: ReactNode; align?: "start" | "center" | "end" }) {
  return (
    <DropdownMenu.Portal>
      <DropdownMenu.Content align={align} sideOffset={6} className={menuSurface}>
        {children}
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  disabled,
}: {
  children: ReactNode;
  onSelect?: () => void;
  disabled?: boolean;
}) {
  return (
    <DropdownMenu.Item className={menuItem} disabled={disabled} onSelect={() => onSelect?.()}>
      {children}
    </DropdownMenu.Item>
  );
}

export function MenuCheckItem({
  children,
  checked,
  onSelect,
}: {
  children: ReactNode;
  checked: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenu.CheckboxItem
      className={menuItem}
      checked={checked}
      // Keep the menu open so several toggles can be flipped in one visit.
      onSelect={(e) => { e.preventDefault(); onSelect(); }}
    >
      <span className="w-3.5 shrink-0 text-accent">{checked ? "✓" : ""}</span>
      {children}
    </DropdownMenu.CheckboxItem>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return (
    <DropdownMenu.Label className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted">
      {children}
    </DropdownMenu.Label>
  );
}

export function MenuSeparator() {
  return <DropdownMenu.Separator className="my-1 h-px bg-border" />;
}

export function MenuSub({ label, children }: { label: string; children: ReactNode }) {
  return (
    <DropdownMenu.Sub>
      <DropdownMenu.SubTrigger className={cn(menuItem, "justify-between")}>
        {label}
        <ChevronRight size={12} className="text-muted" />
      </DropdownMenu.SubTrigger>
      <DropdownMenu.Portal>
        <DropdownMenu.SubContent className={menuSurface} sideOffset={4}>
          {children}
        </DropdownMenu.SubContent>
      </DropdownMenu.Portal>
    </DropdownMenu.Sub>
  );
}

// ─── Tooltip ─────────────────────────────────────────────────────────────────

export function TooltipProvider({ children }: { children: ReactNode }) {
  return (
    <TooltipPrimitive.Provider delayDuration={350} skipDelayDuration={200}>
      {children}
    </TooltipPrimitive.Provider>
  );
}

/**
 * Icon-only control with an accessible name and a hover hint.
 *
 * Must forward its ref: Radix `asChild` triggers (menus, popovers) clone this
 * component and need the ref and their handlers to reach the real button.
 * Without that a `<MenuTrigger asChild><IconButton/></MenuTrigger>` renders but
 * never opens.
 */
export const IconButton = forwardRef<
  HTMLButtonElement,
  ButtonHTMLAttributes<HTMLButtonElement> & { label: string; active?: boolean }
>(function IconButton({ label, active = false, className, children, ...props }, ref) {
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>
        <button
          ref={ref}
          aria-label={label}
          className={cn(
            "grid h-7 w-7 shrink-0 place-items-center rounded transition-colors",
            "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60",
            "disabled:pointer-events-none disabled:opacity-40",
            active ? "bg-accent/15 text-accent" : "text-muted hover:bg-surface-2 hover:text-fg",
            className,
          )}
          {...props}
        >
          {children}
        </button>
      </TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          sideOffset={6}
          className="z-50 rounded-md border border-border bg-surface px-2 py-1 text-[11px] text-fg shadow-lg"
        >
          {label}
          <TooltipPrimitive.Arrow className="fill-surface" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
});
