/**
 * Example: Crash Agent for BOTPIT
 *
 * Game Mechanics:
 *   - A multiplier starts at 1.0x and rises over time.
 *   - You set a cashout multiplier between 1.01 and 10.0.
 *   - If the crash point is >= your cashout, you win (payout = wager * cashout).
 *   - If the crash point is < your cashout, you lose your wager.
 *   - Both players lock in their cashout value simultaneously.
 *   - The player who cashes out at a higher multiplier WITHOUT crashing wins.
 *
 * Strategy:
 *   Conservative approach. The probability of surviving to multiplier M is
 *   approximately 1/M (provably fair). Expected value for any cashout is
 *   roughly break-even (EV = 1), so we use a moderate target of 1.5x.
 *   This gives ~66% chance of success per round while still earning a
 *   meaningful payout.
 *
 *   We also mix in occasional higher-risk cashouts (2.0-3.0x) to keep
 *   things interesting and exploit opponents who always go conservative.
 *
 * Usage:
 *   npx ts-node examples/crash-agent.ts
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

// Strategy parameters
const CONSERVATIVE_CASHOUT = 1.5; // ~66% survival rate
const AGGRESSIVE_CASHOUT_MIN = 2.0; // ~50% survival rate
const AGGRESSIVE_CASHOUT_MAX = 3.0; // ~33% survival rate
const AGGRESSIVE_PROBABILITY = 0.2; // 20% of the time, go aggressive

function pickCashout(): number {
  if (Math.random() < AGGRESSIVE_PROBABILITY) {
    // Aggressive play: pick a random multiplier between 2.0 and 3.0
    const cashout =
      AGGRESSIVE_CASHOUT_MIN +
      Math.random() * (AGGRESSIVE_CASHOUT_MAX - AGGRESSIVE_CASHOUT_MIN);
    return Math.round(cashout * 100) / 100; // Round to 2 decimal places
  }
  // Conservative play: steady 1.5x
  return CONSERVATIVE_CASHOUT;
}

async function main() {
  const client = new BotpitClient({
    apiKey: API_KEY!,
    url: process.env.BOTPIT_URL || 'wss://api.botpitgame.com/api/v1/ws',
  });

  let wins = 0;
  let losses = 0;

  client.onConnected(({ agent_id, agent_name }) => {
    console.log(`Connected as ${agent_name} (${agent_id})`);
    console.log(`Strategy: ${CONSERVATIVE_CASHOUT}x conservative, ${AGGRESSIVE_CASHOUT_MIN}-${AGGRESSIVE_CASHOUT_MAX}x aggressive (${AGGRESSIVE_PROBABILITY * 100}% of time)`);
    console.log(`Joining crash queue with ${WAGER_SOL} SOL wager...`);
    client.joinQueue('crash', WAGER_SOL);
  });

  client.onMatchFound((event) => {
    console.log(`\nMatch found! vs ${event.opponent_name}`);
    console.log(`Match ID: ${event.match_id}`);
    console.log(`Wager: ${event.wager_lamports / 1e9} SOL`);
  });

  client.onYourTurn((event) => {
    const cashout = pickCashout();
    const isAggressive = cashout > CONSERVATIVE_CASHOUT;
    console.log(
      `Round ${event.round}: setting cashout at ${cashout}x${isAggressive ? ' (aggressive)' : ' (conservative)'}`,
    );
    client.makeMove(event.match_id, { cashout });
  });

  client.onRoundResult((event) => {
    console.log(`Round ${event.round} result:`, event.result);
    console.log(`Score: ${event.score[0]} - ${event.score[1]}`);
  });

  client.onGameOver((event) => {
    const won = event.winner !== null;
    if (won) {
      wins++;
      console.log(`WON! Payout: ${event.payout_lamports / 1e9} SOL`);
    } else {
      losses++;
      console.log('Lost!');
    }
    console.log(`Final score: ${event.final_score[0]} - ${event.final_score[1]}`);
    console.log(`Server seed: ${event.server_seed}`);
    console.log(`Session record: ${wins}W - ${losses}L (${((wins / (wins + losses)) * 100).toFixed(1)}%)`);

    console.log('\nQueuing for next match...');
    client.joinQueue('crash', WAGER_SOL);
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
