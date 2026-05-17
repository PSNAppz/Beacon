import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type AuthKind = "key" | "password" | "agent";

export interface Category {
  id: string;
  name: string;
  created_at: number;
}

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
  category_id: string | null;
  use_ssm: boolean;
  ssm_instance_id: string | null;
  aws_region: string | null;
  aws_profile: string | null;
  aws_access_key_id: string | null;
  has_aws_secret: boolean;
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
  category_id: string | null;
  use_ssm: boolean;
  ssm_instance_id: string | null;
  aws_region: string | null;
  aws_profile: string | null;
  aws_access_key_id: string | null;
  /** Pass null to leave existing unchanged (edit). Pass "" to clear. */
  aws_secret_access_key: string | null;
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

export interface ContainerStats {
  id: string;
  name: string;
  cpu_perc: string;
  mem_usage: string;
  mem_perc: string;
  net_io: string;
  block_io: string;
  pids: string;
}

export interface ImportSessionPreview {
  id: string;
  name: string;
  host: string;
  username: string;
  auth_kind: AuthKind;
  has_secret: boolean;
  has_aws_secret: boolean;
  category_name: string | null;
  conflict: "same_id" | "same_name" | null;
}

export interface ImportPreview {
  sessions: ImportSessionPreview[];
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
  pollDockerStats: (sessionId: string) =>
    invoke<ContainerStats[]>("poll_docker_stats", { sessionId }),
  archiveLogBatch: (sessionId: string, containerId: string, lines: LogLine[]) =>
    invoke<void>("archive_log_batch", { sessionId, containerId, lines }),
  getArchivedLogs: (sessionId: string, containerId: string, limit?: number) =>
    invoke<LogLine[]>("get_archived_logs", { sessionId, containerId, limit }),
  saveLogExport: (path: string, content: string) =>
    invoke<void>("save_log_export", { path, content }),
  changeVaultPassword: (oldPassword: string, newPassword: string) =>
    invoke<void>("change_vault_password", { oldPassword, newPassword }),
  listCategories: () => invoke<Category[]>("list_categories"),
  saveCategory: (id: string | undefined, name: string) =>
    invoke<Category>("save_category", { id: id ?? null, name }),
  deleteCategory: (id: string) => invoke<void>("delete_category", { id }),
  snapshotContainerLogs: (sessionId: string, containerId: string, path: string) =>
    invoke<void>("snapshot_container_logs", { sessionId, containerId, path }),
  exportSessions: (ids: string[], password: string, path: string) =>
    invoke<void>("export_sessions", { ids, password, path }),
  previewImport: (path: string, password: string) =>
    invoke<ImportPreview>("preview_import", { path, password }),
  importSessions: (
    path: string,
    password: string,
    selectedIds: string[],
    conflictStrategy: string,
  ) => invoke<Session[]>("import_sessions", { path, password, selectedIds, conflictStrategy }),
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

// ─── Upgrade flows ────────────────────────────────────────────────────────────

export interface UpgradeFlow {
  id: string;
  session_id: string;
  label: string | null;
  working_directory: string | null;
  steps: string[];
  created_at: number;
  updated_at: number;
}

export interface UpgradeFlowInput {
  id?: string;
  session_id: string;
  label: string | null;
  working_directory: string | null;
  steps: string[];
}

export interface UpgradeStepStart {
  run_id: string;
  step_index: number;
  command: string;
}

export interface UpgradeStepOutput {
  run_id: string;
  step_index: number;
  line: string;
  is_stderr: boolean;
  /** True when the output heuristically looks like a credential prompt. */
  is_prompt: boolean;
}

export interface UpgradeStepDone {
  run_id: string;
  step_index: number;
  exit_code: number;
}

export interface UpgradeComplete {
  run_id: string;
  success: boolean;
}

export const upgradeApi = {
  getFlow: (sessionId: string) =>
    invoke<UpgradeFlow | null>("get_upgrade_flow", { sessionId }),
  saveFlow: (input: UpgradeFlowInput) =>
    invoke<UpgradeFlow>("save_upgrade_flow", { input }),
  deleteFlow: (sessionId: string) =>
    invoke<void>("delete_upgrade_flow", { sessionId }),
  runFlow: (params: {
    sessionId: string;
    steps: string[];
    runId: string;
  }) =>
    invoke<void>("run_upgrade_flow", {
      sessionId: params.sessionId,
      steps: params.steps,
      runId: params.runId,
    }),
  sendInput: (runId: string, text: string) =>
    invoke<void>("send_upgrade_input", { runId, text }),
};

export function onUpgradeStepStart(cb: (e: UpgradeStepStart) => void): Promise<UnlistenFn> {
  return listen<UpgradeStepStart>("upgrade:step-start", (e) => cb(e.payload));
}

export function onUpgradeStepOutput(cb: (e: UpgradeStepOutput) => void): Promise<UnlistenFn> {
  return listen<UpgradeStepOutput>("upgrade:step-output", (e) => cb(e.payload));
}

export function onUpgradeStepDone(cb: (e: UpgradeStepDone) => void): Promise<UnlistenFn> {
  return listen<UpgradeStepDone>("upgrade:step-done", (e) => cb(e.payload));
}

export function onUpgradeComplete(cb: (e: UpgradeComplete) => void): Promise<UnlistenFn> {
  return listen<UpgradeComplete>("upgrade:complete", (e) => cb(e.payload));
}

// ─── S3 log backup ────────────────────────────────────────────────────────────

export interface S3ConfigPublic {
  bucket: string;
  region: string;
  aws_access_key_id: string;
  has_secret: boolean;
}

export interface S3ConfigInput {
  bucket: string;
  region: string;
  aws_access_key_id: string;
  /** Plaintext secret. Pass null to keep existing value. */
  aws_secret_key: string | null;
}

export const s3Api = {
  getConfig: () => invoke<S3ConfigPublic | null>("get_s3_config"),
  saveConfig: (input: S3ConfigInput) =>
    invoke<S3ConfigPublic>("save_s3_config", { input }),
  deleteConfig: () => invoke<void>("delete_s3_config"),
  uploadLogs: (sessionId: string, containerId: string, containerName: string) =>
    invoke<string>("upload_container_logs_to_s3", {
      sessionId,
      containerId,
      containerName,
    }),
};

