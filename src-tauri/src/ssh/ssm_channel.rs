//! AWS SSM Session Manager datachannel — native WebSocket implementation.
//!
//! Implements the SSM binary framing protocol so Beacon can open SSH tunnels
//! through SSM without requiring the AWS CLI to be installed.  The resulting
//! `SsmStream` implements `AsyncRead + AsyncWrite` and is handed directly to
//! `russh::client::connect_stream()` as the SSH transport.
//!
//! Protocol reference: https://github.com/aws/session-manager-plugin

use crate::error::{AppError, AppResult};
use futures::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::VecDeque;
use std::pin::Pin;
use std::task::{Context, Poll};
use std::time::{SystemTime, UNIX_EPOCH};
use tokio::io::{AsyncRead, AsyncWrite, ReadBuf};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message as WsMessage;

// ── SSM message framing (all fields big-endian) ───────────────────────────────
// Byte layout before payload (120 bytes total):
//  [0..4]   headerLength = 116  (u32)
//  [4..36]  messageType         (32-byte null-padded ASCII)
//  [36..40] schemaVersion = 1   (u32)
//  [40..48] createdDate         (u64 ms since epoch)
//  [48..56] sequenceNumber      (i64)
//  [56..64] flags               (u64)
//  [64..80] messageId           (16-byte UUID)
//  [80..112] payloadDigest      (SHA-256, 32 bytes)
//  [112..116] payloadType       (u32)
//  [116..120] payloadLength     (u32)
//  [120..] payload

const HEADER_LEN: u32 = 116;
const SCHEMA_VER: u32 = 1;
const HDR_SIZE: usize = 120;

const TYPE_OUTPUT: &str = "output_stream_data";
const TYPE_INPUT: &str = "input_stream_data";
const TYPE_ACK: &str = "acknowledge";
const TYPE_CLOSED: &str = "channel_closed";
const TYPE_HS_REQ: &str = "handshake_request";
const TYPE_HS_RESP: &str = "handshake_response";
const TYPE_HS_DONE: &str = "handshake_complete";

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn encode_msg(msg_type: &str, seq: i64, payload: Vec<u8>) -> Vec<u8> {
    let mut digest = [0u8; 32];
    let mut h = Sha256::new();
    h.update(&payload);
    digest.copy_from_slice(&h.finalize());

    let plen = payload.len() as u32;
    let msg_id = *uuid::Uuid::new_v4().as_bytes();

    let mut t = [0u8; 32];
    let src = msg_type.as_bytes();
    t[..src.len().min(32)].copy_from_slice(&src[..src.len().min(32)]);

    let mut buf = Vec::with_capacity(HDR_SIZE + payload.len());
    buf.extend_from_slice(&HEADER_LEN.to_be_bytes());
    buf.extend_from_slice(&t);
    buf.extend_from_slice(&SCHEMA_VER.to_be_bytes());
    buf.extend_from_slice(&now_ms().to_be_bytes());
    buf.extend_from_slice(&seq.to_be_bytes());
    buf.extend_from_slice(&0u64.to_be_bytes()); // flags
    buf.extend_from_slice(&msg_id);
    buf.extend_from_slice(&digest);
    buf.extend_from_slice(&0u32.to_be_bytes()); // payloadType
    buf.extend_from_slice(&plen.to_be_bytes());
    buf.extend_from_slice(&payload);
    buf
}

struct ParsedMsg {
    msg_type: String,
    sequence_number: i64,
    message_id: [u8; 16],
    payload: Vec<u8>,
}

fn decode_msg(data: &[u8]) -> Option<ParsedMsg> {
    if data.len() < HDR_SIZE {
        return None;
    }
    let raw_type = &data[4..36];
    let msg_type = String::from_utf8_lossy(raw_type)
        .trim_end_matches('\0')
        .trim()
        .to_string();
    let sequence_number = i64::from_be_bytes(data[48..56].try_into().ok()?);
    let message_id: [u8; 16] = data[64..80].try_into().ok()?;
    let plen = u32::from_be_bytes(data[116..120].try_into().ok()?) as usize;
    if data.len() < HDR_SIZE + plen {
        return None;
    }
    let payload = data[HDR_SIZE..HDR_SIZE + plen].to_vec();
    Some(ParsedMsg { msg_type, sequence_number, message_id, payload })
}

