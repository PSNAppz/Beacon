import { useState } from "react";
import { s3Api, S3ConfigInput, errorMessage } from "../../lib/ipc";
import { useApp } from "../../lib/store";
import { Button, ConfirmDialog, Field, Input } from "../../components/ui";

export function S3ConfigForm() {
  const s3Config = useApp((s) => s.s3Config);
  const setS3Config = useApp((s) => s.setS3Config);

  const [bucket, setBucket] = useState(s3Config?.bucket ?? "");
  const [region, setRegion] = useState(s3Config?.region ?? "");
  const [keyId, setKeyId] = useState(s3Config?.aws_access_key_id ?? "");
  const [secretKey, setSecretKey] = useState("");

  const [status, setStatus] = useState<"idle" | "saving" | "deleting" | "ok" | "error">("idle");
  const [error, setError] = useState("");
  const [pendingRemove, setPendingRemove] = useState(false);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setError("");

    if (!bucket.trim()) { setError("Bucket name is required."); return; }
    if (!region.trim()) { setError("Region is required."); return; }
    if (!keyId.trim()) { setError("Access Key ID is required."); return; }
    if (!s3Config && !secretKey.trim()) {
      setError("Secret Access Key is required for first-time setup.");
      return;
    }

    setStatus("saving");
    try {
      const input: S3ConfigInput = {
        bucket: bucket.trim(),
        region: region.trim(),
        aws_access_key_id: keyId.trim(),
        aws_secret_key: secretKey.trim() || null,
      };
      const saved = await s3Api.saveConfig(input);
      setS3Config(saved);
      setSecretKey("");
      setStatus("ok");
    } catch (e) {
      setError(errorMessage(e));
      setStatus("error");
    }
  }

  async function handleDelete() {
    setPendingRemove(false);
    setStatus("deleting");
    try {
      await s3Api.deleteConfig();
      setS3Config(null);
      setBucket("");
      setRegion("");
      setKeyId("");
      setSecretKey("");
      setStatus("idle");
    } catch (e) {
      setError(errorMessage(e));
      setStatus("error");
    }
  }

  return (
    <form onSubmit={handleSave} className="space-y-4">
      <div className="text-[12px] text-muted mb-2">
        Logs are uploaded to{" "}
        <span className="font-mono">s3://bucket/session-name/container-name/timestamp.log</span>{" "}
        before each upgrade flow runs.
      </div>

      <Field label="S3 Bucket Name">
        <Input
          value={bucket}
          onChange={(e) => { setBucket(e.target.value); setStatus("idle"); }}
          placeholder="my-log-bucket"
        />
      </Field>

      <Field label="AWS Region">
        <Input
          value={region}
          onChange={(e) => { setRegion(e.target.value); setStatus("idle"); }}
          placeholder="us-east-1"
        />
      </Field>

      <Field label="AWS Access Key ID">
        <Input
          value={keyId}
          onChange={(e) => { setKeyId(e.target.value); setStatus("idle"); }}
          placeholder="AKIAIOSFODNN7EXAMPLE"
          spellCheck={false}
        />
      </Field>

      <Field label={s3Config?.has_secret ? "AWS Secret Access Key (leave blank to keep current)" : "AWS Secret Access Key"}>
        <Input
          type="password"
          value={secretKey}
          onChange={(e) => { setSecretKey(e.target.value); setStatus("idle"); }}
          placeholder={s3Config?.has_secret ? "••••••••  (saved)" : "••••••••"}
          autoComplete="off"
        />
      </Field>

      {error && (
        <div className="rounded border border-danger/30 bg-danger/10 px-3 py-2 text-[12px] text-danger">
          {error}
        </div>
      )}
      {status === "ok" && (
        <div className="rounded border border-ok/30 bg-ok/10 px-3 py-2 text-[12px] text-ok">
          S3 configuration saved.
        </div>
      )}

      <div className="flex items-center justify-between pt-1">
        {s3Config ? (
          <button
            type="button"
            onClick={() => setPendingRemove(true)}
            disabled={status === "deleting" || status === "saving"}
            className="text-[12px] text-danger hover:underline disabled:opacity-40"
          >
            {status === "deleting" ? "Removing…" : "Remove S3 config"}
          </button>
        ) : (
          <span />
        )}
        <Button
          type="submit"
          variant="primary"
          disabled={status === "saving" || status === "deleting"}
        >
          {status === "saving" ? "Saving…" : "Save"}
        </Button>
      </div>

      <ConfirmDialog
        open={pendingRemove}
        onOpenChange={setPendingRemove}
        title="Remove S3 configuration?"
        body="Log backups to S3 will be disabled. Logs already uploaded are not deleted."
        confirmLabel="Remove"
        destructive
        onConfirm={handleDelete}
      />
    </form>
  );
}
