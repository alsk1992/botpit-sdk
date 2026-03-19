//! Example: Crash Agent with Risk-Based Cashout Strategy
//!
//! Uses a configurable risk profile to determine cashout multiplier.
//! Conservative (1.5x) vs aggressive (3.0x) modes.
//!
//! Usage:
//!   BOTPIT_API_KEY=bp_sk_... cargo run --example crash
//!   BOTPIT_API_KEY=bp_sk_... CRASH_MODE=aggressive cargo run --example crash

use botpit::{BotpitClient, GameType, ServerEvent};

const WAGER_SOL: f64 = 0.01;

struct CrashStrategy {
    mode: &'static str,
    base_cashout: f64,
    min_cashout: f64,
    max_cashout: f64,
    wins: u32,
    losses: u32,
}

impl CrashStrategy {
    fn conservative() -> Self {
        Self {
            mode: "conservative",
            base_cashout: 1.5,
            min_cashout: 1.2,
            max_cashout: 2.5,
            wins: 0,
            losses: 0,
        }
    }

    fn aggressive() -> Self {
        Self {
            mode: "aggressive",
            base_cashout: 3.0,
            min_cashout: 2.0,
            max_cashout: 6.0,
            wins: 0,
            losses: 0,
        }
    }

    fn next_cashout(&self) -> f64 {
        // After consecutive losses, lower cashout for safer wins
        // After consecutive wins, push cashout higher
        let total = self.wins + self.losses;
        if total == 0 {
            return self.base_cashout;
        }

        let win_rate = self.wins as f64 / total as f64;
        let adjustment = if win_rate > 0.6 {
            // Winning streak — push higher
            1.0 + (win_rate - 0.5) * 2.0
        } else if win_rate < 0.4 {
            // Losing streak — play safer
            0.7 + win_rate
        } else {
            1.0
        };

        (self.base_cashout * adjustment)
            .max(self.min_cashout)
            .min(self.max_cashout)
    }

    fn record_result(&mut self, won: bool) {
        if won {
            self.wins += 1;
        } else {
            self.losses += 1;
        }
    }
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt::init();

    let api_key = std::env::var("BOTPIT_API_KEY").expect("Set BOTPIT_API_KEY environment variable");

    let mode = std::env::var("CRASH_MODE").unwrap_or_else(|_| "conservative".into());
    let mut strategy = if mode == "aggressive" {
        CrashStrategy::aggressive()
    } else {
        CrashStrategy::conservative()
    };

    println!("Crash agent starting in {} mode", strategy.mode);

    let (mut events, cmd) = BotpitClient::builder(&api_key).build().connect().await?;

    cmd.join_queue(GameType::Crash, WAGER_SOL, false);

    while let Some(event) = events.recv().await {
        match event {
            ServerEvent::Authenticated { agent_name, .. } => {
                println!("Playing as {agent_name}");
            }
            ServerEvent::MatchFound {
                opponent_name,
                wager_lamports,
                ..
            } => {
                println!(
                    "Match vs {opponent_name} | {:.4} SOL",
                    wager_lamports as f64 / 1e9
                );
            }
            ServerEvent::YourTurn {
                match_id, round, ..
            } => {
                let cashout = strategy.next_cashout();
                // Round to 2 decimal places
                let cashout = (cashout * 100.0).round() / 100.0;
                println!("Round {round}: setting cashout at {cashout:.2}x");
                cmd.make_move(&match_id, serde_json::json!({"cashout_at": cashout}));
            }
            ServerEvent::RoundResult {
                round,
                result,
                score,
                ..
            } => {
                println!(
                    "Round {round}: {result} | Score: {}-{}",
                    score[0], score[1]
                );
            }
            ServerEvent::GameOver {
                winner,
                final_score,
                payout_lamports,
                ..
            } => {
                let won = winner.is_some();
                strategy.record_result(won);

                if won {
                    println!(
                        "WON! +{:.4} SOL | Record: {}-{}",
                        payout_lamports as f64 / 1e9,
                        strategy.wins,
                        strategy.losses
                    );
                } else {
                    println!(
                        "Lost! | Record: {}-{} | Final: {}-{}",
                        strategy.wins, strategy.losses, final_score[0], final_score[1]
                    );
                }

                cmd.join_queue(GameType::Crash, WAGER_SOL, false);
            }
            ServerEvent::Error { code, message } => {
                eprintln!("Error [{code}]: {message}");
            }
            _ => {}
        }
    }

    Ok(())
}
