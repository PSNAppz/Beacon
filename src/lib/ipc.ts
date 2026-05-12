import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AuthKind = "key" | "password" | "agent";

export interface Session {
  id: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_kind: AuthKind;
  key_path: string | null;
  has_secret: boolean;
  jump_session_id: string | null;
  color: string;
  read_only: boolean;
  use_sudo: boolean;
  last_connected: number | null;
  created_at: number;
  updated_at: number;
}

export interface SessionInput {
  id?: string;
  name: string;
  host: string;
  port: number;
  username: string;
  auth_kind: AuthKind;
  key_path: string | null;
  /** Pass null to leave existing secret unchanged (edit). Pass "" to clear. */
  secret_plain: string | null;
  jump_session_id: string | null;
  color: string;
  read_only: boolean;
  use_sudo: boolean;
}

export interface SshTestResult {
  ok: boolean;
  message: string;
  remote_user: string | null;
  remote_uname: string | null;
}

export interface Container {
  id: string;
  name: string;
  all_names: string[];
  image: string;
  command: string;
  state: string;
  status: string;
  ports: string;
  created_at: string;
}

export interface LogLine {
  ts: string | null;
  text: string;
  stderr: boolean;
}

export interface LogBatch {
  stream_id: string;
  lines: LogLine[];
}

export interface LogEnd {
  stream_id: string;
  reason: string;
}

export const api = {
  vaultIsInitialized: () => invoke<boolean>("vault_is_initialized"),
  vaultIsUnlocked: () => invoke<boolean>("vault_is_unlocked"),
  vaultCreate: (password: string) => invoke<void>("vault_create", { password }),
  vaultUnlock: (password: string) => invoke<void>("vault_unlock", { password }),
  vaultLock: () => invoke<void>("vault_lock"),
  listSessions: () => invoke<Session[]>("list_sessions"),
  saveSession: (input: SessionInput) => invoke<Session>("save_session", { input }),
  deleteSession: (id: string) => invoke<void>("delete_session", { id }),
  testSession: (id: string) => invoke<SshTestResult>("test_session", { id }),
  connectSession: (id: string) => invoke<void>("connect_session", { id }),
  disconnectSession: (id: string) => invoke<void>("disconnect_session", { id }),
  isSessionConnected: (id: string) => invoke<boolean>("is_session_connected", { id }),
  listContainers: (id: string) => invoke<Container[]>("list_containers", { id }),
  startLogStream: (sessionId: string, containerId: string, tail = 500) =>
    invoke<string>("start_log_stream", { sessionId, containerId, tail }),
  stopLogStream: (streamId: string) => invoke<void>("stop_log_stream", { streamId }),
  runRemoteCommand: (id: string, command: string) =>
    invoke<RemoteCmdResult>("run_remote_command", { id, command }),
};

export interface RemoteCmdResult {
  stdout: string;
  stderr: string;
  exit: number | null;
  truncated: boolean;
}

export interface DiagCommand {
  source: string;
  command: string;
  stdout: string;
  stderr: string;
  exit: number | null;
}

export function onDiagCommand(cb: (d: DiagCommand) => void): Promise<UnlistenFn> {
  return listen<DiagCommand>("diag:command", (e) => cb(e.payload));
}

export function onLogBatch(cb: (b: LogBatch) => void): Promise<UnlistenFn> {
  return listen<LogBatch>("log:batch", (e) => cb(e.payload));
}

export function onLogEnd(cb: (e: LogEnd) => void): Promise<UnlistenFn> {
  return listen<LogEnd>("log:end", (e) => cb(e.payload));
}

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as { message: unknown }).message);
  return String(e);
}
