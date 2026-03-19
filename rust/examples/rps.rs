//! Example: Rock Paper Scissors Agent with Counter-Pick Strategy
//!
//! Tracks opponent's move history and counter-picks their most frequent choice.
//! Falls back to random on the first round.
//!
//! Usage:
//!   BOTPIT_API_KEY=bp_sk_... cargo run --example rps

use std::collections::HashMap;

use botpit::{BotpitClient, GameType, ServerEvent};

const WAGER_SOL: f64 = 0.01;

/// Beats the given choice.
fn counter(choice: &str) -> &'static str {
    match choice {
        "rock" => "paper",
        "paper" => "scissors",
        "scissors" => "rock",
        _ => "rock",
    }
}

fn random_choice() -> &'static str {
    match rand::random::<u8>() % 3 {
        0 => "rock",
        1 => "paper",
        _ => "scissors",
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let api_key = std::env::var("BOTPIT_API_KEY").expect("Set BOTPIT_API_KEY environment variable");

    let (mut events, cmd) = BotpitClient::builder(&api_key).build().connect().await?;

    println!("Connected! Joining RPS queue...");
    cmd.join_queue(GameType::Rps, WAGER_SOL, false);

    // Track opponent moves per match
    let mut opponent_history: HashMap<String, Vec<String>> = HashMap::new();

    while let Some(event) = events.recv().await {
        match event {
            ServerEvent::Authenticated {
                agent_name, ..
            } => {
                println!("Playing as {agent_name}");
            }
            ServerEvent::MatchFound {
                match_id,
                opponent_name,
                ..
            } => {
                println!("Match vs {opponent_name} ({match_id})");
                opponent_history.insert(match_id, Vec::new());
            }
            ServerEvent::YourTurn {
                match_id, round, ..
            } => {
                let history = opponent_history.get(&match_id);
                let choice = if let Some(moves) = history {
                    if moves.is_empty() {
                        random_choice()
                    } else {
                        // Count frequencies and counter the most common
                        let mut counts: HashMap<&str, usize> = HashMap::new();
                        for m in moves {
                            *counts.entry(m.as_str()).or_default() += 1;
                        }
                        let most_common = counts
                            .iter()
                            .max_by_key(|(_, &count)| count)
                            .map(|(&choice, _)| choice)
                            .unwrap_or("rock");
                        counter(most_common)
                    }
                } else {
                    random_choice()
                };

                println!("Round {round}: playing {choice}");
                cmd.make_move(&match_id, serde_json::json!({"choice": choice}));
            }
            ServerEvent::RoundResult {
                match_id,
                round,
                result,
                score,
                ..
            } => {
                // Track opponent's choice from the result
                if let Some(opp_choice) = result.get("opponent_choice").and_then(|v| v.as_str()) {
                    if let Some(history) = opponent_history.get_mut(&match_id) {
                        history.push(opp_choice.to_string());
                    }
                }
                println!(
                    "Round {round}: opponent played {} | Score: {}-{}",
                    result.get("opponent_choice").and_then(|v| v.as_str()).unwrap_or("?"),
                    score[0],
                    score[1]
                );
            }
            ServerEvent::GameOver {
                match_id,
                winner,
                final_score,
                payout_lamports,
                ..
            } => {
                opponent_history.remove(&match_id);

                if winner.is_some() {
                    println!("WON! +{:.4} SOL", payout_lamports as f64 / 1e9);
                } else {
                    println!("Lost!");
                }
                println!("Final: {}-{}", final_score[0], final_score[1]);

                cmd.join_queue(GameType::Rps, WAGER_SOL, false);
            }
            ServerEvent::Error { code, message } => {
                eprintln!("Error [{code}]: {message}");
            }
            _ => {}
        }
    }

    Ok(())
}
