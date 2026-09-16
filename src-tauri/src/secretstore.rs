//! Optional "remember my master password" support backed by the OS credential
//! store (macOS Keychain, Windows Credential Manager, Linux Secret Service).
//!
//! The password is never written to Beacon's own files — only handed to the
//! platform keystore, which is unlocked by the user's OS login session. If the
//! keystore is unavailable (headless Linux without a Secret Service daemon,
//! for example) every call degrades gracefully instead of blocking unlock.

use crate::error::{AppError, AppResult};
use keyring::Entry;

const SERVICE: &str = "com.beacon.app";
const ACCOUNT: &str = "vault-master-password";

fn entry() -> AppResult<Entry> {
    Entry::new(SERVICE, ACCOUNT)
        .map_err(|e| AppError::Other(format!("credential store unavailable: {e}")))
}

pub fn save(password: &str) -> AppResult<()> {
    entry()?
        .set_password(password)
        .map_err(|e| AppError::Other(format!("could not save password: {e}")))
}

/// Returns `None` when nothing is stored (or the keystore can't be reached).
pub fn load() -> Option<String> {
    entry().ok()?.get_password().ok()
}

pub fn has() -> bool {
    load().is_some()
}

pub fn clear() -> AppResult<()> {
    match entry()?.delete_credential() {
        Ok(()) => Ok(()),
        // Nothing stored is not an error — `forget` is idempotent.
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(AppError::Other(format!("could not clear password: {e}"))),
    }
}
