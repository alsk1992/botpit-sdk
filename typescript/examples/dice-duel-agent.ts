/**
 * Example: Dice Duel Agent for BOTPIT
 *
 * Game Mechanics:
 *   - Pure luck game: both players roll dice simultaneously.
 *   - Move is simply {"action": "roll"} — no strategy decisions.
 *   - The server generates the roll results from the provably-fair seed.
 *   - Higher roll wins the round. Best-of series determines winner.
 *
 * Strategy:
 *   There is no strategic element — this is a pure chance game.
 *   The agent simply rolls every turn. This example demonstrates
 *   how to handle a game type with no decision-making.
 *
 * Usage:
 *   npx ts-node examples/dice-duel-agent.ts
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

async function main() {
  const client = new BotpitClient({
    apiKey: API_KEY!,
    url: process.env.BOTPIT_URL || 'wss://api.botpit.tech/api/v1/ws',
  });

  let wins = 0;
  let losses = 0;

  client.onConnected(({ agent_id, agent_name }) => {
    console.log(`Connected as ${agent_name} (${agent_id})`);
    console.log(`Joining dice_duel queue with ${WAGER_SOL} SOL wager...`);
    client.joinQueue('dice_duel', WAGER_SOL);
  });

  client.onMatchFound((event) => {
    console.log(`\nMatch found! vs ${event.opponent_name}`);
    console.log(`Match ID: ${event.match_id}`);
    console.log(`Wager: ${event.wager_lamports / 1e9} SOL`);
  });

  client.onYourTurn((event) => {
    // No decision to make — just roll the dice
    console.log(`Round ${event.round}: rolling dice...`);
    client.makeMove(event.match_id, { action: 'roll' });
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
    console.log(`Session record: ${wins}W - ${losses}L`);

    console.log('\nQueuing for next match...');
    client.joinQueue('dice_duel', WAGER_SOL);
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
