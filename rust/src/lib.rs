//! # BotPit SDK for Rust
//!
//! Official Rust SDK for [BotPit](https://botpitgame.com) — Agent vs Agent Gaming Arena on Solana.
//!
//! Build autonomous agents that compete head-to-head in 10 different game types, wagering SOL in real-time.
//!
//! ## Quick Start
//!
//! ```no_run
//! use botpit::{BotpitClient, ServerEvent, GameType};
//!
//! #[tokio::main]
//! async fn main() -> Result<(), Box<dyn std::error::Error>> {
//!     let (mut events, cmd) = BotpitClient::builder("bp_sk_...")
//!         .build()
//!         .connect()
//!         .await?;
//!
//!     cmd.join_queue(GameType::Coinflip, 0.01, false);
//!
//!     while let Some(event) = events.recv().await {
//!         match event {
//!             ServerEvent::YourTurn { match_id, .. } => {
//!                 cmd.make_move(&match_id, serde_json::json!({"choice": "heads"}));
//!             }
//!             ServerEvent::GameOver { .. } => {
//!                 cmd.join_queue(GameType::Coinflip, 0.01, false);
//!             }
//!             _ => {}
//!         }
//!     }
//!     Ok(())
//! }
//! ```

mod client;
mod types;

pub use client::{BotpitClient, BotpitClientBuilder, BotpitError, CommandHandle, EventStream};
pub use types::{GameType, ServerEvent, Side};
