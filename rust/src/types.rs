use serde::{Deserialize, Serialize};

// ── Game Types ──────────────────────────────────────────────────────

/// All supported BotPit game types.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum GameType {
    Coinflip,
    Rps,
    HiLo,
    HighCardDuel,
    DiceDuel,
    Crash,
    Mines,
    MathDuel,
    ReactionRing,
    Blotto,
}

impl std::fmt::Display for GameType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let s = serde_json::to_value(self)
            .ok()
            .and_then(|v| v.as_str().map(String::from))
            .unwrap_or_else(|| format!("{:?}", self));
        f.write_str(&s)
    }
}

/// Which side the agent is on in a match.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Side {
    A,
    B,
}

// ── Server Events ───────────────────────────────────────────────────

/// Events received from the BotPit server via WebSocket.
#[derive(Debug, Clone)]
pub enum ServerEvent {
    /// Authentication succeeded.
    Authenticated {
        agent_id: String,
        agent_name: String,
    },
    /// Server error.
    Error {
        code: String,
        message: String,
    },
    /// Another connection authenticated with the same API key.
    SessionReplaced,
    /// A match has been found.
    MatchFound {
        match_id: String,
        game_type: GameType,
        opponent_id: String,
        opponent_name: String,
        wager_lamports: u64,
        server_seed_hash: String,
    },
    /// Game is starting; tells you which side you're on.
    GameStart {
        match_id: String,
        your_side: Side,
    },
    /// It's your turn to make a move.
    YourTurn {
        match_id: String,
        round: u32,
        game_state: serde_json::Value,
        timeout_ms: u64,
    },
    /// Result of a round.
    RoundResult {
        match_id: String,
        round: u32,
        result: serde_json::Value,
        score: [u32; 2],
    },
    /// Game is over.
    GameOver {
        match_id: String,
        winner: Option<String>,
        final_score: [u32; 2],
        server_seed: String,
        payout_lamports: u64,
        fee_lamports: Option<u64>,
        is_sandbox: Option<bool>,
    },
    /// Successfully joined the matchmaking queue.
    QueueJoined {
        game_type: String,
        position: u32,
    },
    /// Left the matchmaking queue.
    QueueLeft,
    /// Queue status update.
    QueueUpdate {
        game_type: String,
        position: u32,
        wait_time_ms: u64,
        search_radius: f64,
        players_in_queue: u32,
        players_online: u32,
    },
    /// Opponent submitted their move (for simultaneous-move games).
    OpponentMoved {
        match_id: String,
        round: u32,
        move_data: serde_json::Value,
    },
    /// Challenge created successfully.
    ChallengeCreated {
        challenge_id: String,
        game_type: GameType,
        wager_lamports: u64,
    },
    /// Someone accepted your challenge.
    ChallengeAccepted {
        challenge_id: String,
        match_id: String,
    },
    /// Challenge was cancelled.
    ChallengeCancelled {
        challenge_id: String,
    },
    /// Opponent sent a taunt.
    TauntReceived {
        match_id: String,
        agent_id: String,
        agent_name: String,
        taunt_id: String,
        taunt_text: String,
    },
    /// WebSocket disconnected (synthetic event from client).
    Disconnected,
    /// Client is attempting to reconnect (synthetic event from client).
    Reconnecting {
        attempt: u32,
        delay_ms: u64,
    },
    /// Heartbeat pong received.
    Pong,
    /// Unknown message type from server.
    Unknown(serde_json::Value),
}

// ── Client Commands ─────────────────────────────────────────────────

/// Commands sent from the client to the BotPit server.
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub(crate) enum ClientCommand {
    Authenticate {
        api_key: String,
    },
    JoinQueue {
        game_type: GameType,
        wager_lamports: u64,
        #[serde(skip_serializing_if = "std::ops::Not::not")]
        sandbox: bool,
    },
    LeaveQueue,
    MakeMove {
        match_id: String,
        move_data: serde_json::Value,
    },
    Resign {
        match_id: String,
    },
    CreateChallenge {
        game_type: GameType,
        wager_lamports: u64,
    },
    AcceptChallenge {
        challenge_id: String,
    },
    CancelChallenge {
        challenge_id: String,
    },
    SendTaunt {
        match_id: String,
        taunt_id: String,
    },
    Ping,
}

// ── JSON Parsing ────────────────────────────────────────────────────

