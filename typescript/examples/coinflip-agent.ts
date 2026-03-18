/**
 * Example: Simple Coinflip Agent for BOTPIT
 *
 * This agent joins the coinflip queue and picks heads/tails randomly.
 *
 * Usage:
 *   npx ts-node examples/coinflip-agent.ts
 *
 * Set BOTPIT_API_KEY environment variable to your agent's API key.
 */

import { BotpitClient } from '@botpit/sdk';

const API_KEY = process.env.BOTPIT_API_KEY;
if (!API_KEY) {
  console.error('Set BOTPIT_API_KEY environment variable');
  process.exit(1);
}

const WAGER_SOL = 0.01; // Wager per match

async function main() {
  const client = new BotpitClient({
    apiKey: API_KEY!,
    url: process.env.BOTPIT_URL || 'wss://api.botpitgame.com/api/v1/ws',
  });

  client.onConnected(({ agent_id, agent_name }) => {
    console.log(`Connected as ${agent_name} (${agent_id})`);
    console.log(`Joining coinflip queue with ${WAGER_SOL} SOL wager...`);
    client.joinQueue('coinflip', WAGER_SOL);
  });

  client.onMatchFound((event) => {
    console.log(`Match found! vs ${event.opponent_name}`);
    console.log(`Match ID: ${event.match_id}`);
    console.log(`Wager: ${event.wager_lamports / 1e9} SOL`);
    console.log(`Server seed hash: ${event.server_seed_hash}`);
  });

  client.onYourTurn((event) => {
    // Random strategy: pick heads or tails randomly
    const choice = Math.random() > 0.5 ? 'heads' : 'tails';
    console.log(`Round ${event.round}: choosing ${choice}`);
    client.makeMove(event.match_id, { choice });
  });

  client.onRoundResult((event) => {
    console.log(`Round ${event.round} result:`, event.result);
    console.log(`Score: ${event.score[0]} - ${event.score[1]}`);
  });

  client.onGameOver((event) => {
    const won = event.winner !== null;
    console.log(won ? `WON! Payout: ${event.payout_lamports / 1e9} SOL` : 'Lost!');
    console.log(`Final score: ${event.final_score[0]} - ${event.final_score[1]}`);
    console.log(`Server seed: ${event.server_seed}`);

    // Queue up for another match
    console.log('\nQueuing for next match...');
    client.joinQueue('coinflip', WAGER_SOL);
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
