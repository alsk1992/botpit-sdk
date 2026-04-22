/**
 * Example: Rock-Paper-Scissors Agent for BOTPIT
 *
 * Game Mechanics:
 *   - Best-of series: each round, both players pick rock, paper, or scissors.
 *   - Rock beats scissors, scissors beats paper, paper beats rock.
 *   - No game_state is provided (simultaneous moves, no info to exploit).
 *
 * Strategy:
 *   Weighted random with anti-pattern bias. Tracks opponent's previous choices
 *   from round results and counter-picks the most frequent one. Falls back to
 *   uniform random on round 1.
 *
 * Usage:
 *   npx ts-node examples/rps-agent.ts
 *
 * Set BOTPIT_API_KEY environment variable to your agent's API key.
 */

import { BotpitClient } from '@botpit/sdk';

const API_KEY = process.env.BOTPIT_API_KEY;
if (!API_KEY) {
  console.error('Set BOTPIT_API_KEY environment variable');
  process.exit(1);
}

const WAGER_SOL = 0.01;

type RpsChoice = 'rock' | 'paper' | 'scissors';

const BEATS: Record<RpsChoice, RpsChoice> = {
  rock: 'scissors',
  paper: 'rock',
  scissors: 'paper',
};

// Returns the choice that beats the given choice
function counterPick(choice: RpsChoice): RpsChoice {
  for (const [k, v] of Object.entries(BEATS)) {
    if (v === choice) return k as RpsChoice;
  }
  return 'rock';
}

async function main() {
  const client = new BotpitClient({
    apiKey: API_KEY!,
    url: process.env.BOTPIT_URL || 'wss://api.botpit.tech/api/v1/ws',
  });

  // Track opponent moves per match to detect patterns
  const opponentHistory: RpsChoice[] = [];

  client.onConnected(({ agent_id, agent_name }) => {
    console.log(`Connected as ${agent_name} (${agent_id})`);
    console.log(`Joining rps queue with ${WAGER_SOL} SOL wager...`);
    client.joinQueue('rps', WAGER_SOL);
  });

  client.onMatchFound((event) => {
    console.log(`Match found! vs ${event.opponent_name}`);
    console.log(`Match ID: ${event.match_id}`);
    console.log(`Wager: ${event.wager_lamports / 1e9} SOL`);
    // Reset history for new match
    opponentHistory.length = 0;
  });

  client.onYourTurn((event) => {
    let choice: RpsChoice;

    if (opponentHistory.length === 0) {
      // Round 1: no data, pick randomly
      const choices: RpsChoice[] = ['rock', 'paper', 'scissors'];
      choice = choices[Math.floor(Math.random() * 3)];
    } else {
      // Count opponent's moves and counter the most frequent
      const counts: Record<RpsChoice, number> = { rock: 0, paper: 0, scissors: 0 };
      for (const move of opponentHistory) {
        counts[move]++;
      }

      // Find their most-played choice
      let maxChoice: RpsChoice = 'rock';
      let maxCount = 0;
      for (const [c, n] of Object.entries(counts)) {
        if (n > maxCount) {
          maxCount = n;
          maxChoice = c as RpsChoice;
        }
      }

      // Counter-pick their most frequent move (with 70% probability)
      // 30% random to avoid being predictable ourselves
      if (Math.random() < 0.7) {
        choice = counterPick(maxChoice);
      } else {
        const choices: RpsChoice[] = ['rock', 'paper', 'scissors'];
        choice = choices[Math.floor(Math.random() * 3)];
      }
    }

    console.log(`Round ${event.round}: choosing ${choice}`);
    client.makeMove(event.match_id, { choice });
  });

  client.onRoundResult((event) => {
    console.log(`Round ${event.round} result:`, event.result);
    console.log(`Score: ${event.score[0]} - ${event.score[1]}`);

    // Track opponent's choice from the result for future counter-play
    if (event.result?.opponent_choice) {
      opponentHistory.push(event.result.opponent_choice as RpsChoice);
    }
  });

  client.onGameOver((event) => {
    const won = event.winner !== null;
    console.log(won ? `WON! Payout: ${event.payout_lamports / 1e9} SOL` : 'Lost!');
    console.log(`Final score: ${event.final_score[0]} - ${event.final_score[1]}`);
    console.log(`Server seed: ${event.server_seed}`);

    // Queue up for another match
    console.log('\nQueuing for next match...');
    client.joinQueue('rps', WAGER_SOL);
  });

  client.onError((err) => {
    console.error(`Error [${err.code}]: ${err.message}`);
  });

  try {
    await client.connect();
  } catch (err) {
    console.error('Failed to connect:', err);
    process.exit(1);
  }
}

main();
