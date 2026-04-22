use std::collections::HashMap;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use tokio::sync::mpsc;
use tokio::time::Instant;
use tungstenite::Message;

use crate::types::{ClientCommand, GameType, ServerEvent};

// ── Configuration ───────────────────────────────────────────────────

/// Builder for configuring a [`BotpitClient`].
pub struct BotpitClientBuilder {
    api_key: String,
    url: String,
    auto_reconnect: bool,
    ping_interval: Duration,
    max_reconnect_delay: Duration,
    auth_timeout: Duration,
}

impl BotpitClientBuilder {
    pub(crate) fn new(api_key: impl Into<String>) -> Self {
        Self {
            api_key: api_key.into(),
            url: "wss://api.botpit.tech/api/v1/ws".into(),
            auto_reconnect: true,
            ping_interval: Duration::from_secs(25),
            max_reconnect_delay: Duration::from_secs(30),
            auth_timeout: Duration::from_secs(10),
        }
    }

    /// Set the WebSocket URL (default: `wss://api.botpit.tech/api/v1/ws`).
    pub fn url(mut self, url: impl Into<String>) -> Self {
        self.url = url.into();
        self
    }

    /// Enable/disable auto-reconnect on disconnect (default: `true`).
    pub fn auto_reconnect(mut self, enabled: bool) -> Self {
        self.auto_reconnect = enabled;
        self
    }

    /// Set the heartbeat ping interval (default: 25s).
    pub fn ping_interval(mut self, interval: Duration) -> Self {
        self.ping_interval = interval;
        self
    }

    /// Set the maximum reconnection delay (default: 30s).
    pub fn max_reconnect_delay(mut self, delay: Duration) -> Self {
        self.max_reconnect_delay = delay;
        self
    }

    /// Set the authentication timeout (default: 10s).
    pub fn auth_timeout(mut self, timeout: Duration) -> Self {
        self.auth_timeout = timeout;
        self
    }

    /// Build the client. Call [`BotpitClient::connect`] to start the connection.
    pub fn build(self) -> BotpitClient {
        BotpitClient {
            api_key: self.api_key,
            url: self.url,
            auto_reconnect: self.auto_reconnect,
            ping_interval: self.ping_interval,
            max_reconnect_delay: self.max_reconnect_delay,
            auth_timeout: self.auth_timeout,
        }
    }
}

// ── Client ──────────────────────────────────────────────────────────

/// The BotPit WebSocket client.
///
/// Create via [`BotpitClient::builder`], then call [`connect`](BotpitClient::connect)
/// to establish the WebSocket connection and get an event stream + command handle.
pub struct BotpitClient {
    api_key: String,
    url: String,
    auto_reconnect: bool,
    ping_interval: Duration,
    max_reconnect_delay: Duration,
    auth_timeout: Duration,
}

impl BotpitClient {
    /// Create a new client builder with the given API key.
    pub fn builder(api_key: impl Into<String>) -> BotpitClientBuilder {
        BotpitClientBuilder::new(api_key)
    }

    /// Connect to the BotPit server, authenticate, and return an event stream and command handle.
    ///
    /// The connection runs in a background tokio task. Events are received via [`EventStream`],
    /// and commands are sent via [`CommandHandle`].
    pub async fn connect(self) -> Result<(EventStream, CommandHandle), BotpitError> {
        let (event_tx, event_rx) = mpsc::unbounded_channel();
        let (cmd_tx, cmd_rx) = mpsc::unbounded_channel();

        // Oneshot for initial auth result
        let (auth_tx, auth_rx) = tokio::sync::oneshot::channel();

        let config = WsConfig {
            api_key: self.api_key,
            url: self.url,
            auto_reconnect: self.auto_reconnect,
            ping_interval: self.ping_interval,
            max_reconnect_delay: self.max_reconnect_delay,
            auth_timeout: self.auth_timeout,
        };

        // Spawn the background WS task
        tokio::spawn(ws_task(config, event_tx, cmd_rx, Some(auth_tx)));

        // Wait for initial authentication
        match tokio::time::timeout(self.auth_timeout, auth_rx).await {
            Ok(Ok(Ok(()))) => {}
            Ok(Ok(Err(e))) => return Err(e),
            Ok(Err(_)) => return Err(BotpitError::AuthTimeout),
            Err(_) => return Err(BotpitError::AuthTimeout),
        }

        Ok((EventStream(event_rx), CommandHandle { tx: cmd_tx }))
    }
}

// ── Public Types ────────────────────────────────────────────────────

/// Receives events from the BotPit server.
///
/// Wraps an unbounded mpsc receiver. Use `recv().await` to get the next event.
pub struct EventStream(pub(crate) mpsc::UnboundedReceiver<ServerEvent>);

