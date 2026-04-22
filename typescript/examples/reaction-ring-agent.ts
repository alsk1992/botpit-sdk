/**
 * Example: Reaction Ring Agent for BOTPIT
 *
 * Game Mechanics:
 *   - Each round, a hidden target number (1-1000) is generated.
 *   - Both players submit a guess: {"guess": N} where N is 1-1000.
 *   - The player whose guess is closest to the hidden target wins the round.
 *   - Best-of series determines the winner.
 *   - No game_state information about the target is given — it's truly hidden.
 *
 * Strategy:
 *   Without any information about the target, the optimal strategy is to
 *   guess the median (500) every time — this minimizes maximum error.
 *   However, if the opponent always guesses 500 too, we need to vary.
 *
 *   We use a mixed strategy:
 *   - 60% of the time: guess near the center (450-550) for consistent performance
 *   - 25% of the time: guess in the lower range (200-400) to beat center-guessers
 *     when the target is low
 *   - 15% of the time: guess in the upper range (600-800) for the same reason
 *
 *   This spreads coverage across the range while favoring the statistically
 *   optimal center.
 *
 * Usage:
 *   npx ts-node examples/reaction-ring-agent.ts
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

function pickGuess(): number {
  const roll = Math.random();

  if (roll < 0.60) {
    // Center cluster: 450-550
    return Math.floor(450 + Math.random() * 100);
  } else if (roll < 0.85) {
    // Lower range: 200-400
    return Math.floor(200 + Math.random() * 200);
  } else {
    // Upper range: 600-800
    return Math.floor(600 + Math.random() * 200);
  }
}

async function main() {
  const client = new BotpitClient({
    apiKey: API_KEY!,
    url: process.env.BOTPIT_URL || 'wss://api.botpit.tech/api/v1/ws',
  });

  client.onConnected(({ agent_id, agent_name }) => {
    console.log(`Connected as ${agent_name} (${agent_id})`);
    console.log(`Strategy: mixed range coverage centered around 500`);
    console.log(`Joining reaction_ring queue with ${WAGER_SOL} SOL wager...`);
    client.joinQueue('reaction_ring', WAGER_SOL);
  });

  client.onMatchFound((event) => {
    console.log(`\nMatch found! vs ${event.opponent_name}`);
    console.log(`Match ID: ${event.match_id}`);
    console.log(`Wager: ${event.wager_lamports / 1e9} SOL`);
  });

  client.onYourTurn((event) => {
    const guess = pickGuess();
    console.log(`Round ${event.round}: guessing ${guess}`);
    client.makeMove(event.match_id, { guess });
  });

  client.onRoundResult((event) => {
    console.log(`Round ${event.round} result:`, event.result);
    if (event.result?.target) {
      console.log(`  Hidden target was: ${event.result.target}`);
    }
    console.log(`Score: ${event.score[0]} - ${event.score[1]}`);
  });

  client.onGameOver((event) => {
    const won = event.winner !== null;
    console.log(won ? `WON! Payout: ${event.payout_lamports / 1e9} SOL` : 'Lost!');
    console.log(`Final score: ${event.final_score[0]} - ${event.final_score[1]}`);
    console.log(`Server seed: ${event.server_seed}`);

    console.log('\nQueuing for next match...');
    client.joinQueue('reaction_ring', WAGER_SOL);
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
