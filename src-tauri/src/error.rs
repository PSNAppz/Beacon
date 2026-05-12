use serde::Serialize;
use thiserror::Error;

#[derive(Debug, Error)]
pub enum AppError {
    #[error("vault is locked")]
    Locked,
    #[error("vault already initialized")]
    AlreadyInitialized,
    #[error("invalid master password")]
    BadPassword,
    #[error("not found")]
    NotFound,
    #[error("io: {0}")]
    Io(#[from] std::io::Error),
    #[error("db: {0}")]
    Db(#[from] rusqlite::Error),
    #[error("crypto: {0}")]
    Crypto(String),
    #[error("ssh: {0}")]
    Ssh(String),
    #[error("{0}")]
    Other(String),
}

impl From<anyhow::Error> for AppError {
    fn from(e: anyhow::Error) -> Self { AppError::Other(e.to_string()) }
}

impl From<russh::Error> for AppError {
    fn from(e: russh::Error) -> Self { AppError::Ssh(e.to_string()) }
}

impl From<russh_keys::Error> for AppError {
    fn from(e: russh_keys::Error) -> Self { AppError::Ssh(format!("key: {e}")) }
}

impl Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(&self.to_string())
    }
}

pub type AppResult<T> = Result<T, AppError>;