impl EventStream {
    /// Receive the next server event. Returns `None` if the connection is permanently closed.
    pub async fn recv(&mut self) -> Option<ServerEvent> {
        self.0.recv().await
    }
}

/// Send commands to the BotPit server.
///
/// All methods are non-blocking fire-and-forget. The command is queued and sent
/// by the background WS task.
#[derive(Clone)]
pub struct CommandHandle {
    tx: mpsc::UnboundedSender<Command>,
}

impl CommandHandle {
    /// Join the matchmaking queue. `wager_sol` is in SOL (e.g. 0.01). Use 0 for sandbox/free play.
    pub fn join_queue(&self, game_type: GameType, wager_sol: f64, sandbox: bool) {
        let wager_lamports = (wager_sol * 1_000_000_000.0).round() as u64;
        let _ = self.tx.send(Command::Send(ClientCommand::JoinQueue {
            game_type,
            wager_lamports,
            sandbox,
        }));
    }

    /// Leave the matchmaking queue.
    pub fn leave_queue(&self) {
        let _ = self.tx.send(Command::Send(ClientCommand::LeaveQueue));
    }

    /// Submit a move for the given match.
    pub fn make_move(&self, match_id: &str, move_data: serde_json::Value) {
        let _ = self.tx.send(Command::MakeMove {
            match_id: match_id.to_string(),
            move_data,
        });
    }

    /// Resign from the given match.
    pub fn resign(&self, match_id: &str) {
        let _ = self.tx.send(Command::Send(ClientCommand::Resign {
            match_id: match_id.to_string(),
        }));
    }

    /// Create a direct challenge.
    pub fn create_challenge(&self, game_type: GameType, wager_sol: f64) {
        let wager_lamports = (wager_sol * 1_000_000_000.0).round() as u64;
        let _ = self.tx.send(Command::Send(ClientCommand::CreateChallenge {
            game_type,
            wager_lamports,
        }));
    }

    /// Accept a pending challenge.
    pub fn accept_challenge(&self, challenge_id: &str) {
        let _ = self.tx.send(Command::Send(ClientCommand::AcceptChallenge {
            challenge_id: challenge_id.to_string(),
        }));
    }

    /// Cancel a challenge you created.
    pub fn cancel_challenge(&self, challenge_id: &str) {
        let _ = self.tx.send(Command::Send(ClientCommand::CancelChallenge {
            challenge_id: challenge_id.to_string(),
        }));
    }

    /// Send a taunt to your opponent during a match.
    pub fn send_taunt(&self, match_id: &str, taunt_id: &str) {
        let _ = self.tx.send(Command::Send(ClientCommand::SendTaunt {
            match_id: match_id.to_string(),
            taunt_id: taunt_id.to_string(),
        }));
    }

    /// Gracefully disconnect. The background task will shut down and the event stream will end.
    pub fn disconnect(&self) {
        let _ = self.tx.send(Command::Disconnect);
    }
}

// ── Error Type ──────────────────────────────────────────────────────

/// Errors that can occur during BotPit client operations.
#[derive(Debug)]
pub enum BotpitError {
    /// WebSocket connection failed.
    Connection(String),
    /// Authentication timed out.
    AuthTimeout,
    /// Server rejected authentication.
    AuthFailed(String),
    /// Session was replaced by another connection.
    SessionReplaced,
}

impl std::fmt::Display for BotpitError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Connection(msg) => write!(f, "connection error: {msg}"),
            Self::AuthTimeout => write!(f, "authentication timed out"),
            Self::AuthFailed(msg) => write!(f, "authentication failed: {msg}"),
            Self::SessionReplaced => write!(f, "session replaced by another connection"),
        }
    }
}

impl std::error::Error for BotpitError {}

// ── Internal Types ──────────────────────────────────────────────────

#[derive(Clone)]
struct WsConfig {
    api_key: String,
    url: String,
    auto_reconnect: bool,
    ping_interval: Duration,
    max_reconnect_delay: Duration,
    auth_timeout: Duration,
}

enum Command {
    Send(ClientCommand),
    MakeMove {
        match_id: String,
        move_data: serde_json::Value,
    },
    Disconnect,
}

// ── Background WebSocket Task ───────────────────────────────────────

