use crate::error::{AppError, AppResult};
use crate::storage::S3Config;
use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use tauri::{AppHandle, Emitter};

#[derive(serde::Serialize, Clone)]
struct DiagPayload {
    source: String,
    command: String,
    stdout: String,
    stderr: String,
    exit: Option<u32>,
}

/// Upload `log_content` to S3.
///
/// Key format: `{session}/{container}/{start_ts}_to_{until}-{container_id[:12]}.log`
///
/// Returns the S3 key that was written.
/// Emits `diag:command` events so the console pane shows progress and errors.
pub async fn upload_logs(
    app: AppHandle,
    config: &S3Config,
    session_name: &str,
    container_name: &str,
    start_ts: &str,
    end_ts: &str,
    log_content: String,
) -> AppResult<String> {
    let creds = Credentials::new(
        &config.aws_access_key_id,
        &config.aws_secret,
        None,
        None,
        "beacon",
    );
    let s3_cfg = aws_sdk_s3::Config::builder()
        .credentials_provider(creds)
        .region(Region::new(config.region.clone()))
        .behavior_version(BehaviorVersion::latest())
        .build();
    let client = Client::from_conf(s3_cfg);

    let key = format!(
        "{}/{}/{}_to_{}.log",
        sanitize_s3_segment(session_name),
        sanitize_s3_segment(container_name),
        sanitize_ts(start_ts),
        sanitize_ts(end_ts),
    );

    let cmd_label = format!("PUT s3://{}/{}", config.bucket, key);

    let result = client
        .put_object()
        .bucket(&config.bucket)
        .key(&key)
        .content_type("text/plain; charset=utf-8")
        .body(ByteStream::from(log_content.into_bytes()))
        .send()
        .await;

    match result {
        Ok(_) => {
            let _ = app.emit(
                "diag:command",
                DiagPayload {
                    source: "s3_backup".into(),
                    command: cmd_label,
                    stdout: format!("Uploaded → {key}"),
                    stderr: String::new(),
                    exit: Some(0),
                },
            );
            Ok(key)
        }
        Err(e) => {
            // Walk the full error chain so "service error" reveals the real AWS code.
            use std::error::Error;
            let mut parts = vec![e.to_string()];
            let mut src: &dyn Error = &e;
            while let Some(next) = src.source() {
                let s = next.to_string();
                if !parts.contains(&s) {
                    parts.push(s);
                }
                src = next;
            }
            let detail = parts.join(" → ");
            let _ = app.emit(
                "diag:command",
                DiagPayload {
                    source: "s3_backup".into(),
                    command: cmd_label,
                    stdout: String::new(),
                    stderr: detail.clone(),
                    exit: Some(1),
                },
            );
            Err(AppError::Other(format!("S3 upload failed: {detail}")))
        }
    }
}

/// Convert an RFC3339 timestamp into a filename-safe label by replacing `:` with `-`
/// and stripping sub-second precision (everything after the seconds digit before `Z`).
/// e.g. `2026-05-14T10:30:45.123456789Z` → `2026-05-14T10-30-45Z`
fn sanitize_ts(ts: &str) -> String {
    // Truncate at the first `.` or keep as-is if no fractional seconds.
    let trimmed = ts.split('.').next().unwrap_or(ts);
    // Re-attach trailing Z if the original had it and we stripped it.
    let with_z = if ts.ends_with('Z') && !trimmed.ends_with('Z') {
        format!("{trimmed}Z")
    } else {
        trimmed.to_string()
    };
    with_z.replace(':', "-")
}

/// Replace characters that are not safe in an S3 key segment with `-`.
fn sanitize_s3_segment(s: &str) -> String {
    let sanitized: String = s
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.') {
                c
            } else {
                '-'
            }
        })
        .collect();
    sanitized.trim_matches('-').to_string()
}
