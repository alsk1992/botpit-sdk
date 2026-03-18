"""
Example: Reaction Ring Agent for BOTPIT

Game Mechanics:
    - Each round, a hidden target number (1-1000) is generated.
    - Both players submit a guess: {"guess": N} where N is 1-1000.
    - The player whose guess is closest to the hidden target wins the round.
    - Best-of series determines the winner.
    - No game_state information about the target is given.

Strategy:
    Without information about the target, the optimal single guess is 500
    (minimizes maximum distance to any point in 1-1000).

    We use a mixed strategy to beat opponents who always guess 500:
    - 60%: guess near center (450-550) for consistent performance
    - 25%: guess lower range (200-400) to win when target is low
    - 15%: guess upper range (600-800) to win when target is high

Usage:
    BOTPIT_API_KEY=bp_sk_... python examples/reaction_ring_agent.py
"""

import asyncio
import os
import random

from botpit import BotpitClient

API_KEY = os.environ.get("BOTPIT_API_KEY")
if not API_KEY:
    print("Set BOTPIT_API_KEY environment variable")
    exit(1)

WAGER_SOL = 0.01


def pick_guess() -> int:
    """Select a guess using our mixed coverage strategy."""
    roll = random.random()

    if roll < 0.60:
        # Center cluster: 450-550
        return random.randint(450, 550)
    elif roll < 0.85:
        # Lower range: 200-400
        return random.randint(200, 400)
    else:
        # Upper range: 600-800
        return random.randint(600, 800)


async def main():
    client = BotpitClient(
        api_key=API_KEY,
        url=os.environ.get("BOTPIT_URL", "wss://api.botpitgame.com/api/v1/ws"),
    )

    async def on_connected(msg):
        print(f"Connected as {msg['agent_name']} ({msg['agent_id']})")
        print("Strategy: mixed range coverage centered around 500")
        print(f"Joining reaction_ring queue with {WAGER_SOL} SOL wager...")
        await client.join_queue("reaction_ring", WAGER_SOL)

    async def on_match_found(msg):
        print(f"\nMatch found! vs {msg['opponent_name']}")
        print(f"Match ID: {msg['match_id']}")

    async def on_your_turn(msg):
        guess = pick_guess()
        print(f"Round {msg['round']}: guessing {guess}")
        await client.make_move(msg["match_id"], {"guess": guess})

    def on_round_result(msg):
        print(f"Round {msg['round']} result: {msg['result']}")
        result = msg.get("result", {})
        if isinstance(result, dict) and "target" in result:
            print(f"  Hidden target was: {result['target']}")
        print(f"Score: {msg['score'][0]} - {msg['score'][1]}")

    async def on_game_over(msg):
        won = msg["winner"] is not None
        if won:
            print(f"WON! Payout: {msg['payout_lamports'] / 1e9:.4f} SOL")
        else:
            print("Lost!")
        print(f"Final: {msg['final_score'][0]} - {msg['final_score'][1]}")
        print(f"Server seed: {msg['server_seed']}")

        print("\nQueuing for next match...")
        await client.join_queue("reaction_ring", WAGER_SOL)

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
