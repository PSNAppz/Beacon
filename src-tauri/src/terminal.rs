//! Launch the user's native terminal emulator with an SSH command for a saved
//! session. Replaces the old in-app console: a real terminal gives a real PTY,
//! job control, scrollback and the user's own shell config.
//!
//! Mechanics: we write a short launcher script to a temp file (0600 on unix),
//! hand its path to the platform terminal, then delete the script after a short
//! delay — SSM sessions need AWS credentials in the environment and a script is
//! the only portable way to set them without putting secrets on a command line
//! visible in the process table.

use crate::error::{AppError, AppResult};
use crate::storage::{AuthKind, Session, Vault};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Single-quote a string for POSIX shells.
#[allow(dead_code)]
fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// Single-quote a string for PowerShell.
#[allow(dead_code)]
fn ps_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "''"))
}

/// `ssh` aborts on a private key that is readable by anyone but its owner.
/// russh (used for in-app connections) does not care, so a session can work in
/// the workspace and still fail the moment we hand it to the system ssh binary.
#[cfg(unix)]
fn check_key_permissions(path: &str) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    let Ok(meta) = std::fs::metadata(path) else { return Ok(()) };
    let mode = meta.permissions().mode() & 0o777;
    if mode & 0o077 != 0 {
        return Err(AppError::KeyPermissions(path.to_string()));
    }
    Ok(())
}

#[cfg(not(unix))]
fn check_key_permissions(_path: &str) -> AppResult<()> {
    // Windows OpenSSH enforces ACLs rather than mode bits; nothing to check here.
    Ok(())
}

/// Tighten a private key to owner-read/write. Called from the UI after the user
/// confirms the fix offered by `KeyPermissions`.
pub fn tighten_key_permissions(path: &str) -> AppResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    let _ = path;
    Ok(())
}

struct SshPlan {
    /// ssh arguments, in order, unquoted.
    args: Vec<String>,
    /// Environment variables the terminal needs (AWS creds for SSM).
    env: Vec<(String, String)>,
}

async fn build_plan(vault: &Vault, session: &Session) -> AppResult<SshPlan> {
    let mut args: Vec<String> = Vec::new();
    let mut env: Vec<(String, String)> = Vec::new();

    // Accept a first-seen host key rather than failing on a fresh known_hosts;
    // a changed key still aborts the connection.
    args.push("-o".into());
    args.push("StrictHostKeyChecking=accept-new".into());

    if session.use_ssm {
        let region = session
            .aws_region
            .as_deref()
            .ok_or_else(|| AppError::Ssh("AWS region is required for SSM sessions".into()))?;
        let aws = crate::storage::sessions::read_aws_secret(vault, &session.id)?;
        let instance_id =
            crate::ssh::ssm_resolver::resolve_instance_id(session, aws.secret_access_key.as_deref())
                .await?;

        if let (Some(key_id), Some(secret)) =
            (session.aws_access_key_id.as_deref(), aws.secret_access_key.as_deref())
        {
            env.push(("AWS_ACCESS_KEY_ID".into(), key_id.to_string()));
            env.push(("AWS_SECRET_ACCESS_KEY".into(), secret.to_string()));
        }
        if let Some(profile) = session.aws_profile.as_deref() {
            env.push(("AWS_PROFILE".into(), profile.to_string()));
        }
        env.push(("AWS_REGION".into(), region.to_string()));
        env.push(("AWS_DEFAULT_REGION".into(), region.to_string()));

        // Requires the AWS CLI v2 plus the session-manager-plugin on PATH.
        args.push("-o".into());
        args.push(format!(
            "ProxyCommand=aws ssm start-session --target {instance_id} \
             --document-name AWS-StartSSHSession --parameters portNumber=%p --region {region}"
        ));
        args.push("-p".into());
        args.push(session.port.to_string());
        if session.auth_kind == AuthKind::Key {
            if let Some(path) = session.key_path.as_deref() {
                check_key_permissions(path)?;
                args.push("-i".into());
                args.push(path.to_string());
            }
        }
        args.push(format!("{}@{}", session.username, instance_id));
        return Ok(SshPlan { args, env });
    }

    if let Some(jump_id) = session.jump_session_id.as_deref() {
        let jump = crate::storage::sessions::get(vault, jump_id)?;
        match jump.key_path.as_deref() {
            // `-J` gives no way to point at the jump host's key, so spell the
            // hop out as a ProxyCommand when one is configured.
            Some(jump_key) => {
                check_key_permissions(jump_key)?;
                args.push("-o".into());
                args.push(format!(
                    "ProxyCommand=ssh -i {} -p {} -W %h:%p {}@{}",
                    jump_key, jump.port, jump.username, jump.host
                ));
            }
            None => {
                args.push("-J".into());
                args.push(format!("{}@{}:{}", jump.username, jump.host, jump.port));
            }
        }
    }

    args.push("-p".into());
    args.push(session.port.to_string());

    match session.auth_kind {
        AuthKind::Key => {
            if let Some(path) = session.key_path.as_deref() {
                check_key_permissions(path)?;
                args.push("-i".into());
                args.push(path.to_string());
            }
        }
        AuthKind::Password => {
            // ssh will prompt interactively; the stored password is deliberately
            // not passed through (no sshpass dependency, no secret on argv).
            args.push("-o".into());
            args.push("PreferredAuthentications=password".into());
            args.push("-o".into());
            args.push("PubkeyAuthentication=no".into());
        }
        AuthKind::Agent => {}
    }

    args.push(format!("{}@{}", session.username, session.host));
    Ok(SshPlan { args, env })
}

