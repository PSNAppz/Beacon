import React, { useEffect, useState } from "react";
import { getVersion } from "@tauri-apps/api/app";
import { api, errorMessage } from "../lib/ipc";
import { useApp } from "../lib/store";
import { Button, ConfirmDialog, Field, Input } from "../components/ui";
import { S3ConfigForm } from "../features/s3/S3ConfigForm";
import { usePrefs } from "../lib/prefsStore";
import { useUpdater } from "../lib/updaterStore";

function ToggleRow({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint: string;
  value: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-sm font-medium">{label}</div>
        <div className="mt-0.5 text-[12px] text-muted">{hint}</div>
      </div>
      <button
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        className={`relative h-6 w-11 shrink-0 rounded-full transition-colors focus:outline-none ${
          value ? "bg-fg" : "bg-surface-2 border border-border"
        }`}
      >
        <span
          className={`absolute top-1 h-4 w-4 rounded-full shadow transition-transform ${
            value ? "translate-x-6 bg-bg" : "translate-x-1 bg-muted"
          }`}
        />
      </button>
    </div>
  );
}

export function SettingsPage() {
  const categories = useApp((s) => s.categories);
  const upsertCatLocal = useApp((s) => s.upsertCategoryLocal);
  const removeCatLocal = useApp((s) => s.removeCategoryLocal);
  const passwordRemembered = useApp((s) => s.passwordRemembered);
  const setPasswordRemembered = useApp((s) => s.setPasswordRemembered);
  const dotGrid = usePrefs((s) => s.dotGrid);
  const setDotGrid = usePrefs((s) => s.setDotGrid);

  // ── Updates ──────────────────────────────────────────────────────────────────
  const upd = useUpdater();
  const [appVersion, setAppVersion] = useState("");
  useEffect(() => { getVersion().then(setAppVersion).catch(() => {}); }, []);

  // ── Categories ───────────────────────────────────────────────────────────────
  const [newCatName, setNewCatName] = useState("");
  const [catBusy, setCatBusy] = useState(false);
  const [catErr, setCatErr] = useState("");

  async function addCategory() {
    const name = newCatName.trim();
    if (!name) return;
    setCatBusy(true);
    setCatErr("");
    try {
      const cat = await api.saveCategory(undefined, name);
      upsertCatLocal(cat);
      setNewCatName("");
    } catch (e) {
      setCatErr(errorMessage(e));
    } finally {
      setCatBusy(false);
    }
  }

  const [pendingCat, setPendingCat] = useState<{ id: string; name: string } | null>(null);

  function deleteCategory(id: string, name: string) {
    setPendingCat({ id, name });
  }

  async function confirmDeleteCategory() {
    const cat = pendingCat;
    if (!cat) return;
    setPendingCat(null);
    try {
      await api.deleteCategory(cat.id);
      removeCatLocal(cat.id);
    } catch (e) {
      setCatErr(errorMessage(e));
    }
  }

  // ── Notifications ────────────────────────────────────────────────────────────
  const [notificationsEnabled, setNotificationsEnabled] = useState(() => {
    return localStorage.getItem("beacon:settings:notificationsEnabled") !== "false";
  });

  function toggleNotifications(val: boolean) {
    setNotificationsEnabled(val);
    localStorage.setItem("beacon:settings:notificationsEnabled", String(val));
    if (val && "Notification" in window && Notification.permission === "default") {
      Notification.requestPermission().catch(() => {});
    }
  }

  // ── Vault password change ────────────────────────────────────────────────────
  const [oldPw, setOldPw] = useState("");
  const [newPw, setNewPw] = useState("");
  const [confirmPw, setConfirmPw] = useState("");
  const [pwStatus, setPwStatus] = useState<"idle" | "saving" | "ok" | "error">("idle");
  const [pwError, setPwError] = useState("");

  async function handleChangePassword(e: React.FormEvent) {
    e.preventDefault();
    setPwError("");
    if (newPw.length < 4) {
      setPwError("New password must be at least 4 characters.");
      return;
    }
    if (newPw !== confirmPw) {
      setPwError("New passwords do not match.");
      return;
    }
    setPwStatus("saving");
    try {
      await api.changeVaultPassword(oldPw, newPw);
      // Keep the remembered copy in step, otherwise auto-unlock breaks on next launch.
      if (useApp.getState().passwordRemembered) {
        await api.vaultRememberPassword(newPw).catch(() => {
          useApp.getState().setPasswordRemembered(false);
        });
      }
      setPwStatus("ok");
      setOldPw("");
      setNewPw("");
      setConfirmPw("");
    } catch (err) {
      setPwError(errorMessage(err));
      setPwStatus("error");
    }
  }

  return (
    <div className="h-full overflow-y-auto px-8 py-8">
      <div className="mx-auto max-w-2xl space-y-10">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Settings</h1>
          <p className="mt-1 text-sm text-muted">App preferences and vault configuration.</p>
        </div>

        {/* ── Categories section ── */}
        <section className="space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Session categories</h2>
          <div className="rounded-lg border border-border bg-surface/70 backdrop-blur-sm px-5 py-4 space-y-3">
            {categories.length === 0 ? (
              <p className="text-[12px] text-muted">No categories yet. Add one below.</p>
            ) : (
              <ul className="space-y-1">
                {categories.map((cat) => (
                  <li key={cat.id} className="flex items-center justify-between rounded px-2 py-1.5 hover:bg-surface-2">
                    <span className="text-sm">{cat.name}</span>
                    <button
                      onClick={() => deleteCategory(cat.id, cat.name)}
                      className="text-[11px] text-muted hover:text-danger"
                      title="Delete category"
                    >
                      ✕
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <div className="flex gap-2 pt-1">
              <Input
                value={newCatName}
                onChange={(e) => setNewCatName(e.target.value)}
                onKeyDown={(e) => { if (e.key === "Enter") addCategory(); }}
                placeholder="New category name…"
                className="flex-1 text-sm"
              />
              <Button variant="primary" onClick={addCategory} disabled={catBusy || !newCatName.trim()}>
                {catBusy ? "Adding…" : "Add"}
              </Button>
            </div>
            {catErr && (
              <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">{catErr}</div>
            )}
          </div>
        </section>

        {/* ── Alerts section ── */}
        <section className="space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Alerts</h2>
          <div className="rounded-lg border border-border bg-surface/70 backdrop-blur-sm px-4 py-3">
            <ToggleRow
              label="Desktop notifications"
              hint="Show a system notification when an alert rule matches a log line."
              value={notificationsEnabled}
              onChange={toggleNotifications}
            />
          </div>
        </section>

        {/* ── Updates section ── */}
        <section className="space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Updates</h2>
          <div className="rounded-lg border border-border bg-surface/70 backdrop-blur-sm px-5 py-4">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <div className="text-sm font-medium">
                  {upd.status === "checking" && "Checking for updates…"}
                  {upd.status === "available" && `Version ${upd.version} is available`}
                  {upd.status === "downloading" &&
                    `Downloading${upd.progress !== null ? ` — ${upd.progress}%` : "…"}`}
                  {upd.status === "ready" && "Update installed"}
                  {upd.status === "uptodate" && "Beacon is up to date"}
                  {upd.status === "error" && "Could not check for updates"}
                  {upd.status === "idle" && appVersion ? `Beacon ${appVersion}` : "Beacon"}
                </div>
                <div className="mt-0.5 text-[12px] text-muted">
                  {upd.status === "ready"
                    ? "Restart to finish."
                    : upd.status === "error"
                    ? upd.error
                    : upd.lastChecked
                    ? `Last checked ${new Date(upd.lastChecked).toLocaleString()}`
                    : "Updates are downloaded from GitHub releases and verified before install."}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                {upd.status === "available" && (
                  <Button variant="primary" onClick={() => upd.downloadAndInstall()}>
                    Download &amp; install
                  </Button>
                )}
                {upd.status === "ready" ? (
                  <Button variant="primary" onClick={() => upd.restart()}>Restart now</Button>
                ) : (
                  <Button
                    variant="ghost"
                    onClick={() => upd.checkNow()}
                    disabled={upd.status === "checking" || upd.status === "downloading"}
                  >
                    {upd.status === "checking" ? "Checking…" : "Check now"}
                  </Button>
                )}
              </div>
            </div>

            {upd.status === "downloading" && upd.progress !== null && (
              <div className="mt-3 h-1 w-full overflow-hidden rounded-full bg-surface-2">
                <div className="h-full bg-fg transition-all" style={{ width: `${upd.progress}%` }} />
              </div>
            )}

            {upd.notes && (upd.status === "available" || upd.status === "ready") && (
              <pre className="mt-3 max-h-32 overflow-auto whitespace-pre-wrap rounded border border-border bg-surface-2 px-3 py-2 text-[12px] text-muted">
                {upd.notes}
              </pre>
            )}

            <div className="mt-4 space-y-3 border-t border-border pt-3">
              <ToggleRow
                label="Check automatically"
                hint="Looks for a new release on launch, then every 6 hours."
                value={upd.autoCheck}
                onChange={upd.setAutoCheck}
              />
              <ToggleRow
                label="Install automatically"
                hint="Downloads and installs without asking. You still choose when to restart."
                value={upd.autoInstall}
                onChange={upd.setAutoInstall}
              />
            </div>
          </div>
        </section>

        {/* ── Appearance section ── */}
        <section className="space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Appearance</h2>
          <div className="rounded-lg border border-border bg-surface/70 backdrop-blur-sm px-4 py-3">
            <ToggleRow
              label="Animated background"
              hint="Interactive dot grid behind the UI. Idle frames are skipped, but turn it off to drop the canvas entirely."
              value={dotGrid}
              onChange={setDotGrid}
            />
          </div>
        </section>

        {/* ── Vault section ── */}
        <section className="space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Vault</h2>
          <div className="mb-3 flex items-center justify-between rounded-lg border border-border bg-surface/70 backdrop-blur-sm px-5 py-4">
            <div className="min-w-0 pr-4">
              <h3 className="text-sm font-semibold">Remembered password</h3>
              <p className="mt-0.5 text-[12px] text-muted">
                {passwordRemembered
                  ? "Beacon unlocks automatically on launch using the password saved in your OS credential store."
                  : "Not saved. Tick “Remember this password” on the unlock screen to enable auto-unlock."}
              </p>
            </div>
            {passwordRemembered && (
              <Button
                variant="ghost"
                className="shrink-0 text-danger"
                onClick={async () => {
                  await api.vaultForgetPassword().catch(() => {});
                  setPasswordRemembered(false);
                }}
              >
                Forget
              </Button>
            )}
          </div>

          <div className="rounded-lg border border-border bg-surface/70 backdrop-blur-sm px-5 py-5">
            <h3 className="mb-4 text-sm font-semibold">Change master password</h3>
            <form onSubmit={handleChangePassword} className="space-y-4">
              <Field label="Current password">
                <Input
                  type="password"
                  value={oldPw}
                  onChange={(e) => { setOldPw(e.target.value); setPwStatus("idle"); }}
                  placeholder="••••••••"
                  autoComplete="current-password"
                />
              </Field>
              <Field label="New password">
                <Input
                  type="password"
                  value={newPw}
                  onChange={(e) => { setNewPw(e.target.value); setPwStatus("idle"); }}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
              </Field>
              <Field label="Confirm new password">
                <Input
                  type="password"
                  value={confirmPw}
                  onChange={(e) => { setConfirmPw(e.target.value); setPwStatus("idle"); }}
                  placeholder="••••••••"
                  autoComplete="new-password"
                />
              </Field>

              {pwError && (
                <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
                  {pwError}
                </div>
              )}
              {pwStatus === "ok" && (
                <div className="rounded border border-ok/30 bg-ok/10 px-3 py-2 text-[12px] text-ok">
                  Password changed successfully.
                </div>
              )}

              <div className="flex justify-end pt-1">
                <Button
                  type="submit"
                  variant="primary"
                  disabled={pwStatus === "saving" || !oldPw || !newPw || !confirmPw}
                >
                  {pwStatus === "saving" ? "Changing…" : "Change password"}
                </Button>
              </div>
            </form>
          </div>
        </section>

        {/* ── S3 Log Backup section ── */}
        <section className="space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">S3 Log Backup</h2>
          <div className="rounded-lg border border-border bg-surface/70 backdrop-blur-sm px-5 py-5">
            <S3ConfigForm />
          </div>
        </section>

        {/* ── Log archive section ── */}
        <section className="space-y-3">
          <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted">Log archive</h2>
          <div className="rounded-lg border border-border bg-surface/70 backdrop-blur-sm px-4 py-3 text-sm">
            <div className="flex items-center justify-between py-1">
              <span className="text-muted">Max lines per container</span>
              <span className="font-mono text-fg">50 000</span>
            </div>
            <div className="flex items-center justify-between py-1">
              <span className="text-muted">Archive flush interval</span>
              <span className="font-mono text-fg">5 s</span>
            </div>
            <div className="mt-2 text-[11px] text-muted">
              Archive is stored at{" "}
              <span className="font-mono">
                %LOCALAPPDATA%\Beacon\archive.db
              </span>{" "}
              (Windows) or{" "}
              <span className="font-mono">~/.local/share/Beacon/archive.db</span>{" "}
              (Linux / macOS).
            </div>
          </div>
        </section>
      </div>

      <ConfirmDialog
        open={pendingCat !== null}
        onOpenChange={(o) => { if (!o) setPendingCat(null); }}
        title={`Delete category "${pendingCat?.name ?? ""}"?`}
        body="Sessions in this category become uncategorised. No session is deleted."
        confirmLabel="Delete category"
        destructive
        onConfirm={confirmDeleteCategory}
      />
    </div>
  );
}