impl ServerEvent {
    /// Parse a raw JSON message from the server into a ServerEvent.
    pub fn from_json(value: &serde_json::Value) -> Self {
        let msg_type = value.get("type").and_then(|v| v.as_str()).unwrap_or("");

        match msg_type {
            "authenticated" => ServerEvent::Authenticated {
                agent_id: str_field(value, "agent_id"),
                agent_name: str_field(value, "agent_name"),
            },
            "error" => ServerEvent::Error {
                code: str_field(value, "code"),
                message: str_field(value, "message"),
            },
            "session_replaced" => ServerEvent::SessionReplaced,
            "match_found" => ServerEvent::MatchFound {
                match_id: str_field(value, "match_id"),
                game_type: serde_json::from_value(value["game_type"].clone())
                    .unwrap_or(GameType::Coinflip),
                opponent_id: str_field(value, "opponent_id"),
                opponent_name: str_field(value, "opponent_name"),
                wager_lamports: u64_field(value, "wager_lamports"),
                server_seed_hash: str_field(value, "server_seed_hash"),
            },
            "game_start" => ServerEvent::GameStart {
                match_id: str_field(value, "match_id"),
                your_side: serde_json::from_value(value["your_side"].clone())
                    .unwrap_or(Side::A),
            },
            "your_turn" => ServerEvent::YourTurn {
                match_id: str_field(value, "match_id"),
                round: u32_field(value, "round"),
                game_state: value.get("game_state").cloned().unwrap_or(serde_json::Value::Null),
                timeout_ms: u64_field(value, "timeout_ms"),
            },
            "round_result" => ServerEvent::RoundResult {
                match_id: str_field(value, "match_id"),
                round: u32_field(value, "round"),
                result: value.get("result").cloned().unwrap_or(serde_json::Value::Null),
                score: parse_score(value),
            },
            "game_over" => ServerEvent::GameOver {
                match_id: str_field(value, "match_id"),
                winner: value.get("winner").and_then(|v| v.as_str()).map(String::from),
                final_score: parse_score_field(value, "final_score"),
                server_seed: str_field(value, "server_seed"),
                payout_lamports: u64_field(value, "payout_lamports"),
                fee_lamports: value.get("fee_lamports").and_then(|v| v.as_u64()),
                is_sandbox: value.get("is_sandbox").and_then(|v| v.as_bool()),
            },
            "queue_joined" => ServerEvent::QueueJoined {
                game_type: str_field(value, "game_type"),
                position: u32_field(value, "position"),
            },
            "queue_left" => ServerEvent::QueueLeft,
            "queue_update" => ServerEvent::QueueUpdate {
                game_type: str_field(value, "game_type"),
                position: u32_field(value, "position"),
                wait_time_ms: u64_field(value, "wait_time_ms"),
                search_radius: value.get("search_radius").and_then(|v| v.as_f64()).unwrap_or(0.0),
                players_in_queue: u32_field(value, "players_in_queue"),
                players_online: u32_field(value, "players_online"),
            },
            "opponent_moved" => ServerEvent::OpponentMoved {
                match_id: str_field(value, "match_id"),
                round: u32_field(value, "round"),
                move_data: value.get("move_data").cloned().unwrap_or(serde_json::Value::Null),
            },
            "challenge_created" => ServerEvent::ChallengeCreated {
                challenge_id: str_field(value, "challenge_id"),
                game_type: serde_json::from_value(value["game_type"].clone())
                    .unwrap_or(GameType::Coinflip),
                wager_lamports: u64_field(value, "wager_lamports"),
            },
            "challenge_accepted" => ServerEvent::ChallengeAccepted {
                challenge_id: str_field(value, "challenge_id"),
                match_id: str_field(value, "match_id"),
            },
            "challenge_cancelled" => ServerEvent::ChallengeCancelled {
                challenge_id: str_field(value, "challenge_id"),
            },
            "taunt_received" => ServerEvent::TauntReceived {
                match_id: str_field(value, "match_id"),
                agent_id: str_field(value, "agent_id"),
                agent_name: str_field(value, "agent_name"),
                taunt_id: str_field(value, "taunt_id"),
                taunt_text: str_field(value, "taunt_text"),
            },
            "pong" => ServerEvent::Pong,
            _ => ServerEvent::Unknown(value.clone()),
        }
    }
}

fn str_field(value: &serde_json::Value, field: &str) -> String {
    value
        .get(field)
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string()
}

fn u64_field(value: &serde_json::Value, field: &str) -> u64 {
    value.get(field).and_then(|v| v.as_u64()).unwrap_or(0)
}

fn u32_field(value: &serde_json::Value, field: &str) -> u32 {
    value
        .get(field)
        .and_then(|v| v.as_u64())
        .unwrap_or(0) as u32
}

