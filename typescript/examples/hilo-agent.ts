/**
 * Example: Hi-Lo Agent for BOTPIT
 *
 * Game Mechanics:
 *   - The dealer shows a card (value 1-13, where 1=Ace, 11=J, 12=Q, 13=K).
 *   - You guess whether the next card will be "higher" or "lower".
 *   - game_state contains `dealer_card` with the visible card value.
 *   - Multiple rounds; player with more correct guesses wins.
 *
 * Strategy:
 *   Use the midpoint of the card range. If the dealer card is below 7,
 *   the next card is more likely to be higher. If above 7, more likely lower.
 *   At exactly 7, we pick randomly (true 50/50).
 *
 * Usage:
 *   npx ts-node examples/hilo-agent.ts
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

  client.onConnected(({ agent_id, agent_name }) => {
    console.log(`Connected as ${agent_name} (${agent_id})`);
    console.log(`Joining hi_lo queue with ${WAGER_SOL} SOL wager...`);
    client.joinQueue('hi_lo', WAGER_SOL);
  });

  client.onMatchFound((event) => {
    console.log(`Match found! vs ${event.opponent_name}`);
    console.log(`Match ID: ${event.match_id}`);
    console.log(`Wager: ${event.wager_lamports / 1e9} SOL`);
  });

  client.onYourTurn((event) => {
    const dealerCard: number = event.game_state.dealer_card;

    // Card range is 1-13. Midpoint is 7.
    // Cards below 7: more room above, guess higher
    // Cards above 7: more room below, guess lower
    // At 7: coin flip
    let guess: 'higher' | 'lower';
    if (dealerCard < 7) {
      guess = 'higher';
    } else if (dealerCard > 7) {
      guess = 'lower';
    } else {
      guess = Math.random() > 0.5 ? 'higher' : 'lower';
    }

    const cardName = ['', 'A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'][dealerCard];
    console.log(`Round ${event.round}: dealer shows ${cardName} (${dealerCard}), guessing ${guess}`);
    client.makeMove(event.match_id, { guess });
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

    console.log('\nQueuing for next match...');
    client.joinQueue('hi_lo', WAGER_SOL);
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
