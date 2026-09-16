import { FormEvent, useEffect, useState } from "react";
import { api, errorMessage } from "../lib/ipc";
import { useApp } from "../lib/store";
import { Button, Field, Input } from "../components/ui";

function osKeystoreName(): string {
  const ua = navigator.userAgent;
  if (/Mac|iPhone|iPad/.test(ua)) return "macOS Keychain";
  if (/Windows/.test(ua)) return "Windows Credential Manager";
  return "system keyring";
}

export function LockScreen({ mode }: { mode: "create" | "unlock" }) {
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const setUnlocked = useApp((s) => s.setUnlocked);
  const passwordRemembered = useApp((s) => s.passwordRemembered);
  const setPasswordRemembered = useApp((s) => s.setPasswordRemembered);
  const [remember, setRemember] = useState(passwordRemembered);

  const isCreate = mode === "create";

  // The remembered flag resolves during bootstrap, after first paint.
  useEffect(() => { setRemember(passwordRemembered); }, [passwordRemembered]);

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (isCreate && pw !== pw2) { setErr("Passwords don't match."); return; }
    if (pw.length < 8) { setErr("Use at least 8 characters."); return; }
    setBusy(true);
    try {
      if (isCreate) await api.vaultCreate(pw);
      else await api.vaultUnlock(pw);
      // Save or drop the stored copy only once the password is known good.
      try {
        if (remember) await api.vaultRememberPassword(pw);
        else await api.vaultForgetPassword();
        setPasswordRemembered(remember);
      } catch {
        // No usable OS credential store — unlock still succeeded.
        setPasswordRemembered(false);
      }
      await setUnlocked();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="grid h-full place-items-center px-6">
      <form onSubmit={onSubmit} className="w-full max-w-sm space-y-5 rounded-2xl border border-border bg-surface/80 p-6 shadow-2xl backdrop-blur-xl">
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

        <label className="flex cursor-pointer items-center gap-2.5 text-sm text-muted">
          <input
            type="checkbox"
            checked={remember}
            onChange={(e) => setRemember(e.target.checked)}
            className="h-4 w-4 shrink-0 cursor-pointer rounded border-border bg-surface-2 accent-accent"
          />
          <span>Remember this password</span>
        </label>
        <p className="-mt-3 text-[11px] leading-snug text-muted/80">
          Stored in your {osKeystoreName()} and used to unlock Beacon automatically on launch.
        </p>

        {err && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{err}</div>}

        <Button type="submit" variant="primary" disabled={busy} className="w-full">
          {busy ? "Working…" : isCreate ? "Create vault" : "Unlock"}
        </Button>
      </form>
    </div>
  );
}
