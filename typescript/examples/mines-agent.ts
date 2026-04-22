/**
 * Example: Mines Agent for BOTPIT
 *
 * Game Mechanics:
 *   - 5x5 grid with 5 hidden mines (20 safe tiles out of 25).
 *   - You choose how many tiles to reveal (1-20).
 *   - If all revealed tiles are safe, you score based on how many you chose.
 *   - More tiles = higher reward but higher risk of hitting a mine.
 *   - Both players pick independently; the one who reveals more tiles safely
 *     (or crashes less) wins.
 *
 * Strategy:
 *   Risk-calibrated tile selection. The probability of safely revealing N
 *   tiles from a grid with 20 safe out of 25 total is:
 *     P(N safe) = C(20,N) / C(25,N)
 *
 *   Probabilities for key values:
 *     N=5:  ~25.4% survival    (very aggressive)
 *     N=8:  ~5.5% survival     (high risk)
 *     N=3:  ~49.6% survival    (moderate)
 *     N=2:  ~63.3% survival    (conservative)
 *     N=1:  ~80.0% survival    (very safe)
 *
 *   We use a moderate approach: usually pick 2-3 tiles (safe), sometimes
 *   push to 5 tiles for higher reward when we're behind on score.
 *
 * Usage:
 *   npx ts-node examples/mines-agent.ts
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

// Strategy tiers
const SAFE_TILES = 2;       // ~63% survival, low reward
const MODERATE_TILES = 3;   // ~50% survival, decent reward
const AGGRESSIVE_TILES = 5; // ~25% survival, high reward

async function main() {
  const client = new BotpitClient({
    apiKey: API_KEY!,
    url: process.env.BOTPIT_URL || 'wss://api.botpit.tech/api/v1/ws',
  });

  let currentScore: [number, number] = [0, 0];

  client.onConnected(({ agent_id, agent_name }) => {
    console.log(`Connected as ${agent_name} (${agent_id})`);
    console.log(`Strategy: ${SAFE_TILES} tiles (safe), ${MODERATE_TILES} (moderate), ${AGGRESSIVE_TILES} (aggressive when behind)`);
    console.log(`Joining mines queue with ${WAGER_SOL} SOL wager...`);
    client.joinQueue('mines', WAGER_SOL);
  });

  client.onMatchFound((event) => {
    console.log(`\nMatch found! vs ${event.opponent_name}`);
    console.log(`Match ID: ${event.match_id}`);
    console.log(`Wager: ${event.wager_lamports / 1e9} SOL`);
    currentScore = [0, 0];
  });

  client.onYourTurn((event) => {
    const [myScore, opScore] = currentScore;
    let tiles: number;

    if (myScore < opScore) {
      // Behind on score — take more risk to catch up
      tiles = AGGRESSIVE_TILES;
      console.log(`Round ${event.round}: behind ${myScore}-${opScore}, going aggressive with ${tiles} tiles`);
    } else if (myScore > opScore) {
      // Ahead — play it safe to protect lead
      tiles = SAFE_TILES;
      console.log(`Round ${event.round}: leading ${myScore}-${opScore}, playing safe with ${tiles} tiles`);
    } else {
      // Tied — moderate risk
      tiles = MODERATE_TILES;
      console.log(`Round ${event.round}: tied ${myScore}-${opScore}, moderate risk with ${tiles} tiles`);
    }

    client.makeMove(event.match_id, { tiles });
  });

  client.onRoundResult((event) => {
    console.log(`Round ${event.round} result:`, event.result);
    console.log(`Score: ${event.score[0]} - ${event.score[1]}`);
    currentScore = event.score;
  });

  client.onGameOver((event) => {
    const won = event.winner !== null;
    console.log(won ? `WON! Payout: ${event.payout_lamports / 1e9} SOL` : 'Lost!');
    console.log(`Final score: ${event.final_score[0]} - ${event.final_score[1]}`);
    console.log(`Server seed: ${event.server_seed}`);

    console.log('\nQueuing for next match...');
    client.joinQueue('mines', WAGER_SOL);
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
