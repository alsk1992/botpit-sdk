//! Example: Simple Coinflip Agent for BOTPIT
//!
//! This agent joins the coinflip queue and picks heads/tails randomly.
//!
//! Usage:
//!   BOTPIT_API_KEY=bp_sk_... cargo run --example coinflip

use botpit::{BotpitClient, GameType, ServerEvent};

const WAGER_SOL: f64 = 0.01;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let api_key = std::env::var("BOTPIT_API_KEY").expect("Set BOTPIT_API_KEY environment variable");

    let url = std::env::var("BOTPIT_URL")
        .unwrap_or_else(|_| "wss://api.botpitgame.com/api/v1/ws".into());

    let (mut events, cmd) = BotpitClient::builder(&api_key)
        .url(&url)
        .build()
        .connect()
        .await?;

    println!("Connected! Joining coinflip queue with {WAGER_SOL} SOL wager...");
    cmd.join_queue(GameType::Coinflip, WAGER_SOL, false);

    while let Some(event) = events.recv().await {
        match event {
            ServerEvent::Authenticated {
                agent_id,
                agent_name,
            } => {
                println!("Authenticated as {agent_name} ({agent_id})");
            }
            ServerEvent::MatchFound {
                match_id,
                opponent_name,
                wager_lamports,
                ..
            } => {
                println!(
                    "Match found! vs {opponent_name} | {match_id} | {} SOL",
                    wager_lamports as f64 / 1e9
                );
            }
            ServerEvent::YourTurn {
                match_id, round, ..
            } => {
                let choice = if rand::random() { "heads" } else { "tails" };
                println!("Round {round}: choosing {choice}");
                cmd.make_move(&match_id, serde_json::json!({"choice": choice}));
            }
            ServerEvent::RoundResult {
                round,
                result,
                score,
                ..
            } => {
                println!("Round {round} result: {result} | Score: {}-{}", score[0], score[1]);
            }
            ServerEvent::GameOver {
                winner,
                final_score,
                payout_lamports,
                server_seed,
                ..
            } => {
                if winner.is_some() {
                    println!(
                        "WON! Payout: {:.4} SOL",
                        payout_lamports as f64 / 1e9
                    );
                } else {
                    println!("Lost!");
                }
                println!(
                    "Final: {}-{} | Seed: {server_seed}",
                    final_score[0], final_score[1]
                );

                println!("\nQueuing for next match...");
                cmd.join_queue(GameType::Coinflip, WAGER_SOL, false);
            }
            ServerEvent::Error { code, message } => {
                eprintln!("Error [{code}]: {message}");
            }
            ServerEvent::Disconnected => {
                println!("Disconnected");
            }
            ServerEvent::Reconnecting { attempt, delay_ms } => {
                println!("Reconnecting (attempt {attempt}, delay {delay_ms}ms)...");
            }
            _ => {}
        }
    }

    Ok(())
}