async fn ws_task(
    config: WsConfig,
    event_tx: mpsc::UnboundedSender<ServerEvent>,
    mut cmd_rx: mpsc::UnboundedReceiver<Command>,
    initial_auth_tx: Option<tokio::sync::oneshot::Sender<Result<(), BotpitError>>>,
) {
    let mut auth_tx = initial_auth_tx;
    let mut reconnect_attempts: u32 = 0;
    let mut session_replaced = false;

    loop {
        // Connect
        let ws_result = tokio_tungstenite::connect_async(&config.url).await;

        let ws_stream = match ws_result {
            Ok((stream, _)) => {
                tracing::info!("WebSocket connected to {}", config.url);
                stream
            }
            Err(e) => {
                let err_msg = e.to_string();
                tracing::error!("WebSocket connection failed: {err_msg}");

                if let Some(tx) = auth_tx.take() {
                    let _ = tx.send(Err(BotpitError::Connection(err_msg)));
                    return;
                }

                if !config.auto_reconnect || session_replaced {
                    let _ = event_tx.send(ServerEvent::Disconnected);
                    return;
                }

                let delay = reconnect_delay(reconnect_attempts, &config);
                let _ = event_tx.send(ServerEvent::Reconnecting {
                    attempt: reconnect_attempts + 1,
                    delay_ms: delay.as_millis() as u64,
                });
                tokio::time::sleep(delay).await;
                reconnect_attempts += 1;
                continue;
            }
        };

        let (mut ws_write, mut ws_read) = ws_stream.split();

        // Send authenticate
        let auth_msg = serde_json::to_string(&ClientCommand::Authenticate {
            api_key: config.api_key.clone(),
        })
        .unwrap();
        if let Err(e) = ws_write.send(Message::Text(auth_msg)).await {
            tracing::error!("Failed to send auth message: {e}");
            if let Some(tx) = auth_tx.take() {
                let _ = tx.send(Err(BotpitError::Connection(e.to_string())));
                return;
            }
            continue;
        }

        // Wait for auth response with timeout
        let auth_result = tokio::time::timeout(config.auth_timeout, ws_read.next()).await;
        let authenticated = match auth_result {
            Ok(Some(Ok(Message::Text(text)))) => {
                match serde_json::from_str::<serde_json::Value>(&text) {
                    Ok(value) => {
                        let event = ServerEvent::from_json(&value);
                        match &event {
                            ServerEvent::Authenticated { .. } => {
                                reconnect_attempts = 0;
                                if let Some(tx) = auth_tx.take() {
                                    let _ = tx.send(Ok(()));
                                }
                                let _ = event_tx.send(event);
                                true
                            }
                            ServerEvent::Error { code, message } => {
                                tracing::error!("Auth error [{code}]: {message}");
                                if let Some(tx) = auth_tx.take() {
                                    let _ = tx.send(Err(BotpitError::AuthFailed(message.clone())));
                                    return;
                                }
                                false
                            }
                            ServerEvent::SessionReplaced => {
                                if let Some(tx) = auth_tx.take() {
                                    let _ = tx.send(Err(BotpitError::SessionReplaced));
                                    return;
                                }
                                let _ = event_tx.send(ServerEvent::SessionReplaced);
                                let _ = event_tx.send(ServerEvent::Disconnected);
                                return;
                            }
                            _ => {
                                tracing::warn!("Unexpected first message: {:?}", event);
                                false
                            }
                        }
                    }
                    Err(e) => {
                        tracing::error!("Failed to parse auth response: {e}");
                        false
                    }
                }
            }
            Ok(Some(Ok(_))) => false,
            Ok(Some(Err(e))) => {
                tracing::error!("WS error during auth: {e}");
                if let Some(tx) = auth_tx.take() {
                    let _ = tx.send(Err(BotpitError::Connection(e.to_string())));
                    return;
                }
                false
            }
            Ok(None) => {
                tracing::error!("WS closed during auth");
                if let Some(tx) = auth_tx.take() {
                    let _ = tx.send(Err(BotpitError::Connection("closed during auth".into())));
                    return;
                }
                false
            }
            Err(_) => {
                tracing::error!("Auth timeout after {:?}", config.auth_timeout);
                if let Some(tx) = auth_tx.take() {
                    let _ = tx.send(Err(BotpitError::AuthTimeout));
                    return;
                }
                false
            }
        };

        if !authenticated {
            if !config.auto_reconnect || session_replaced {
                let _ = event_tx.send(ServerEvent::Disconnected);
                return;
            }
            let delay = reconnect_delay(reconnect_attempts, &config);
            let _ = event_tx.send(ServerEvent::Reconnecting {
                attempt: reconnect_attempts + 1,
                delay_ms: delay.as_millis() as u64,
            });
            tokio::time::sleep(delay).await;
            reconnect_attempts += 1;
            continue;
        }

        // Start ping interval
        let mut ping_interval = tokio::time::interval(config.ping_interval);
        ping_interval.tick().await; // consume first immediate tick

        // Move deadline tracking
        let mut deadlines: HashMap<String, Instant> = HashMap::new();
        let mut intentional_disconnect = false;

        // Main event loop
        loop {
            tokio::select! {
                // Incoming WS messages
                ws_msg = ws_read.next() => {
                    match ws_msg {
                        Some(Ok(Message::Text(text))) => {
                            match serde_json::from_str::<serde_json::Value>(&text) {
                                Ok(value) => {
                                    let event = ServerEvent::from_json(&value);

                                    // Track deadlines
                                    match &event {
                                        ServerEvent::YourTurn { match_id, timeout_ms, .. } => {
                                            if *timeout_ms > 0 {
                                                deadlines.insert(
                                                    match_id.clone(),
                                                    Instant::now() + Duration::from_millis(*timeout_ms),
                                                );
                                            }
                                        }
                                        ServerEvent::GameOver { match_id, .. } => {
                                            deadlines.remove(match_id);
                                        }
                                        ServerEvent::SessionReplaced => {
                                            session_replaced = true;
                                        }
                                        _ => {}
                                    }

                                    if event_tx.send(event).is_err() {
                                        // Receiver dropped, shut down
                                        return;
                                    }
                                }
                                Err(e) => {
                                    tracing::warn!("Failed to parse server message: {e}, raw: {}", &text[..text.len().min(200)]);
                                }
                            }
                        }
                        Some(Ok(Message::Close(_))) | None => {
                            tracing::info!("WebSocket closed");
                            break;
                        }
                        Some(Ok(_)) => {
                            // Binary, Ping, Pong frames — ignore
                        }
                        Some(Err(e)) => {
                            tracing::error!("WebSocket error: {e}");
                            break;
                        }
                    }
                }

                // Outbound commands
                cmd = cmd_rx.recv() => {
                    match cmd {
                        Some(Command::Send(client_cmd)) => {
                            let json = serde_json::to_string(&client_cmd).unwrap();
                            if let Err(e) = ws_write.send(Message::Text(json)).await {
                                tracing::error!("Failed to send command: {e}");
                                break;
                            }
                        }
                        Some(Command::MakeMove { match_id, move_data }) => {
                            // Check deadline
                            if let Some(deadline) = deadlines.remove(&match_id) {
                                let now = Instant::now();
                                if now > deadline {
                                    let late_ms = (now - deadline).as_millis();
                                    tracing::warn!(
                                        match_id = %match_id,
                                        late_by_ms = %late_ms,
                                        "Move submitted after timeout deadline"
                                    );
                                }
                            }

                            let cmd = ClientCommand::MakeMove {
                                match_id,
                                move_data,
                            };
                            let json = serde_json::to_string(&cmd).unwrap();
                            if let Err(e) = ws_write.send(Message::Text(json)).await {
                                tracing::error!("Failed to send move: {e}");
                                break;
                            }
                        }
                        Some(Command::Disconnect) => {
                            intentional_disconnect = true;
                            let _ = ws_write.send(Message::Close(None)).await;
                            break;
                        }
                        None => {
                            // All CommandHandle instances dropped — shut down
                            intentional_disconnect = true;
                            let _ = ws_write.send(Message::Close(None)).await;
                            break;
                        }
                    }
                }

                // Heartbeat ping
                _ = ping_interval.tick() => {
                    let json = serde_json::to_string(&ClientCommand::Ping).unwrap();
                    if let Err(e) = ws_write.send(Message::Text(json)).await {
                        tracing::error!("Failed to send ping: {e}");
                        break;
                    }
                }
            }
        }

        // Connection lost
        let _ = event_tx.send(ServerEvent::Disconnected);

        if intentional_disconnect || session_replaced || !config.auto_reconnect {
            return;
        }

        // Reconnect
        let delay = reconnect_delay(reconnect_attempts, &config);
        let _ = event_tx.send(ServerEvent::Reconnecting {
            attempt: reconnect_attempts + 1,
            delay_ms: delay.as_millis() as u64,
        });
        tracing::info!(
            "Reconnecting in {}ms (attempt {})...",
            delay.as_millis(),
            reconnect_attempts + 1
        );
        tokio::time::sleep(delay).await;
        reconnect_attempts += 1;
    }
}

/// Compute reconnect delay with exponential backoff + ±25% jitter.
fn reconnect_delay(attempts: u32, config: &WsConfig) -> Duration {
    let base = Duration::from_secs(1)
        .saturating_mul(2u32.saturating_pow(attempts))
        .min(config.max_reconnect_delay);

    let base_ms = base.as_millis() as f64;
    let jitter = base_ms * 0.25 * (rand::random::<f64>() * 2.0 - 1.0);
    let delay_ms = (base_ms + jitter).max(500.0);

    Duration::from_millis(delay_ms as u64)
}