fn parse_score(value: &serde_json::Value) -> [u32; 2] {
    parse_score_field(value, "score")
}

fn parse_score_field(value: &serde_json::Value, field: &str) -> [u32; 2] {
    value
        .get(field)
        .and_then(|v| v.as_array())
        .map(|arr| {
            let a = arr.first().and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            let b = arr.get(1).and_then(|v| v.as_u64()).unwrap_or(0) as u32;
            [a, b]
        })
        .unwrap_or([0, 0])
}

// ── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_authenticated() {
        let json = serde_json::json!({
            "type": "authenticated",
            "agent_id": "abc-123",
            "agent_name": "TestBot"
        });
        match ServerEvent::from_json(&json) {
            ServerEvent::Authenticated { agent_id, agent_name } => {
                assert_eq!(agent_id, "abc-123");
                assert_eq!(agent_name, "TestBot");
            }
            _ => panic!("Expected Authenticated"),
        }
    }

    #[test]
    fn parse_error() {
        let json = serde_json::json!({
            "type": "error",
            "code": "invalid_key",
            "message": "Bad API key"
        });
        match ServerEvent::from_json(&json) {
            ServerEvent::Error { code, message } => {
                assert_eq!(code, "invalid_key");
                assert_eq!(message, "Bad API key");
            }
            _ => panic!("Expected Error"),
        }
    }

    #[test]
    fn parse_match_found() {
        let json = serde_json::json!({
            "type": "match_found",
            "match_id": "m-1",
            "game_type": "rps",
            "opponent_id": "opp-1",
            "opponent_name": "Rival",
            "wager_lamports": 10_000_000,
            "server_seed_hash": "hash123"
        });
        match ServerEvent::from_json(&json) {
            ServerEvent::MatchFound {
                match_id,
                game_type,
                opponent_name,
                wager_lamports,
                ..
            } => {
                assert_eq!(match_id, "m-1");
                assert_eq!(game_type, GameType::Rps);
                assert_eq!(opponent_name, "Rival");
                assert_eq!(wager_lamports, 10_000_000);
            }
            _ => panic!("Expected MatchFound"),
        }
    }

    #[test]
    fn parse_your_turn() {
        let json = serde_json::json!({
            "type": "your_turn",
            "match_id": "m-1",
            "round": 2,
            "game_state": {"dealer_card": 7},
            "timeout_ms": 3000
        });
        match ServerEvent::from_json(&json) {
            ServerEvent::YourTurn {
                match_id,
                round,
                game_state,
                timeout_ms,
            } => {
                assert_eq!(match_id, "m-1");
                assert_eq!(round, 2);
                assert_eq!(game_state["dealer_card"], 7);
                assert_eq!(timeout_ms, 3000);
            }
            _ => panic!("Expected YourTurn"),
        }
    }

    #[test]
    fn parse_game_over() {
        let json = serde_json::json!({
            "type": "game_over",
            "match_id": "m-1",
            "winner": "abc-123",
            "final_score": [3, 2],
            "server_seed": "seed-xyz",
            "payout_lamports": 20_000_000,
            "fee_lamports": 200_000,
            "is_sandbox": false
        });
        match ServerEvent::from_json(&json) {
            ServerEvent::GameOver {
                match_id,
                winner,
                final_score,
                payout_lamports,
                fee_lamports,
                is_sandbox,
                ..
            } => {
                assert_eq!(match_id, "m-1");
                assert_eq!(winner, Some("abc-123".to_string()));
                assert_eq!(final_score, [3, 2]);
                assert_eq!(payout_lamports, 20_000_000);
                assert_eq!(fee_lamports, Some(200_000));
                assert_eq!(is_sandbox, Some(false));
            }
            _ => panic!("Expected GameOver"),
        }
    }

    #[test]
    fn parse_game_over_draw() {
        let json = serde_json::json!({
            "type": "game_over",
            "match_id": "m-1",
            "winner": null,
            "final_score": [2, 2],
            "server_seed": "seed-xyz",
            "payout_lamports": 10_000_000
        });
        match ServerEvent::from_json(&json) {
            ServerEvent::GameOver { winner, fee_lamports, is_sandbox, .. } => {
                assert!(winner.is_none());
                assert!(fee_lamports.is_none());
                assert!(is_sandbox.is_none());
            }
            _ => panic!("Expected GameOver"),
        }
    }

    #[test]
    fn parse_queue_update() {
        let json = serde_json::json!({
            "type": "queue_update",
            "game_type": "coinflip",
            "position": 3,
            "wait_time_ms": 45000,
            "search_radius": 50.0,
            "players_in_queue": 12,
            "players_online": 342
        });
        match ServerEvent::from_json(&json) {
            ServerEvent::QueueUpdate {
                position,
                players_in_queue,
                players_online,
                ..
            } => {
                assert_eq!(position, 3);
                assert_eq!(players_in_queue, 12);
                assert_eq!(players_online, 342);
            }
            _ => panic!("Expected QueueUpdate"),
        }
    }

    #[test]
    fn parse_session_replaced() {
        let json = serde_json::json!({"type": "session_replaced"});
        assert!(matches!(ServerEvent::from_json(&json), ServerEvent::SessionReplaced));
    }

    #[test]
    fn parse_unknown() {
        let json = serde_json::json!({"type": "future_event", "data": 42});
        assert!(matches!(ServerEvent::from_json(&json), ServerEvent::Unknown(_)));
    }

    #[test]
    fn serialize_client_commands() {
        let cmd = ClientCommand::JoinQueue {
            game_type: GameType::Coinflip,
            wager_lamports: 10_000_000,
            sandbox: false,
        };
        let json = serde_json::to_value(&cmd).unwrap();
        assert_eq!(json["type"], "join_queue");
        assert_eq!(json["game_type"], "coinflip");
        assert_eq!(json["wager_lamports"], 10_000_000);
        assert!(json.get("sandbox").is_none()); // skipped when false

        let cmd = ClientCommand::MakeMove {
            match_id: "m-1".into(),
            move_data: serde_json::json!({"choice": "heads"}),
        };
        let json = serde_json::to_value(&cmd).unwrap();
        assert_eq!(json["type"], "make_move");
        assert_eq!(json["move_data"]["choice"], "heads");
    }

    #[test]
    fn game_type_display() {
        assert_eq!(GameType::Coinflip.to_string(), "coinflip");
        assert_eq!(GameType::HighCardDuel.to_string(), "high_card_duel");
        assert_eq!(GameType::ReactionRing.to_string(), "reaction_ring");
    }

    #[test]
    fn parse_taunt_received() {
        let json = serde_json::json!({
            "type": "taunt_received",
            "match_id": "m-1",
            "agent_id": "a-1",
            "agent_name": "Trash Talker",
            "taunt_id": "t-1",
            "taunt_text": "GG EZ"
        });
        match ServerEvent::from_json(&json) {
            ServerEvent::TauntReceived { agent_name, taunt_text, .. } => {
                assert_eq!(agent_name, "Trash Talker");
                assert_eq!(taunt_text, "GG EZ");
            }
            _ => panic!("Expected TauntReceived"),
        }
    }

    #[test]
    fn parse_challenge_events() {
        let json = serde_json::json!({
            "type": "challenge_created",
            "challenge_id": "c-1",
            "game_type": "crash",
            "wager_lamports": 50_000_000
        });
        match ServerEvent::from_json(&json) {
            ServerEvent::ChallengeCreated { challenge_id, game_type, wager_lamports } => {
                assert_eq!(challenge_id, "c-1");
                assert_eq!(game_type, GameType::Crash);
                assert_eq!(wager_lamports, 50_000_000);
            }
            _ => panic!("Expected ChallengeCreated"),
        }

        let json = serde_json::json!({
            "type": "challenge_accepted",
            "challenge_id": "c-1",
            "match_id": "m-99"
        });
        match ServerEvent::from_json(&json) {
            ServerEvent::ChallengeAccepted { challenge_id, match_id } => {
                assert_eq!(challenge_id, "c-1");
                assert_eq!(match_id, "m-99");
            }
            _ => panic!("Expected ChallengeAccepted"),
        }
    }

    #[test]
    fn parse_round_result() {
        let json = serde_json::json!({
            "type": "round_result",
            "match_id": "m-1",
            "round": 1,
            "result": {"opponent_choice": "rock"},
            "score": [1, 0]
        });
        match ServerEvent::from_json(&json) {
            ServerEvent::RoundResult { round, result, score, .. } => {
                assert_eq!(round, 1);
                assert_eq!(result["opponent_choice"], "rock");
                assert_eq!(score, [1, 0]);
            }
            _ => panic!("Expected RoundResult"),
        }
    }

    #[test]
    fn parse_game_start() {
        let json = serde_json::json!({
            "type": "game_start",
            "match_id": "m-1",
            "your_side": "b"
        });
        match ServerEvent::from_json(&json) {
            ServerEvent::GameStart { your_side, .. } => {
                assert_eq!(your_side, Side::B);
            }
            _ => panic!("Expected GameStart"),
        }
    }
}
