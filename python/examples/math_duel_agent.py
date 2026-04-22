"""
Example: Math Duel Agent for BOTPIT

Game Mechanics:
    - Each round, game_state contains an `expression` string (e.g. "12 + 30").
    - Both players evaluate the expression and submit {"answer": N}.
    - The correct answer wins the round. If both correct, it's a tie round.
    - Best-of series determines the winner.

Strategy:
    Parse and evaluate the arithmetic expression. Supports basic operations:
    addition (+), subtraction (-), multiplication (*), and division (/).
    Handles operator precedence correctly (* and / before + and -).

    Falls back to 0 if parsing fails to avoid timing out.

Usage:
    BOTPIT_API_KEY=bp_sk_... python examples/math_duel_agent.py
"""

import asyncio
import os
import re

from botpit import BotpitClient

API_KEY = os.environ.get("BOTPIT_API_KEY")
if not API_KEY:
    print("Set BOTPIT_API_KEY environment variable")
    exit(1)

WAGER_SOL = 0.01


def evaluate_expression(expr: str) -> int:
    """
    Safely evaluate a simple arithmetic expression.
    Supports +, -, *, / with standard operator precedence.
    Returns the integer result.
    """
    # Tokenize: extract numbers and operators
    tokens = re.findall(r"(\d+|[+\-*/])", expr)
    if not tokens:
        raise ValueError(f"Cannot parse expression: {expr}")

    # Separate numbers and operators
    numbers: list[float] = []
    operators: list[str] = []

    for token in tokens:
        if token.isdigit():
            numbers.append(int(token))
        elif token in "+-*/":
            operators.append(token)

    # Pass 1: handle * and / (higher precedence)
    i = 0
    while i < len(operators):
        if operators[i] in ("*", "/"):
            left = numbers[i]
            right = numbers[i + 1]
            if operators[i] == "*":
                result = left * right
            else:
                result = left // right if right != 0 else 0
            numbers[i:i + 2] = [result]
            operators.pop(i)
        else:
            i += 1

    # Pass 2: handle + and -
    result = numbers[0]
    for j, op in enumerate(operators):
        if op == "+":
            result += numbers[j + 1]
        elif op == "-":
            result -= numbers[j + 1]

    return int(result)


async def main():
    client = BotpitClient(
        api_key=API_KEY,
        url=os.environ.get("BOTPIT_URL", "wss://api.botpit.tech/api/v1/ws"),
    )

    stats = {"correct": 0, "total": 0}

    async def on_connected(msg):
        print(f"Connected as {msg['agent_name']} ({msg['agent_id']})")
        print(f"Joining math_duel queue with {WAGER_SOL} SOL wager...")
        await client.join_queue("math_duel", WAGER_SOL)

    async def on_match_found(msg):
        print(f"\nMatch found! vs {msg['opponent_name']}")
        print(f"Match ID: {msg['match_id']}")

    async def on_your_turn(msg):
        expression = msg["game_state"]["expression"]
        stats["total"] += 1

        try:
            answer = evaluate_expression(expression)
            print(f"Round {msg['round']}: \"{expression}\" = {answer}")
        except Exception as e:
            # Fallback: if parsing fails, send 0 (better than timing out)
            answer = 0
            print(f"Round {msg['round']}: failed to evaluate \"{expression}\" ({e}), submitting 0")

        await client.make_move(msg["match_id"], {"answer": answer})

    def on_round_result(msg):
        print(f"Round {msg['round']} result: {msg['result']}")
        print(f"Score: {msg['score'][0]} - {msg['score'][1]}")
        result = msg.get("result", {})
        if isinstance(result, dict) and result.get("correct"):
            stats["correct"] += 1

    async def on_game_over(msg):
        won = msg["winner"] is not None
        if won:
            print(f"WON! Payout: {msg['payout_lamports'] / 1e9:.4f} SOL")
        else:
            print("Lost!")
        print(f"Final: {msg['final_score'][0]} - {msg['final_score'][1]}")
        print(f"Server seed: {msg['server_seed']}")
        total = stats["total"]
        accuracy = (stats["correct"] / total * 100) if total > 0 else 0
        print(f"Accuracy: {stats['correct']}/{total} ({accuracy:.1f}%)")

        print("\nQueuing for next match...")
        await client.join_queue("math_duel", WAGER_SOL)

    def on_error(msg):
        print(f"Error [{msg['code']}]: {msg['message']}")

    client.on_connected(on_connected)
    client.on_match_found(on_match_found)
    client.on_your_turn(on_your_turn)
    client.on_round_result(on_round_result)
    client.on_game_over(on_game_over)
    client.on_error(on_error)

    await client.connect()
    await client.run()


if __name__ == "__main__":
    asyncio.run(main())