fn make_ack(msg: &ParsedMsg) -> Vec<u8> {
    let payload = serde_json::to_vec(&AcknowledgePayload {
        acknowledged_message_type: msg.msg_type.clone(),
        acknowledged_message_id: uuid::Uuid::from_bytes(msg.message_id).to_string(),
        acknowledged_message_sequence_number: msg.sequence_number,
        is_sequential_message: true,
    })
    .unwrap_or_default();
    encode_msg(TYPE_ACK, 0, payload)
}

// ── Handshake JSON types ──────────────────────────────────────────────────────

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct HandshakeRequest {
    requested_client_actions: Vec<HandshakeAction>,
}

#[derive(Deserialize)]
#[serde(rename_all = "PascalCase")]
struct HandshakeAction {
    action_type: String,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct HandshakeResponse {
    client_version: String,
    processed_client_actions: Vec<ProcessedAction>,
    errors: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct ProcessedAction {
    action_type: String,
    action_result: u32,
    action_parameters: serde_json::Value,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct HandshakeComplete {
    handshake_time_to_complete: u64,
    customer_message: String,
}

#[derive(Serialize)]
#[serde(rename_all = "PascalCase")]
struct AcknowledgePayload {
    acknowledged_message_type: String,
    acknowledged_message_id: String,
    acknowledged_message_sequence_number: i64,
    is_sequential_message: bool,
}

// ── SsmStream — AsyncRead + AsyncWrite wrapper ────────────────────────────────

type WsStream = tokio_tungstenite::WebSocketStream<
    tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>,
>;

/// Bidirectional SSH transport backed by an SSM datachannel WebSocket.
pub struct SsmStream {
    /// SSH data arriving from the SSM channel (written by the pump task).
    rx: mpsc::UnboundedReceiver<Vec<u8>>,
    /// SSH data to send to the SSM channel (read by the pump task).
    tx: mpsc::UnboundedSender<Vec<u8>>,
    /// Leftover bytes from the last receive not yet consumed by the SSH layer.
    leftover: VecDeque<u8>,
}

impl AsyncRead for SsmStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<std::io::Result<()>> {
        if self.leftover.is_empty() {
            match self.rx.poll_recv(cx) {
                Poll::Ready(Some(data)) => self.leftover.extend(data),
                Poll::Ready(None) => {
                    return Poll::Ready(Err(std::io::Error::new(
                        std::io::ErrorKind::BrokenPipe,
                        "SSM channel closed",
                    )))
                }
                Poll::Pending => return Poll::Pending,
            }
        }
        let n = self.leftover.len().min(buf.remaining());
        let drained: Vec<u8> = self.leftover.drain(..n).collect();
        buf.put_slice(&drained);
        Poll::Ready(Ok(()))
    }
}

impl AsyncWrite for SsmStream {
    fn poll_write(
        self: Pin<&mut Self>,
        _cx: &mut Context<'_>,
        buf: &[u8],
    ) -> Poll<std::io::Result<usize>> {
        match self.tx.send(buf.to_vec()) {
            Ok(_) => Poll::Ready(Ok(buf.len())),
            Err(_) => Poll::Ready(Err(std::io::Error::new(
                std::io::ErrorKind::BrokenPipe,
                "SSM channel closed",
            ))),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
    fn poll_shutdown(self: Pin<&mut Self>, _cx: &mut Context<'_>) -> Poll<std::io::Result<()>> {
        Poll::Ready(Ok(()))
    }
}

// ── Type aliases for split WebSocket halves ───────────────────────────────────

type WsSink = futures::stream::SplitSink<WsStream, WsMessage>;
type WsRx   = futures::stream::SplitStream<WsStream>;

// ── Synchronous handshake (runs before spawning the pump) ─────────────────────

/// Sends the session token and completes the optional SSM handshake.
/// Returns `Some(payload)` if the first data frame arrived during the handshake
/// (older agents skip straight to data), or `None` after a normal handshake.
/// Returns a descriptive `AppError` instead of silently failing.
async fn do_handshake(
    ws_sink: &mut WsSink,
    ws_rx: &mut WsRx,
    token: String,
) -> AppResult<Option<Vec<u8>>> {
    ws_sink
        .send(WsMessage::Text(token))
        .await
        .map_err(|e| AppError::Ssh(format!("SSM token send failed: {e}")))?;

    let hs_start = now_ms();

    loop {
        let msg = tokio::time::timeout(std::time::Duration::from_secs(15), ws_rx.next())
            .await
            .map_err(|_| AppError::Ssh(
                "SSM handshake timed out (15 s) — is the SSM agent running on the instance?".into(),
            ))?
            .ok_or_else(|| AppError::Ssh("SSM WebSocket closed during handshake".into()))?
            .map_err(|e| AppError::Ssh(format!("SSM WebSocket error during handshake: {e}")))?;

        let bytes = match msg {
            WsMessage::Binary(b) => b,
            WsMessage::Close(f) => {
                let reason = f.map(|f| f.reason.to_string()).unwrap_or_default();
                return Err(AppError::Ssh(format!(
                    "SSM WebSocket closed during handshake: {reason}"
                )));
            }
            _ => continue,
        };

        let Some(parsed) = decode_msg(&bytes) else { continue };

        match parsed.msg_type.as_str() {
            TYPE_HS_REQ => {
                let processed = if let Ok(req) =
                    serde_json::from_slice::<HandshakeRequest>(&parsed.payload)
                {
                    req.requested_client_actions
                        .into_iter()
                        .map(|a| ProcessedAction {
                            action_type: a.action_type,
                            action_result: 0,
                            action_parameters: serde_json::json!({}),
                        })
                        .collect()
                } else {
                    vec![]
                };

                let resp_bytes = serde_json::to_vec(&HandshakeResponse {
                    client_version: "1.2.398.0".to_string(),
                    processed_client_actions: processed,
                    errors: vec![],
                })
                .unwrap_or_default();

                ws_sink
                    .send(WsMessage::Binary(encode_msg(TYPE_HS_RESP, 0, resp_bytes)))
                    .await
                    .map_err(|e| AppError::Ssh(format!("SSM handshake_response send failed: {e}")))?;

                let complete_bytes = serde_json::to_vec(&HandshakeComplete {
                    handshake_time_to_complete: now_ms() - hs_start,
                    customer_message: String::new(),
                })
                .unwrap_or_default();

                ws_sink
                    .send(WsMessage::Binary(encode_msg(TYPE_HS_DONE, 0, complete_bytes)))
                    .await
                    .map_err(|e| AppError::Ssh(format!("SSM handshake_complete send failed: {e}")))?;

                return Ok(None);
            }
            TYPE_OUTPUT => {
                // Older agents skip the handshake — first message is already SSH data.
                let _ = ws_sink.send(WsMessage::Binary(make_ack(&parsed))).await;
                return Ok(Some(parsed.payload));
            }
            TYPE_CLOSED => {
                return Err(AppError::Ssh(
                    "SSM agent closed the channel — is sshd running and listening on port 22 on the instance?".into(),
                ));
            }
            _ => {} // acknowledge frames etc., keep waiting
        }
    }
}

// ── Background data pump (runs after handshake succeeds) ─────────────────────

async fn data_pump(
    mut ws_sink: WsSink,
    mut ws_rx: WsRx,
    data_tx: mpsc::UnboundedSender<Vec<u8>>,
    mut data_rx: mpsc::UnboundedReceiver<Vec<u8>>,
) {
    let mut send_seq: i64 = 0;
    loop {
        tokio::select! {
            ws_msg = ws_rx.next() => {
                match ws_msg {
                    Some(Ok(WsMessage::Binary(bytes))) => {
                        let Some(parsed) = decode_msg(&bytes) else { continue };
                        match parsed.msg_type.as_str() {
                            TYPE_OUTPUT => {
                                let _ = ws_sink.send(WsMessage::Binary(make_ack(&parsed))).await;
                                if data_tx.send(parsed.payload).is_err() { return; }
                            }
                            TYPE_CLOSED => return,
                            _ => {}
                        }
                    }
                    Some(Ok(WsMessage::Ping(data))) => {
                        let _ = ws_sink.send(WsMessage::Pong(data)).await;
                    }
                    None | Some(Ok(WsMessage::Close(_))) | Some(Err(_)) => return,
                    _ => {}
                }
            }
            outgoing = data_rx.recv() => {
                let Some(ssh_data) = outgoing else { return };
                let msg = encode_msg(TYPE_INPUT, send_seq, ssh_data);
                send_seq += 1;
                if ws_sink.send(WsMessage::Binary(msg)).await.is_err() { return; }
            }
        }
    }
}

// ── Public entry point ────────────────────────────────────────────────────────

/// Open an SSM datachannel and return an `AsyncRead + AsyncWrite` stream
/// suitable for use as a russh SSH transport.
///
/// If `access_key_id` / `secret_key` are both `Some`, those credentials are
/// used directly.  If both are `None` the default AWS credential chain is used
/// (environment variables, `~/.aws/credentials`, IAM role metadata, etc.).
pub async fn open_ssm_stream(
    region: &str,
    instance_id: &str,
    port: u16,
    access_key_id: Option<&str>,
    secret_key: Option<&str>,
) -> AppResult<SsmStream> {
    use aws_sdk_ssm::config::{BehaviorVersion, Region};

    // Build the SSM client config.
    let sdk_config = if let (Some(kid), Some(sk)) = (access_key_id, secret_key) {
        use aws_sdk_ssm::config::Credentials;
        aws_sdk_ssm::Config::builder()
            .credentials_provider(Credentials::new(kid, sk, None, None, "beacon"))
            .region(Region::new(region.to_string()))
            .behavior_version(BehaviorVersion::latest())
            .build()
    } else {
        let cfg = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(Region::new(region.to_string()))
            .load()
            .await;
        aws_sdk_ssm::Config::from(&cfg)
    };

    let client = aws_sdk_ssm::Client::from_conf(sdk_config);

    // Call ssm:StartSession to get the WebSocket URL + token.
    let resp = client
        .start_session()
        .target(instance_id)
        .document_name("AWS-StartSSHSession")
        .parameters("portNumber", vec![port.to_string()])
        .send()
        .await
        .map_err(|e| {
            use aws_sdk_ssm::error::ProvideErrorMetadata;
            let code = e.code().unwrap_or("unknown");
            let msg  = e.message().unwrap_or("no message");
            AppError::Ssh(format!("SSM StartSession failed: {code} — {msg}"))
        })?;

    // The official session-manager-plugin appends ?role=publish_subscribe to the
    // stream URL before opening the WebSocket — without it the service rejects
    // the channel as invalid.
    let stream_url = {
        let base = resp
            .stream_url()
            .ok_or_else(|| AppError::Ssh("SSM response missing streamUrl".into()))?;
        if base.contains('?') {
            format!("{base}&role=publish_subscribe")
        } else {
            format!("{base}?role=publish_subscribe")
        }
    };
    let token = resp
        .token_value()
        .ok_or_else(|| AppError::Ssh("SSM response missing tokenValue".into()))?
        .to_string();

    // Connect the WebSocket (wss:// — TLS handled by native-tls feature).
    let (ws, _) = tokio_tungstenite::connect_async(&stream_url)
        .await
        .map_err(|e| AppError::Ssh(format!("SSM WebSocket connect failed: {e}")))?;

    let (mut ws_sink, mut ws_rx) = ws.split();

    // Handshake runs synchronously — errors propagate to the caller instead of
    // silently killing a background task.
    let carry = do_handshake(&mut ws_sink, &mut ws_rx, token).await?;

    // Channels: pump → SsmStream (SSH data in) and SsmStream → pump (SSH data out).
    let (pump_tx, stream_rx) = mpsc::unbounded_channel::<Vec<u8>>();
    let (stream_tx, pump_rx) = mpsc::unbounded_channel::<Vec<u8>>();

    if let Some(data) = carry {
        let _ = pump_tx.send(data);
    }

    tokio::spawn(data_pump(ws_sink, ws_rx, pump_tx, pump_rx));

    Ok(SsmStream {
        rx: stream_rx,
        tx: stream_tx,
        leftover: VecDeque::new(),
    })
}
