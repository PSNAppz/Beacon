//! Master-password key derivation (Argon2id) + AEAD field encryption (ChaCha20-Poly1305).
//!
//! The master password never touches disk. We derive a 32-byte key with Argon2id
//! using a per-vault random salt stored in the `vault_meta` table. To detect a
//! wrong password on unlock we also store a small encrypted "verifier" blob; if
//! AEAD verification fails on decrypt, the password is wrong.

use crate::error::{AppError, AppResult};
use argon2::{Algorithm, Argon2, Params, Version};
use base64::Engine;
use chacha20poly1305::aead::{Aead, KeyInit, OsRng};
use chacha20poly1305::{ChaCha20Poly1305, Key, Nonce};
use rand::RngCore;
use zeroize::Zeroize;

pub const VAULT_VERIFIER_PLAINTEXT: &[u8] = b"beacon-vault-v1";

#[derive(Clone)]
pub struct VaultKey([u8; 32]);

impl VaultKey {
    pub fn derive(password: &str, salt: &[u8]) -> AppResult<Self> {
        // Sensible interactive params: 64MiB, t=3, p=1.
        let params = Params::new(64 * 1024, 3, 1, Some(32))
            .map_err(|e| AppError::Crypto(format!("argon2 params: {e}")))?;
        let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
        let mut out = [0u8; 32];
        argon
            .hash_password_into(password.as_bytes(), salt, &mut out)
            .map_err(|e| AppError::Crypto(format!("argon2: {e}")))?;
        Ok(VaultKey(out))
    }

    fn cipher(&self) -> ChaCha20Poly1305 {
        ChaCha20Poly1305::new(Key::from_slice(&self.0))
    }

    /// Encrypt `plaintext`. Output is `nonce(12) || ciphertext+tag`, base64 encoded.
    pub fn encrypt_to_b64(&self, plaintext: &[u8]) -> AppResult<String> {
        let mut nonce_bytes = [0u8; 12];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ct = self
            .cipher()
            .encrypt(nonce, plaintext)
            .map_err(|e| AppError::Crypto(format!("encrypt: {e}")))?;
        let mut out = Vec::with_capacity(12 + ct.len());
        out.extend_from_slice(&nonce_bytes);
        out.extend_from_slice(&ct);
        Ok(base64::engine::general_purpose::STANDARD.encode(out))
    }

    pub fn decrypt_from_b64(&self, b64: &str) -> AppResult<Vec<u8>> {
        let raw = base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| AppError::Crypto(format!("b64: {e}")))?;
        if raw.len() < 13 {
            return Err(AppError::Crypto("ciphertext too short".into()));
        }
        let (nonce_bytes, ct) = raw.split_at(12);
        let nonce = Nonce::from_slice(nonce_bytes);
        self.cipher()
            .decrypt(nonce, ct)
            .map_err(|_| AppError::BadPassword)
    }
}

impl Drop for VaultKey {
    fn drop(&mut self) {
        self.0.zeroize();
    }
}

pub fn random_salt() -> [u8; 16] {
    let mut s = [0u8; 16];
    OsRng.fill_bytes(&mut s);
    s
}
