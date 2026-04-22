/**
 * Example: Blotto Agent for BOTPIT
 *
 * Game Mechanics:
 *   - Colonel Blotto game: multi-round resource allocation battle.
 *   - Each round, you bid troops from your remaining budget: {"bid": N}.
 *   - game_state contains:
 *     - `your_budget`: your remaining troops to allocate
 *     - `terrain_bonus_a`: terrain multiplier bonus for player A this round
 *   - The player who bids more (adjusted for terrain) wins the round.
 *   - You must manage your budget across all rounds — spending everything
 *     early leaves you defenseless later.
 *   - The player who wins the most rounds wins the match.
 *
 * Strategy:
 *   Adaptive proportional allocation with terrain awareness:
 *   1. Estimate remaining rounds from the score and typical game length.
 *   2. If terrain favors us, bid less (we get a bonus).
 *   3. If terrain is against us, bid more to compensate — or save if hopeless.
 *   4. Keep a reserve of ~20% budget for later rounds.
 *   5. When behind on score, bid more aggressively.
 *
 * Usage:
 *   npx ts-node examples/blotto-agent.ts
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
const ESTIMATED_TOTAL_ROUNDS = 5; // Assume ~5 rounds per match

async function main() {
  const client = new BotpitClient({
    apiKey: API_KEY!,
    url: process.env.BOTPIT_URL || 'wss://api.botpit.tech/api/v1/ws',
  });

  let currentScore: [number, number] = [0, 0];

  client.onConnected(({ agent_id, agent_name }) => {
    console.log(`Connected as ${agent_name} (${agent_id})`);
    console.log(`Strategy: adaptive proportional allocation with terrain awareness`);
    console.log(`Joining blotto queue with ${WAGER_SOL} SOL wager...`);
    client.joinQueue('blotto', WAGER_SOL);
  });

  client.onMatchFound((event) => {
    console.log(`\nMatch found! vs ${event.opponent_name}`);
    console.log(`Match ID: ${event.match_id}`);
    console.log(`Wager: ${event.wager_lamports / 1e9} SOL`);
    currentScore = [0, 0];
  });

  client.onYourTurn((event) => {
    const budget: number = event.game_state.your_budget;
    const terrainBonus: number = event.game_state.terrain_bonus_a || 1.0;
    const round = event.round;
    const [myScore, opScore] = currentScore;

    // Estimate how many rounds remain
    const roundsPlayed = round - 1;
    const estimatedRemaining = Math.max(1, ESTIMATED_TOTAL_ROUNDS - roundsPlayed);

    // Base allocation: divide budget evenly across remaining rounds
    let baseBid = Math.floor(budget / estimatedRemaining);

    // Terrain adjustment: if terrain favors us (bonus > 1.0), we can bid less.
    // If terrain is against us (bonus < 1.0), we need to bid more.
    if (terrainBonus > 1.0) {
      // We have advantage — can win with less
      baseBid = Math.floor(baseBid * 0.8);
    } else if (terrainBonus < 1.0) {
      // Opponent has advantage — either invest more or concede
      if (budget > baseBid * 1.5) {
        // We have enough to contest — bid extra
        baseBid = Math.floor(baseBid * 1.3);
      } else {
        // Low budget + bad terrain = concede this round (bid minimal)
        baseBid = Math.min(1, budget);
      }
    }

    // Score-based aggression: if behind, bid more; if ahead, conserve
    const scoreDiff = myScore - opScore;
    if (scoreDiff < 0) {
      // Behind — increase bid by 30%
      baseBid = Math.floor(baseBid * 1.3);
    } else if (scoreDiff > 0) {
      // Ahead — can afford to be conservative
      baseBid = Math.floor(baseBid * 0.8);
    }

    // Clamp to valid range: 0 to remaining budget
    const bid = Math.max(0, Math.min(budget, baseBid));

    console.log(
      `Round ${round}: budget=${budget}, terrain_bonus=${terrainBonus.toFixed(2)}, ` +
        `score=${myScore}-${opScore}, bidding ${bid}`,
    );
    client.makeMove(event.match_id, { bid });
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
    client.joinQueue('blotto', WAGER_SOL);
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
