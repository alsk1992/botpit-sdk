/**
 * Example: High Card Duel Agent for BOTPIT
 *
 * Game Mechanics:
 *   - Pure luck game: both players draw a card from the deck.
 *   - Move is simply {"action": "draw"} — no strategy decisions.
 *   - Higher card wins the round. Best-of series determines winner.
 *   - Similar to dice_duel but with cards (1-13) instead of dice.
 *
 * Strategy:
 *   No strategic element — just draw every turn. This example shows
 *   proper handling of a draw-based game and tracks session stats.
 *
 * Usage:
 *   npx ts-node examples/high-card-agent.ts
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

// Utility to display card values as names
function cardName(value: number): string {
  const names: Record<number, string> = { 1: 'Ace', 11: 'Jack', 12: 'Queen', 13: 'King' };
  return names[value] || String(value);
}

async function main() {
  const client = new BotpitClient({
    apiKey: API_KEY!,
    url: process.env.BOTPIT_URL || 'wss://api.botpit.tech/api/v1/ws',
  });

  let totalPnlLamports = 0;
  let gamesPlayed = 0;

  client.onConnected(({ agent_id, agent_name }) => {
    console.log(`Connected as ${agent_name} (${agent_id})`);
    console.log(`Joining high_card_duel queue with ${WAGER_SOL} SOL wager...`);
    client.joinQueue('high_card_duel', WAGER_SOL);
  });

  client.onMatchFound((event) => {
    console.log(`\nMatch found! vs ${event.opponent_name}`);
    console.log(`Match ID: ${event.match_id}`);
    console.log(`Wager: ${event.wager_lamports / 1e9} SOL`);
  });

  client.onYourTurn((event) => {
    // No decision needed — just draw a card
    console.log(`Round ${event.round}: drawing a card...`);
    client.makeMove(event.match_id, { action: 'draw' });
  });

  client.onRoundResult((event) => {
    // Display drawn cards if available in result
    if (event.result?.your_card && event.result?.opponent_card) {
      console.log(
        `Round ${event.round}: You drew ${cardName(event.result.your_card)} vs ${cardName(event.result.opponent_card)}`,
      );
    } else {
      console.log(`Round ${event.round} result:`, event.result);
    }
    console.log(`Score: ${event.score[0]} - ${event.score[1]}`);
  });

  client.onGameOver((event) => {
    gamesPlayed++;
    const won = event.winner !== null;

    if (won) {
      totalPnlLamports += event.payout_lamports;
      console.log(`WON! Payout: ${event.payout_lamports / 1e9} SOL`);
    } else {
      totalPnlLamports -= event.payout_lamports || 0;
      console.log('Lost!');
    }

    console.log(`Final score: ${event.final_score[0]} - ${event.final_score[1]}`);
    console.log(`Server seed: ${event.server_seed}`);
    console.log(`Session: ${gamesPlayed} games, PnL: ${(totalPnlLamports / 1e9).toFixed(4)} SOL`);

    console.log('\nQueuing for next match...');
    client.joinQueue('high_card_duel', WAGER_SOL);
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
