import { FormEvent, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { api, AuthKind, errorMessage, Session, SessionInput } from "../../lib/ipc";
import { useApp } from "../../lib/store";
import { Button, Field, Input, Modal, Select } from "../../components/ui";

interface Props {
  open: boolean;
  onClose: () => void;
  editing?: Session | null;
}

const DEFAULT_COLORS = ["#78c8ff", "#9ee493", "#ffc45a", "#ff8a8a", "#c89cff", "#7ee0d8"];

export function SessionWizard({ open: isOpen, onClose, editing }: Props) {
  const sessions = useApp((s) => s.sessions);
  const upsertLocal = useApp((s) => s.upsertSessionLocal);

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [port, setPort] = useState(22);
  const [username, setUsername] = useState("");
  const [authKind, setAuthKind] = useState<AuthKind>("key");
  const [keyPath, setKeyPath] = useState<string>("");
  const [secret, setSecret] = useState<string>("");
  const [jumpId, setJumpId] = useState<string>("");
  const [color, setColor] = useState(DEFAULT_COLORS[0]);
  const [readOnly, setReadOnly] = useState(false);
  const [useSudo, setUseSudo] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    if (editing) {
      setName(editing.name);
      setHost(editing.host);
      setPort(editing.port);
      setUsername(editing.username);
      setAuthKind(editing.auth_kind);
      setKeyPath(editing.key_path ?? "");
      setSecret("");
      setJumpId(editing.jump_session_id ?? "");
      setColor(editing.color);
      setReadOnly(editing.read_only);
      setUseSudo(editing.use_sudo);
    } else {
      setName(""); setHost(""); setPort(22); setUsername("");
      setAuthKind("key"); setKeyPath(""); setSecret(""); setJumpId("");
      setColor(DEFAULT_COLORS[0]); setReadOnly(false); setUseSudo(false);
    }
    setErr(null);
  }, [isOpen, editing]);

  async function pickKey() {
    const selected = await open({
      multiple: false,
      title: "Choose private key (.pem / OpenSSH)",
      filters: [{ name: "Keys", extensions: ["pem", "key", "ppk", "*"] }],
    });
    if (typeof selected === "string") setKeyPath(selected);
  }

  async function onSubmit(e: FormEvent) {
    e.preventDefault();
    setErr(null);
    if (!name || !host || !username) { setErr("Name, host, and username are required."); return; }
    if (authKind === "key" && !keyPath) { setErr("Pick a private key file."); return; }
    if (authKind === "password" && !editing && !secret) { setErr("Password is required."); return; }

    const input: SessionInput = {
      id: editing?.id,
      name, host, port, username,
      auth_kind: authKind,
      key_path: authKind === "key" ? keyPath : null,
      // Edit & secret unchanged → null; otherwise pass the typed value (may be "").
      secret_plain: editing && !secret ? null : secret,
      jump_session_id: jumpId || null,
      color,
      read_only: readOnly,
      use_sudo: useSudo,
    };

    setBusy(true);
    try {
      const saved = await api.saveSession(input);
      upsertLocal(saved);
      onClose();
    } catch (e) {
      setErr(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal
      open={isOpen}
      onClose={onClose}
      title={editing ? "Edit session" : "New session"}
      footer={
        <>
          <Button type="button" variant="ghost" onClick={onClose}>Cancel</Button>
          <Button type="submit" variant="primary" form="session-form" disabled={busy}>
            {busy ? "Saving…" : editing ? "Save" : "Create"}
          </Button>
        </>
      }
    >
      <form id="session-form" onSubmit={onSubmit} className="space-y-4">
        <div className="grid grid-cols-2 gap-4">
          <Field label="Name"><Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Prod API" autoFocus /></Field>
          <Field label="Color">
            <div className="flex items-center gap-2">
              {DEFAULT_COLORS.map((c) => (
                <button type="button" key={c}
                  onClick={() => setColor(c)}
                  className={`h-7 w-7 rounded-full border-2 transition ${c === color ? "border-fg" : "border-transparent"}`}
                  style={{ background: c }}
                  aria-label={c}
                />
              ))}
            </div>
          </Field>
        </div>

        <div className="grid grid-cols-[1fr_120px] gap-4">
          <Field label="Host"><Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="ec2-1-2-3-4.compute.amazonaws.com" /></Field>
          <Field label="Port"><Input type="number" value={port} onChange={(e) => setPort(Number(e.target.value) || 22)} /></Field>
        </div>

        <Field label="Username"><Input value={username} onChange={(e) => setUsername(e.target.value)} placeholder="ubuntu / ec2-user" /></Field>

        <Field label="Authentication">
          <Select value={authKind} onChange={(e) => setAuthKind(e.target.value as AuthKind)}>
            <option value="key">Private key (PEM / OpenSSH)</option>
            <option value="password">Password</option>
            <option value="agent" disabled>SSH agent (coming soon)</option>
          </Select>
        </Field>

        {authKind === "key" && (
          <>
            <Field label="Key file">
              <div className="flex gap-2">
                <Input value={keyPath} onChange={(e) => setKeyPath(e.target.value)} placeholder="C:\Users\you\.ssh\id_ed25519" />
                <Button type="button" onClick={pickKey}>Browse…</Button>
              </div>
            </Field>
            <Field label="Key passphrase" hint={editing ? "leave blank to keep existing" : "optional"}>
              <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="••••••••" autoComplete="off" />
            </Field>
          </>
        )}

        {authKind === "password" && (
          <Field label="Password" hint={editing ? "leave blank to keep existing" : undefined}>
            <Input type="password" value={secret} onChange={(e) => setSecret(e.target.value)} placeholder="••••••••" autoComplete="off" />
          </Field>
        )}

        <Field label="Jump host (ProxyJump)" hint="optional">
          <Select value={jumpId} onChange={(e) => setJumpId(e.target.value)}>
            <option value="">— none —</option>
            {sessions
              .filter((s) => s.id !== editing?.id)
              .map((s) => (
                <option key={s.id} value={s.id}>{s.name} ({s.username}@{s.host})</option>
              ))}
          </Select>
        </Field>

        <label className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
          <input type="checkbox" checked={readOnly} onChange={(e) => setReadOnly(e.target.checked)} className="h-4 w-4 accent-accent" />
          <div>
            <div className="text-sm font-medium">Read-only session</div>
            <div className="text-xs text-muted">Disables container restart/stop and shell exec. Recommended for production.</div>
          </div>
        </label>

        <label className="flex items-center gap-3 rounded-lg border border-border bg-surface-2 px-3 py-2">
          <input type="checkbox" checked={useSudo} onChange={(e) => setUseSudo(e.target.checked)} className="h-4 w-4 accent-accent" />
          <div>
            <div className="text-sm font-medium">Run commands via sudo</div>
            <div className="text-xs text-muted">
              Wraps Beacon's docker invocations in <code className="font-mono text-fg">sudo -n</code>.
              Use when the SSH user isn't in the <code className="font-mono text-fg">docker</code> group.
              Requires passwordless sudo for this user (standard on EC2 Ubuntu images).
            </div>
          </div>
        </label>

        {err && <div className="rounded-lg border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">{err}</div>}
      </form>
    </Modal>
  );
}
