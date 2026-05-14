use crate::error::{AppError, AppResult};
use crate::storage::S3Config;
use aws_sdk_s3::config::{BehaviorVersion, Credentials, Region};
use aws_sdk_s3::primitives::ByteStream;
use aws_sdk_s3::Client;
use chrono::Utc;
use tauri::{AppHandle, Emitter};

#[derive(serde::Serialize, Clone)]
struct DiagPayload {
    source: String,
    command: String,
    stdout: String,
    stderr: String,
    exit: Option<u32>,
}

/// Upload `log_content` to S3 at `{session_name}/{container_name}/{timestamp}Z.log`.
/// Returns the S3 key that was written.
/// Emits `diag:command` events so the console pane shows progress and errors.
pub async fn upload_logs(
    app: AppHandle,
    config: &S3Config,
    session_name: &str,
    container_name: &str,
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

    let ts = Utc::now().format("%Y-%m-%d_%H-%M-%S").to_string();
    let key = format!(
        "{}/{}/{}Z.log",
        sanitize_s3_segment(session_name),
        sanitize_s3_segment(container_name),
        ts
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
