import { FormEvent, useState } from "react";
import { api, errorMessage } from "../lib/ipc";
import { useApp } from "../lib/store";
import { Button, Field, Input } from "../components/ui";

export function LockScreen({ mode }: { mode: "create" | "unlock" }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const setUnlocked = useApp((s) => s.setUnlocked);

  const isCreate = mode === "create";

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (isCreate && pw !== pw2) { setErr("Passwords don't match."); return; }
    if (pw.length < 8) { setErr("Use at least 8 characters."); return; }
    setBusy(true);
    try {
      if (isCreate) await api.vaultCreate(pw);
      else await api.vaultUnlock(pw);
      await setUnlocked();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center bg-bg px-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-5 rounded-2xl border border-border bg-surface p-6">
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wider text-accent">Beacon</div>
          <h1 className="text-xl font-semibold">{isCreate ? "Create master password" : "Unlock vault"}</h1>
          <p className="text-sm text-muted">
            {isCreate
              ? "This protects your saved sessions and key passphrases. We can't recover it if you forget it."
              : "Enter your master password to decrypt saved sessions."}
          </p>
        </div>

        <Field label="Master password">
          <Input
            type="password"
            autoFocus
            value={pw}
            onChange={(e) => setPw(e.target.value)}
            placeholder="••••••••"
            autoComplete={isCreate ? "new-password" : "current-password"}
          />
        </Field>

        {isCreate && (
          <Field label="Confirm">
            <Input
              type="password"
              value={pw2}
              onChange={(e) => setPw2(e.target.value)}
              placeholder="••••••••"
              autoComplete="new-password"
            />
          </Field>
        )}

        {err && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{err}</div>}

        <Button type="submit" variant="primary" disabled={busy} className="w-full">
          {busy ? "Working…" : isCreate ? "Create vault" : "Unlock"}
        </Button>
      </form>
    </div>
  );
}