fn temp_script_path(session_id: &str, ext: &str) -> AppResult<PathBuf> {
    let dir = std::env::temp_dir().join("beacon-terminal");
    std::fs::create_dir_all(&dir)?;
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    Ok(dir.join(format!("beacon-{}-{}.{ext}", &session_id[..8.min(session_id.len())], stamp)))
}

/// Remove the launcher script once the terminal has had time to read it.
fn schedule_cleanup(path: PathBuf) {
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(20));
        let _ = std::fs::remove_file(&path);
    });
}

fn write_script(path: &Path, body: &str) -> AppResult<()> {
    let mut f = std::fs::File::create(path)?;
    f.write_all(body.as_bytes())?;
    f.flush()?;
    drop(f);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}

pub async fn open_for_session(vault: &Vault, session_id: &str) -> AppResult<()> {
    let session = crate::storage::sessions::get(vault, session_id)?;
    let plan = build_plan(vault, &session).await?;
    launch(&session, &plan)
}

#[cfg(target_os = "macos")]
fn launch(session: &Session, plan: &SshPlan) -> AppResult<()> {
    let path = temp_script_path(&session.id, "command")?;
    let mut body = String::from("#!/bin/sh\n");
    for (k, v) in &plan.env {
        body.push_str(&format!("export {k}={}\n", sh_quote(v)));
    }
    body.push_str(&format!("printf '\\033]0;Beacon — %s\\007' {}\n", sh_quote(&session.name)));
    let args = plan.args.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" ");
    body.push_str(&format!("exec ssh {args}\n"));
    write_script(&path, &body)?;

    let status = std::process::Command::new("open")
        .arg("-a")
        .arg("Terminal")
        .arg(&path)
        .status()
        .map_err(|e| AppError::Other(format!("could not launch Terminal: {e}")))?;
    schedule_cleanup(path);
    if !status.success() {
        return Err(AppError::Other("Terminal failed to launch".into()));
    }
    Ok(())
}

#[cfg(target_os = "windows")]
fn launch(session: &Session, plan: &SshPlan) -> AppResult<()> {
    let path = temp_script_path(&session.id, "ps1")?;
    let mut body = String::new();
    body.push_str(&format!(
        "$Host.UI.RawUI.WindowTitle = {}\n",
        ps_quote(&format!("Beacon — {}", session.name))
    ));
    for (k, v) in &plan.env {
        body.push_str(&format!("$env:{k} = {}\n", ps_quote(v)));
    }
    let args = plan.args.iter().map(|a| ps_quote(a)).collect::<Vec<_>>().join(" ");
    body.push_str(&format!("ssh {args}\n"));
    // Keep the window up so a connection error stays readable.
    body.push_str("Write-Host ''\nRead-Host 'Session ended — press Enter to close'\n");
    write_script(&path, &body)?;

    let script = path.to_string_lossy().to_string();
    // Windows Terminal when present, otherwise a plain PowerShell console.
    let spawned = std::process::Command::new("wt.exe")
        .args(["powershell", "-NoExit", "-ExecutionPolicy", "Bypass", "-File", &script])
        .spawn()
        .or_else(|_| {
            std::process::Command::new("cmd")
                .args([
                    "/C", "start", "", "powershell", "-NoExit", "-ExecutionPolicy", "Bypass",
                    "-File", &script,
                ])
                .spawn()
        })
        .map_err(|e| AppError::Other(format!("could not launch a terminal: {e}")))?;
    drop(spawned);
    schedule_cleanup(path);
    Ok(())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn launch(session: &Session, plan: &SshPlan) -> AppResult<()> {
    let path = temp_script_path(&session.id, "sh")?;
    let mut body = String::from("#!/bin/sh\n");
    for (k, v) in &plan.env {
        body.push_str(&format!("export {k}={}\n", sh_quote(v)));
    }
    let args = plan.args.iter().map(|a| sh_quote(a)).collect::<Vec<_>>().join(" ");
    body.push_str(&format!("ssh {args}\n"));
    body.push_str("printf '\\nSession ended — press Enter to close. '\nread _\n");
    write_script(&path, &body)?;

    let script = path.to_string_lossy().to_string();
    // `-e` is the one flag every one of these agrees on.
    let candidates: [(&str, Vec<String>); 8] = [
        ("x-terminal-emulator", vec!["-e".into(), script.clone()]),
        ("gnome-terminal", vec!["--".into(), script.clone()]),
        ("konsole", vec!["-e".into(), script.clone()]),
        ("xfce4-terminal", vec!["-e".into(), script.clone()]),
        ("alacritty", vec!["-e".into(), script.clone()]),
        ("kitty", vec![script.clone()]),
        ("tilix", vec!["-e".into(), script.clone()]),
        ("xterm", vec!["-e".into(), script.clone()]),
    ];
    for (bin, args) in candidates {
        if std::process::Command::new(bin).args(&args).spawn().is_ok() {
            schedule_cleanup(path);
            return Ok(());
        }
    }
    let _ = std::fs::remove_file(&path);
    let _ = session;
    Err(AppError::Other(
        "no terminal emulator found (tried gnome-terminal, konsole, xfce4-terminal, alacritty, kitty, tilix, xterm)".into(),
    ))
}
