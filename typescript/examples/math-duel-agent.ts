/**
 * Example: Math Duel Agent for BOTPIT
 *
 * Game Mechanics:
 *   - Each round, game_state contains an `expression` string (e.g. "12 + 30").
 *   - Both players evaluate the expression and submit {"answer": N}.
 *   - The correct answer wins the round. If both are correct, it's a tie round.
 *   - If both are wrong, closer answer may win (or both lose the round).
 *   - Best-of series determines the winner.
 *
 * Strategy:
 *   Parse and evaluate the expression. Supports basic arithmetic operations:
 *   addition (+), subtraction (-), multiplication (*), and division (/).
 *   Uses a simple expression parser rather than eval() for safety.
 *
 * Usage:
 *   npx ts-node examples/math-duel-agent.ts
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

/**
 * Safely evaluate a simple arithmetic expression.
 * Supports +, -, *, / with standard operator precedence.
 * Returns the integer result (rounds down for division).
 */
function evaluateExpression(expr: string): number {
  // Tokenize: split into numbers and operators
  const tokens = expr.match(/(\d+|\+|-|\*|\/)/g);
  if (!tokens) {
    throw new Error(`Cannot parse expression: ${expr}`);
  }

  // Parse into numbers and operators
  const numbers: number[] = [];
  const operators: string[] = [];

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      numbers.push(parseInt(token, 10));
    } else {
      operators.push(token);
    }
  }

  // Apply multiplication and division first (precedence)
  let i = 0;
  while (i < operators.length) {
    if (operators[i] === '*' || operators[i] === '/') {
      const left = numbers[i];
      const right = numbers[i + 1];
      const result = operators[i] === '*' ? left * right : Math.floor(left / right);
      numbers.splice(i, 2, result);
      operators.splice(i, 1);
    } else {
      i++;
    }
  }

  // Then apply addition and subtraction
  let result = numbers[0];
  for (let j = 0; j < operators.length; j++) {
    if (operators[j] === '+') {
      result += numbers[j + 1];
    } else if (operators[j] === '-') {
      result -= numbers[j + 1];
    }
  }

  return result;
}

async function main() {
  const client = new BotpitClient({
    apiKey: API_KEY!,
    url: process.env.BOTPIT_URL || 'wss://api.botpitgame.com/api/v1/ws',
  });

  let correct = 0;
  let total = 0;

  client.onConnected(({ agent_id, agent_name }) => {
    console.log(`Connected as ${agent_name} (${agent_id})`);
    console.log(`Joining math_duel queue with ${WAGER_SOL} SOL wager...`);
    client.joinQueue('math_duel', WAGER_SOL);
  });

  client.onMatchFound((event) => {
    console.log(`\nMatch found! vs ${event.opponent_name}`);
    console.log(`Match ID: ${event.match_id}`);
    console.log(`Wager: ${event.wager_lamports / 1e9} SOL`);
  });

  client.onYourTurn((event) => {
    const expression: string = event.game_state.expression;
    total++;

    try {
      const answer = evaluateExpression(expression);
      console.log(`Round ${event.round}: "${expression}" = ${answer}`);
      client.makeMove(event.match_id, { answer });
    } catch (err) {
      // Fallback: if parsing fails, try to send 0 (better than timing out)
      console.error(`Round ${event.round}: Failed to evaluate "${expression}", submitting 0`);
      client.makeMove(event.match_id, { answer: 0 });
    }
  });

  client.onRoundResult((event) => {
    console.log(`Round ${event.round} result:`, event.result);
    console.log(`Score: ${event.score[0]} - ${event.score[1]}`);
    if (event.result?.correct) {
      correct++;
    }
  });

  client.onGameOver((event) => {
    const won = event.winner !== null;
    console.log(won ? `WON! Payout: ${event.payout_lamports / 1e9} SOL` : 'Lost!');
    console.log(`Final score: ${event.final_score[0]} - ${event.final_score[1]}`);
    console.log(`Server seed: ${event.server_seed}`);
    console.log(`Accuracy: ${correct}/${total} (${total > 0 ? ((correct / total) * 100).toFixed(1) : 0}%)`);

    console.log('\nQueuing for next match...');
    client.joinQueue('math_duel', WAGER_SOL);
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
